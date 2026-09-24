import {
  type ArtifactManifest,
  type CatalogManifest,
  hasFixedWorkerName,
  type IndexApp,
  indexAppArtifact,
} from "@appflare/schema";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { ulid } from "ulidx";
import { readAccountPlan, writeAccountPlan } from "../account/plan.server";
import { requirementLabel } from "../catalog/requirements";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { checkExternalHostname } from "../gateway/gateway";
import { isGatewayReady, readGateway } from "../gateway/gateway.server";
import type { InstallJobParams } from "../jobs/install";
import { sandboxBuildOf } from "../jobs/install/artifact-source";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import {
  expectedWorkers,
  installerRunId,
  selfDeployingInputOf,
} from "../jobs/self-deploying/phases";
import {
  activeSelfUpdateJob,
  NO_ACTIVE_SELF_UPDATE_SQL,
  refuseDuringSelfUpdate,
  selfUpdateBusyMessage,
} from "../jobs/self-update/guard";
import type { InstallDomainInput, StartInstallInput } from "./install-input";
import { installVarFields, missingRequiredVar, varValueProblem } from "./install-vars";
import { ADDRESS_KINDS } from "./resource-kinds";

/**
 * Starting an install: validate the form against the signed catalog manifest,
 * claim the Worker name, record `installs` + `jobs`, then create the
 * `JobWorkflow` instance. An app may be installed several times under
 * different Worker names; the Worker name is the unique key of an active
 * install. Apps whose catalog manifest sets `install.fixedWorkerName` must use
 * that name, so they install once. Secret VALUES go only into the Workflow
 * params, which Workflows stores encrypted at rest; `jobs.input_json` keeps
 * their names.
 */

export class StartInstallError extends Error {
  override name = "StartInstallError";
}

export interface CatalogEntry {
  app: IndexApp;
  /**
   * The catalog manifest and pin: from the signed artifact manifest, or for a
   * sandbox tier app (built only once the install runs) from its verified
   * catalog manifest (whose wrangler config bindings are not known yet).
   */
  manifest: EntryManifest;
}

/** What starting an install needs of a manifest. */
export type EntryManifest = Pick<ArtifactManifest, "catalog" | "source"> & {
  worker: Pick<ArtifactManifest["worker"], "bindings">;
};

/** A sandbox tier app's catalog entry, before any artifact of it exists. */
export function catalogOnlyManifest(catalog: CatalogManifest): EntryManifest {
  return {
    catalog,
    source: { repo: catalog.repo, sha: catalog.source.sha, ref: catalog.source.ref },
    worker: { bindings: [] },
  };
}

export interface StartInstallDeps {
  db: D1Database;
  /** The Workflow binding, to settle a self-update whose instance died before refusing to start. */
  workflows?: WorkflowLookup;
  /** The index entry and its verified manifest; throws `StartInstallError` when unavailable. */
  loadApp(slug: string): Promise<CatalogEntry>;
  /** Creates the Workflow instance (`env.JOBS.create`). */
  createJob(id: string, params: InstallJobParams): Promise<{ id: string }>;
  /**
   * Worker names already in the account, when they can be listed. Best effort:
   * when absent or failing, the install job's own check refuses the name later.
   */
  listAccountWorkers?(): Promise<string[]>;
  /** Whether this manager has its `SANDBOX` binding; sandbox tier apps need it. */
  sandboxConnected?: boolean;
  now?: () => Date;
  newId?: () => string;
}

export interface StartInstallResult {
  jobId: string;
  installId: string;
}

export interface ResolvedInstallInput {
  secrets: Record<string, string>;
  vars: Record<string, string>;
  /** The zone for an app that receives email; undefined for any other app. */
  emailRouting?: { zoneId: string };
  /** The custom or external domain the install job adds; undefined for workers.dev only. */
  domain?: InstallDomainInput;
}

/**
 * Checks the form against the signed catalog manifest. Names the manifest does
 * not declare are rejected, not dropped. Every secret needs a value: the form
 * prefills `generate: true` secrets, so an empty one means a broken client.
 */
