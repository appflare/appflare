import { type ArtifactManifest, hasFixedWorkerName, type IndexApp } from "@appflare/schema";
import { and, eq, ne, or } from "drizzle-orm";
import { ulid } from "ulidx";
import { requirementLabel } from "../catalog/requirements";
import { createDb } from "../db/client";
import { installs, jobs } from "../db/schema";
import type { InstallJobParams } from "../jobs/install";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import {
  activeSelfUpdateJob,
  NO_ACTIVE_SELF_UPDATE_SQL,
  refuseDuringSelfUpdate,
  selfUpdateBusyMessage,
} from "../jobs/self-update/guard";
import type { StartInstallInput } from "./install-input";

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
  manifest: ArtifactManifest;
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
}

/**
 * Checks the form against the signed catalog manifest. Names the manifest does
 * not declare are rejected, not dropped. Every secret needs a value: the form
 * prefills `generate: true` secrets, so an empty one means a broken client.
 */
export function resolveInstallInput(
  manifest: ArtifactManifest,
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
  const vars: Record<string, string> = {};
  for (const v of catalog.vars) {
    const value = (input.vars[v.name] ?? "").trim();
    if (value.length > 0) vars[v.name] = value;
    else if (v.required && v.default === undefined) {
      throw new StartInstallError(`${v.label} (${v.name}) is required.`);
    }
  }
  if (catalog.install.emailRouting !== undefined && input.emailRouting === undefined) {
    throw new StartInstallError(
      `${catalog.name} receives email. Choose the zone whose email it should receive.`,
    );
  }
  if (catalog.install.emailRouting === undefined && input.emailRouting !== undefined) {
    throw new StartInstallError(`${catalog.name} does not receive email; it takes no zone.`);
  }
  return {
    secrets,
    vars,
    ...(input.emailRouting === undefined ? {} : { emailRouting: input.emailRouting }),
  };
}

export async function startInstallCore(
  deps: StartInstallDeps,
  input: StartInstallInput,
): Promise<StartInstallResult> {
  await refuseDuringSelfUpdate(deps.db, deps.workflows, (m) => new StartInstallError(m));
  const { app, manifest } = await deps.loadApp(input.slug);
  const resolved = resolveInstallInput(manifest, input);
  const fixed = hasFixedWorkerName(manifest.catalog.install);
  const fixedName = manifest.catalog.install.workerName;
  if (fixed && input.workerName !== fixedName) {
    throw new StartInstallError(
      `${manifest.catalog.name} only works as the Worker "${fixedName}"; its Worker name cannot be changed.`,
    );
  }
  const instanceName = input.instanceName ?? input.workerName;
  if (deps.listAccountWorkers !== undefined) {
    let existing: string[] = [];
    try {
      existing = await deps.listAccountWorkers();
    } catch {
      // The install job checks the account again before creating anything.
    }
    if (existing.includes(input.workerName)) {
      throw new StartInstallError(
        `A Worker named "${input.workerName}" already exists in this account. Appflare does not adopt existing Workers; choose another name.`,
      );
    }
  }
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? (() => ulid());
  const installId = newId();
  const jobId = newId();
  const db = createDb(deps.db);

  // One D1 batch (a transaction), so no partial state is ever left behind:
  // 1. A `failed` install of the same Worker name (or, for an app with a fixed
  //    Worker name, of the same app) that holds no live resources is retired to
  //    `uninstalled`, so the name can be used again. A failed install that
  //    still owns resources keeps blocking (uninstall it first).
  // 2. The new install claims the Worker name only if no other active install
  //    uses it (nor the app, when its Worker name is fixed), so two concurrent
  //    starts cannot both win.
  // 3. The job row is inserted only if the install row was.
  const inputJson = JSON.stringify({
    slug: app.slug,
    version: app.version,
    workerName: input.workerName,
    instanceName,
    secrets: Object.keys(resolved.secrets),
    vars: resolved.vars,
    paidConfirmed: input.paidConfirmed,
    requirementsConfirmed: input.requirementsConfirmed,
    ...(resolved.emailRouting === undefined ? {} : { emailRouting: resolved.emailRouting }),
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
      .bind(input.workerName, app.slug, now.getTime(), fixed ? 1 : 0),
    deps.db
      .prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, artifact_digest, pin_sha, status, config_json, installed_at, updated_at)
         SELECT ?1, ?2, ?3, ?10, ?4, ?5, ?6, ?7, 'installing', ?8, ?9, ?9
         WHERE NOT EXISTS (
           SELECT 1 FROM installs
           WHERE status != 'uninstalled' AND (worker_name = ?3 OR (?11 = 1 AND app_slug = ?2))
         )
           AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
      )
      .bind(
        installId,
        app.slug,
        input.workerName,
        app.version,
        app.artifacts.zip,
        app.digest,
        manifest.source.sha,
        JSON.stringify(resolved.vars),
        now.getTime(),
        instanceName,
        fixed ? 1 : 0,
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
            ? or(eq(installs.worker_name, input.workerName), eq(installs.app_slug, app.slug))
            : eq(installs.worker_name, input.workerName),
        ),
      )
      .limit(1);
    if (clash?.status === "failed") {
      throw new StartInstallError(
        `A failed install of the Worker "${clash.worker}" still owns resources in this account. Uninstall it first.`,
      );
    }
    throw new StartInstallError(
      clash !== undefined && clash.worker !== input.workerName
        ? `${manifest.catalog.name} is already installed as "${clash.worker}". It only works under one Worker name, so it installs once per account.`
        : `Another install already uses the Worker name "${input.workerName}".`,
    );
  }

  const params: InstallJobParams = {
    kind: "install",
    jobId,
    installId,
    slug: app.slug,
    version: app.version,
    workerName: input.workerName,
    artifacts: app.artifacts,
    digest: app.digest,
    secrets: resolved.secrets,
    vars: resolved.vars,
    paidConfirmed: input.paidConfirmed,
    requirementsConfirmed: input.requirementsConfirmed,
    ...(resolved.emailRouting === undefined ? {} : { emailRouting: resolved.emailRouting }),
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