export function resolveInstallInput(
  manifest: Pick<EntryManifest, "catalog" | "worker">,
  input: StartInstallInput,
): ResolvedInstallInput {
  const catalog = manifest.catalog;
  if (catalog.plan === "paid" && !input.paidConfirmed) {
    throw new StartInstallError(
      `${catalog.name} needs Workers Paid. Confirm that this account is on Workers Paid.`,
    );
  }
  if (catalog.requires.length > 0 && !input.requirementsConfirmed) {
    throw new StartInstallError(
      `${catalog.name} needs: ${catalog.requires.map(requirementLabel).join(", ")}. Confirm that this account meets these requirements.`,
    );
  }
  const declaredSecrets = new Set(catalog.secrets.map((s) => s.name));
  const declaredVars = new Set(catalog.vars.map((v) => v.name));
  const unknown = [
    ...Object.keys(input.secrets).filter((name) => !declaredSecrets.has(name)),
    ...Object.keys(input.vars).filter((name) => !declaredVars.has(name)),
  ];
  if (unknown.length > 0) {
    throw new StartInstallError(`${catalog.name} does not take: ${unknown.join(", ")}.`);
  }
  const secrets: Record<string, string> = {};
  for (const secret of catalog.secrets) {
    const value = input.secrets[secret.name] ?? "";
    if (value.length === 0) {
      throw new StartInstallError(`${secret.label} (${secret.name}) is required.`);
    }
    secrets[secret.name] = value;
  }
  // Values are stored as entered, placeholders included, and filled in by
  // each install and update job.
  const vars: Record<string, string> = {};
  for (const field of installVarFields(manifest)) {
    const value = (input.vars[field.name] ?? "").trim();
    if (missingRequiredVar(field, value)) {
      throw new StartInstallError(`${field.label} (${field.name}) is required.`);
    }
    const problem = varValueProblem(field, value);
    if (problem !== null) throw new StartInstallError(problem);
    if (value.length > 0) vars[field.name] = value;
  }
  if (catalog.install.emailRouting !== undefined && input.emailRouting === undefined) {
    throw new StartInstallError(
      `${catalog.name} receives email. Choose the zone whose email it should receive.`,
    );
  }
  if (catalog.install.emailRouting === undefined && input.emailRouting !== undefined) {
    throw new StartInstallError(`${catalog.name} does not receive email; it takes no zone.`);
  }
  let domain: InstallDomainInput | undefined;
  if (input.domain?.kind === "custom") {
    // Lower case and Punycode, as Cloudflare and the duplicate checks see it.
    const typed = input.domain.hostname.trim().toLowerCase().replace(/\.$/, "");
    let hostname: string;
    try {
      hostname = new URL(`https://${typed}/`).hostname;
    } catch {
      throw new StartInstallError(`"${input.domain.hostname.trim()}" is not a valid hostname.`);
    }
    domain = { ...input.domain, hostname };
  } else if (input.domain?.kind === "external") {
    // The gateway and the account's zones are checked again by the job.
    const checked = checkExternalHostname(input.domain.hostname, { gateway: "", account: [] });
    if (!checked.ok) throw new StartInstallError(checked.error);
    domain = { ...input.domain, hostname: checked.hostname };
  }
  return {
    secrets,
    vars,
    ...(input.emailRouting === undefined ? {} : { emailRouting: input.emailRouting }),
    ...(domain === undefined ? {} : { domain }),
  };
}

export async function startInstallCore(
  deps: StartInstallDeps,
  input: StartInstallInput,
): Promise<StartInstallResult> {
  await refuseDuringSelfUpdate(deps.db, deps.workflows, (m) => new StartInstallError(m));
  const { app, manifest } = await deps.loadApp(input.slug);
  // An account recorded as on Workers Paid needs no confirmation per install.
  const accountPlan = await readAccountPlan(createDb(deps.db));
  const paidConfirmed = input.paidConfirmed || accountPlan === "paid";
  const resolved = resolveInstallInput(manifest, { ...input, paidConfirmed });
  // Where the artifact comes from: the signed release, or a build of the pin
  // in the account's sandbox Worker, which the admin confirms paying for.
  // A self-deploying app has no artifact at all: its own installer runs in
  // the sandbox Worker with a token the admin creates for the app.
  const release = indexAppArtifact(app);
  const build = app.tier === "sandbox" ? (app.build ?? null) : null;
  const installer = app.tier === "self-deploying" ? (app.build ?? null) : null;
  if (build === null && installer === null && (app.tier !== "artifact" || release === null)) {
    throw new StartInstallError(`Appflare cannot install ${app.tier} tier apps yet.`);
  }
  const inSandbox = build !== null || installer !== null;
  if (inSandbox && deps.sandboxConnected !== true) {
    throw new StartInstallError(
      `${manifest.catalog.name} ${installer !== null ? "is deployed by its own installer in" : "is built in"} this account's sandbox Worker, and Appflare is not connected to one. Set up sandbox builds in Settings first.`,
    );
  }
  if (inSandbox && input.buildConfirmed !== true) {
    throw new StartInstallError(
      installer !== null
        ? `${manifest.catalog.name}'s installer runs in this account's sandbox Worker on Workers Paid. Confirm its cost.`
        : `${manifest.catalog.name} is built in this account's sandbox Worker on Workers Paid. Confirm the build's cost.`,
    );
  }
  const appToken = input.appToken?.trim() ?? "";
  if (installer !== null && appToken.length === 0) {
    throw new StartInstallError(
      `${manifest.catalog.name} deploys itself with its own Cloudflare API token. Create one with the permissions listed and enter it.`,
    );
  }
  if (installer === null && input.appToken !== undefined) {
    throw new StartInstallError(`${manifest.catalog.name} takes no app token.`);
  }
  if (installer !== null && resolved.domain !== undefined) {
    throw new StartInstallError(
      `${manifest.catalog.name}'s own installer decides where its Workers answer; add a domain once it is installed.`,
    );
  }
  if (resolved.domain !== undefined) {
    const [held] = await createDb(deps.db)
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          inArray(resources.kind, [...ADDRESS_KINDS]),
          eq(resources.name, resolved.domain.hostname),
          isNull(resources.deleted_at),
        ),
      )
      .limit(1);
    if (held !== undefined) {
      throw new StartInstallError(
        `${resolved.domain.hostname} is already a domain of another app. Remove it there first, or install without it.`,
      );
    }
  }
  if (
    resolved.domain?.kind === "external" &&
    !isGatewayReady(await readGateway(createDb(deps.db)))
  ) {
    throw new StartInstallError(
      "External domains need the gateway. Set it up in Settings, Domains, or install without a domain.",
    );
  }
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? (() => ulid());
  const db = createDb(deps.db);
  // A self-deploying app needs its install id now, for its Workers' names;
  // other apps get their ids once the checks below passed.
  const earlyIds = installer === null ? null : ([newId(), newId()] as const);
  // A self-deploying app's Workers are named by its installer, after the
  // install's stage; the first one serves the app and is the install's name.
  const installerWorkers = earlyIds === null ? [] : expectedWorkers(manifest.catalog, earlyIds[0]);
  const workerName = installerWorkers[0] ?? input.workerName;
  const fixed = installer === null && hasFixedWorkerName(manifest.catalog.install);
  const fixedName = manifest.catalog.install.workerName;
  if (fixed && workerName !== fixedName) {
    throw new StartInstallError(
      `${manifest.catalog.name} only works as the Worker "${fixedName}"; its Worker name cannot be changed.`,
    );
  }
  const instanceName =
    input.instanceName ?? (installer !== null ? manifest.catalog.name : workerName);
  if (deps.listAccountWorkers !== undefined) {
    let existing: string[] = [];
    try {
      existing = await deps.listAccountWorkers();
    } catch {
      // The install job checks the account again before creating anything.
    }
    const taken = (installer !== null ? installerWorkers : [workerName]).find((w) =>
      existing.includes(w),
    );
    if (taken !== undefined) {
      throw new StartInstallError(
        `A Worker named "${taken}" already exists in this account. Appflare does not adopt existing Workers; choose another name.`,
      );
    }
  }

  // One D1 batch (a transaction), so no partial state is ever left behind:
  // 1. A `failed` install of the same Worker name (or, for an app with a fixed
  //    Worker name, of the same app) that holds no live resources is retired to
  //    `uninstalled`, so the name can be used again. A failed install that
  //    still owns resources keeps blocking (uninstall it first).
  // 2. The new install claims the Worker name only if no other active install
  //    uses it (nor the app, when its Worker name is fixed), so two concurrent
  //    starts cannot both win.
  // 3. The job row is inserted only if the install row was.
  const [installId, jobId] = earlyIds ?? [newId(), newId()];
  const inputJson = JSON.stringify({
    slug: app.slug,
    version: app.version,
    workerName,
    instanceName,
    secrets: Object.keys(resolved.secrets),
    vars: resolved.vars,
    paidConfirmed,
    requirementsConfirmed: input.requirementsConfirmed,
    ...(resolved.emailRouting === undefined ? {} : { emailRouting: resolved.emailRouting }),
    ...(resolved.domain === undefined ? {} : { domain: resolved.domain }),
    ...(build === null ? {} : { sandboxBuild: true, buildConfirmed: true }),
    // Names only: the app token lives in the Workflow params alone.
    ...(installer === null
      ? {}
      : {
          selfDeploying: true,
          buildConfirmed: true,
          sandboxRun: installerRunId("deploy", app.version),
        }),
  });
  const [, claimed] = await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE installs SET status = 'uninstalled', uninstalled_at = ?3, updated_at = ?3
         WHERE status = 'failed' AND (worker_name = ?1 OR (?4 = 1 AND app_slug = ?2))
           AND NOT EXISTS (
             SELECT 1 FROM resources r WHERE r.install_id = installs.id AND r.deleted_at IS NULL
           )`,
      )
      .bind(workerName, app.slug, now.getTime(), fixed ? 1 : 0),
    deps.db
      .prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, artifact_digest, pin_sha, status, config_json, installed_at, updated_at,
           build_kind)
         SELECT ?1, ?2, ?3, ?10, ?4, ?5, ?6, ?7, 'installing', ?8, ?9, ?9, ?12
         WHERE NOT EXISTS (
           SELECT 1 FROM installs
           WHERE status != 'uninstalled' AND (worker_name = ?3 OR (?11 = 1 AND app_slug = ?2))
         )
           AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
      )
      .bind(
        installId,
        app.slug,
        workerName,
        app.version,
        // A sandbox build's artifact exists only once the job built it; until
        // then the install points at the catalog manifest it is built from. A
        // self-deploying app never has one: it points at its catalog manifest.
        release?.artifacts.zip ?? build?.manifest ?? installer?.manifest ?? "",
        release?.digest ?? installer?.manifestDigest ?? null,
        manifest.source.sha,
        JSON.stringify(resolved.vars),
        now.getTime(),
        instanceName,
        fixed ? 1 : 0,
        // Known from the start, so an uninstall of a failed install runs the
        // app's destroy command instead of deleting anything itself.
        installer === null ? "artifact" : "self-deploying",
      ),
    deps.db
      .prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json)
         SELECT ?1, ?2, 'install', 'queued', ?3
         WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2)
           AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
      )
      .bind(jobId, installId, inputJson),
  ]);
  if (claimed?.meta.changes !== 1) {
    // A self-update that started after the check above wins the claim.
    const selfUpdate = await activeSelfUpdateJob(deps.db);
    if (selfUpdate !== null) throw new StartInstallError(selfUpdateBusyMessage(selfUpdate));
    const [clash] = await db
      .select({ status: installs.status, worker: installs.worker_name })
      .from(installs)
      .where(
        and(
          ne(installs.status, "uninstalled"),
          fixed
            ? or(eq(installs.worker_name, workerName), eq(installs.app_slug, app.slug))
            : eq(installs.worker_name, workerName),
        ),
      )
      .limit(1);
    if (clash?.status === "failed") {
      throw new StartInstallError(
        `A failed install of the Worker "${clash.worker}" still owns resources in this account. Uninstall it first.`,
      );
    }
    throw new StartInstallError(
      clash !== undefined && clash.worker !== workerName
        ? `${manifest.catalog.name} is already installed as "${clash.worker}". It only works under one Worker name, so it installs once per account.`
        : `Another install already uses the Worker name "${workerName}".`,
    );
  }
  // "Remember this for the account" beside a ticked Workers Paid confirmation,
  // recorded only once the install and its job exist: a refused start changes
  // nothing.
  if (input.rememberPaidPlan === true && input.paidConfirmed && accountPlan !== "paid") {
    await writeAccountPlan(db, "paid");
  }

  const params: InstallJobParams = {
    kind: "install",
    jobId,
    installId,
    slug: app.slug,
    version: app.version,
    workerName,
    ...(installer !== null
      ? { selfDeploying: selfDeployingInputOf(installer, true, appToken) }
      : build !== null
        ? { build: sandboxBuildOf(build, true) }
        : release !== null
          ? { artifacts: release.artifacts, digest: release.digest }
          : {}),
    secrets: resolved.secrets,
    vars: resolved.vars,
    paidConfirmed,
    requirementsConfirmed: input.requirementsConfirmed,
    ...(resolved.emailRouting === undefined ? {} : { emailRouting: resolved.emailRouting }),
    ...(resolved.domain === undefined ? {} : { domain: resolved.domain }),
  };
  let instanceId: string;
  try {
    instanceId = (await deps.createJob(jobId, params)).id;
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await db
      .update(jobs)
      .set({ status: "failed", error: reason, finished_at: now })
      .where(eq(jobs.id, jobId));
    await db
      .update(installs)
      .set({ status: "failed", updated_at: now })
      .where(eq(installs.id, installId));
    throw new StartInstallError(reason);
  }
  await db.update(jobs).set({ workflow_instance_id: instanceId }).where(eq(jobs.id, jobId));
  return { jobId, installId };
}
