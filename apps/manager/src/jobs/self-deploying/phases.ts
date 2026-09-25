import {
  appSecretSecretName,
  appTokenSecretName,
  buildCommandArgv,
  type CatalogManifest,
  catalogManifestSchema,
  gitShaSchema,
  type IndexBuild,
  type PlaceholderValues,
  renderPlaceholders,
  renderWorkerTemplate,
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_WORKER_NAME,
  SELF_DEPLOYING_TOOLS,
  type SelfManagedDeployResult,
  type SelfManagedDestroyResult,
  type SelfManagedResource,
  type SelfManagedRunRequest,
  type SelfManagedStatus,
  sandboxInstanceTypeSchema,
  selfDeployingStage,
  selfDeployingStageArg,
  selfManagedRunRequestSchema,
  selfManagedStatusRequestSchema,
  sha256Schema,
} from "@appflare/schema";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../../db/client";
import { job_logs, resources } from "../../db/schema";
import { isVarOption } from "../../installs/install-vars";
import {
  parseSelfManagedOutcome,
  parseSelfManagedStatus,
  runsSelfDeploying,
  type SandboxBuildsBinding,
  SandboxProtocolError,
  sandboxBinding,
  sandboxInfo,
} from "../../sandbox/binding";
import { activeSandboxJob, sandboxBusyMessage } from "../../sandbox/busy";
import { UPDATE_SANDBOX_HINT } from "../../sandbox/connect-copy";
import { verifyCatalogManifest } from "../../sandbox/verify";
import { fetchWhole } from "../install/artifact";
import { resourceId } from "../install/phases";
import type { JobEnv, StepConfig } from "../run-job";
import { isNotFound, JobError, type JobSteps } from "../steps";

/**
 * Step sequences of the self-deploying tier, shared by its install, update
 * and uninstall: the app ships its own installer, which the account's sandbox
 * Worker runs at the pinned commit with the app's own Cloudflare token.
 *
 * Custody of that token: the manager stores it (and each of the app's secret
 * values) as a secret on the sandbox Worker through the Cloudflare API
 * (`PUT /workers/scripts/appflare-sandbox/secrets`), with the manager's own
 * token, which never leaves the manager. The value travels only in the job's
 * Workflow params, which Workflows keeps encrypted at rest, and in that one
 * API call; it is never written to D1, never logged, and never sent over the
 * `SANDBOX` binding: requests name the install, and the sandbox Worker reads
 * the value from its own environment. Uninstalling deletes those secrets.
 *
 * Everything the installer creates is recorded with `managed_by: "app"`:
 * Appflare shows it but never deletes it itself; the uninstall runs the
 * installer's destroy command instead.
 */

/** A self-deploying install or update as the job payload carries it (from the index's `build`). */
export const selfDeployingJobInput = z.object({
  pin: gitShaSchema,
  manifestUrl: z.url(),
  manifestDigest: sha256Schema,
  instanceType: sandboxInstanceTypeSchema.optional(),
  /** The admin confirmed the cost of running the installer in the sandbox Worker. */
  costConfirmed: z.boolean(),
  /**
   * The app's own Cloudflare API token, which the job stores on the sandbox
   * Worker. Required to install; on an update, a replacement. Lives only
   * here: Workflows stores params encrypted at rest, and `jobs.input_json`
   * never has it.
   */
  appToken: z.string().min(1).max(1024).optional(),
});
export type SelfDeployingJobInput = z.infer<typeof selfDeployingJobInput>;

/** The payload's self-deploying block, from the index entry's `build`. */
export function selfDeployingInputOf(
  build: IndexBuild,
  costConfirmed: boolean,
  appToken?: string,
): SelfDeployingJobInput {
  return {
    pin: build.pin,
    manifestUrl: build.manifest,
    manifestDigest: build.manifestDigest,
    ...(build.instanceType === undefined ? {} : { instanceType: build.instanceType }),
    costConfirmed,
    ...(appToken === undefined ? {} : { appToken }),
  };
}

/**
 * The installer runs as one RPC call for the whole run: checkout, install,
 * build and the installer take at most 65 minutes on the sandbox Worker's
 * own limits. A run is retried once, only after a failure the sandbox Worker
 * marks retryable (the container could not start or went away, or the
 * account could not be read back), a lost connection, or this step's
 * timeout: installers converge on what they already deployed, so a second
 * run finishes the first. A failing command ends the job at once.
 */
export const INSTALLER_RUN_STEP: StepConfig = {
  retries: { limit: 1, delay: "30 seconds", backoff: "constant" },
  timeout: "75 minutes",
};

/**
 * A secret stored on the sandbox Worker takes effect with the Worker's next
 * version, which Cloudflare deploys within seconds; the check waits up to
 * about half a minute for it.
 */
export const CREDENTIALS_VISIBLE_STEP: StepConfig = {
  retries: { limit: 6, delay: "5 seconds", backoff: "constant" },
};

/** Lines of the installer's output copied into the job log when the run ends. */
export const INSTALLER_LOG_LINES = 40;

function tailLines(text: string, lines: number): string[] {
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  while (all.length > 0 && all.at(-1)?.trim() === "") all.pop();
  return all.slice(-lines);
}

/** The installer block of a self-deploying catalog manifest; throws when there is none. */
export function installerOf(catalog: CatalogManifest) {
  const block = catalog.install.selfDeploying;
  if (catalog.install.tier !== "self-deploying" || block === undefined) {
    throw new JobError(`${catalog.slug} is not a self-deploying tier app`);
  }
  return block;
}

/** The Workers an install's installer creates, stage filled in; the first serves the app. */
export function expectedWorkers(catalog: CatalogManifest, installId: string): string[] {
  const stage = selfDeployingStage(installId);
  return installerOf(catalog).workers.map((template) => renderWorkerTemplate(template, stage));
}

/** The run id that names a run's log: `deploy-<version>` or `destroy-<version>`. */
export function installerRunId(action: "deploy" | "destroy", version: string): string {
  return `${action}-${version.replace(/[^0-9A-Za-z.+_-]/g, "_").replace(/\.\.+/g, ".")}`.slice(
    0,
    128,
  );
}

/**
 * The run id of a settings change's installer run: one per job, so it never
 * writes over the log of the deploy that installed or updated the version.
 */
export function settingsRunId(jobId: string): string {
  return `settings-${jobId.replace(/[^0-9A-Za-z_-]/g, "_")}`.slice(0, 128);
}

/**
 * The app's settings as the installer gets them: each catalog var's default
 * (placeholders filled in for the Worker that serves the app), replaced by
 * what the admin entered. Empty values are left out, and so is a stored
 * choice this version no longer offers (the default applies instead).
 */
export function installerVars(
  catalog: CatalogManifest,
  entered: Readonly<Record<string, string>>,
  placeholders: PlaceholderValues,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of catalog.vars) {
    const stored = entered[v.name];
    const raw = (stored !== undefined && isVarOption(v, stored) ? stored : undefined) ?? v.default;
    if (raw === undefined) continue;
    const value = renderPlaceholders(raw, placeholders).trim();
    if (value.length > 0) out[v.name] = value;
  }
  return out;
}

/** The request of one installer run; throws `JobError` when the entry cannot make one. */
export function installerRequest(input: {
  action: "deploy" | "destroy";
  installId: string;
  accountId: string;
  catalog: CatalogManifest;
  pin: string;
  version: string;
  vars: Record<string, string>;
  instanceType?: SelfManagedRunRequest["instanceType"];
  /** The run's own id; defaults to the action and version (`installerRunId`). */
  runId?: string;
}): SelfManagedRunRequest {
  const { catalog } = input;
  const block = installerOf(catalog);
  const tool = SELF_DEPLOYING_TOOLS[block.tool];
  const parsed = selfManagedRunRequestSchema.safeParse({
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: input.installId,
    runId: input.runId ?? installerRunId(input.action, input.version),
    accountId: input.accountId,
    tool: block.tool,
    repo: catalog.repo,
    sha: input.pin,
    ref: catalog.source.ref,
    packageManager: catalog.install.packageManager,
    ...(catalog.install.buildCommand === undefined
      ? {}
      : { buildCommand: buildCommandArgv(catalog.install.buildCommand) }),
    command: input.action === "deploy" ? block.deployCommand : block.destroyCommand,
    stage: selfDeployingStage(input.installId),
    stageArg: selfDeployingStageArg(block),
    tokenEnv: [...tool.tokenEnv],
    accountIdEnv: [...tool.accountIdEnv],
    vars: input.vars,
    secretNames: catalog.secrets.map((s) => s.name),
    expectedWorkers: expectedWorkers(catalog, input.installId),
    ...(input.instanceType === undefined ? {} : { instanceType: input.instanceType }),
  });
  if (!parsed.success) {
    throw new JobError(
      `the catalog entry cannot run its installer in the sandbox Worker: ${z.prettifyError(parsed.error).replace(/\s+/g, " ")}`,
    );
  }
  return parsed.data;
}

function binding(env: JobEnv): SandboxBuildsBinding {
  const found = sandboxBinding(env);
  if (found === undefined) {
    throw new JobError(
      "this app's installer runs in the account's sandbox Worker, and Appflare is not connected to one; enable sandbox builds (Settings, Sandbox builds) and try again",
    );
  }
  return found;
}

/** Step "check sandbox Worker": connected, the right protocol, and able to run installers. */
export async function checkSandboxForInstallerPhase(
  steps: JobSteps,
  env: JobEnv,
  opts: { costConfirmed: boolean | undefined; needsConfirmation: boolean },
): Promise<{ image: string }> {
  return steps.run("check sandbox Worker", async ({ log }) => {
    if (opts.needsConfirmation && opts.costConfirmed !== true) {
      throw new JobError(
        "this app's installer runs in the account's sandbox Worker on Workers Paid; confirm its cost to continue",
      );
    }
    let info: Awaited<ReturnType<typeof sandboxInfo>>;
    try {
      info = await sandboxInfo(binding(env));
    } catch (error) {
      if (error instanceof SandboxProtocolError) throw new JobError(error.message);
      throw error;
    }
    if (!runsSelfDeploying(info)) {
      throw new JobError(
        `the sandbox Worker ${info.sandboxVersion} cannot run app installers; to update it, ${UPDATE_SANDBOX_HINT}`,
      );
    }
    log.info(`The sandbox Worker ${info.sandboxVersion} runs installers in ${info.image}.`);
    return { image: info.image };
  });
}

/**
 * Step "load catalog manifest": the entry's published catalog manifest,
 * checked against the index's digest, slug, tier and pin. The step returns
 * its text; it is parsed again outside the step, so a replayed step never
 * fetches it twice.
 */
export async function loadInstallerCatalogPhase(
  steps: JobSteps,
  target: {
    slug: string;
    input: Pick<SelfDeployingJobInput, "pin" | "manifestUrl" | "manifestDigest">;
  },
): Promise<{ catalog: CatalogManifest; text: string }> {
  const expected = {
    slug: target.slug,
    pin: target.input.pin,
    digest: target.input.manifestDigest,
    tier: "self-deploying" as const,
  };
  const loaded = await steps.run("load catalog manifest", async ({ log, fetch }) => {
    const file = await fetchWhole(fetch, target.input.manifestUrl);
    const catalog = await verifyCatalogManifest(file.bytes, expected);
    log.info(
      `Loaded the catalog manifest of ${target.slug} (digest matches the catalog, pinned to ${target.input.pin.slice(0, 12)}; installer: ${SELF_DEPLOYING_TOOLS[installerOf(catalog).tool].label}).`,
    );
    return { text: new TextDecoder().decode(file.bytes) };
  });
  steps.current = "load catalog manifest";
  const catalog = await verifyCatalogManifest(new TextEncoder().encode(loaded.text), expected);
  return { catalog, text: loaded.text };
}

/** The catalog manifest recorded on a self-deploying install, or null when it has none (yet). */
export function recordedCatalog(manifestJson: string | null): CatalogManifest | null {
  if (manifestJson === null) return null;
  try {
    const parsed = catalogManifestSchema.safeParse(JSON.parse(manifestJson));
    return parsed.success && parsed.data.install.tier === "self-deploying" ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Refuses to change the sandbox Worker's secrets while another job runs in
 * it: each change deploys a new version of the sandbox Worker, which restarts
 * its containers and would kill that job's build or installer run.
 */
async function refuseWhileSandboxBusy(orm: Database, jobId: string): Promise<void> {
  const busy = await activeSandboxJob(orm, jobId);
  if (busy !== null) throw new JobError(sandboxBusyMessage(busy));
}

/**
 * Whether this job already logged one of `messages`. Workflows can run a step
 * again after it finished: live, an OpenSEO install logged a secret as stored
 * twice, and its uninstall deleted a secret and then found it gone. A secret
 * step logs its line only after its API call succeeded, so the line means the
 * call is done: the step then skips both, since every repeated write deploys
 * yet another version of the sandbox Worker, and a repeated line is noise.
 */
async function doneInThisJob(
  orm: Database,
  jobId: string,
  messages: readonly string[],
): Promise<boolean> {
  const found = await orm
    .select({ id: job_logs.id })
    .from(job_logs)
    .where(and(eq(job_logs.job_id, jobId), inArray(job_logs.message, [...messages])))
    .limit(1);
  return found.length > 0;
}

/**
 * Stores the app's token and secret values as secrets on the sandbox Worker,
 * one step each, with the manager's token. Secret names are recorded on the
 * install (`kind: "secret"`, managed by the app); values are never logged.
 * Refused while another job runs in the sandbox Worker (see
 * {@link refuseWhileSandboxBusy}). Each value is stored and logged once per
 * job, however often its step runs (see {@link doneInThisJob}).
 */
export async function storeAppCredentialsPhase(
  steps: JobSteps,
  target: {
    installId: string;
    /** The job doing the writing; its own run has not started yet. */
    jobId: string;
    token: string | undefined;
    secrets: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const { installId, token } = target;
  if (token !== undefined) {
    await steps.run("store app token on the sandbox Worker", async ({ log, cf, orm }) => {
      const stored = `Stored the app's token as the secret ${appTokenSecretName(installId)} on the sandbox Worker (${SANDBOX_WORKER_NAME}); Appflare keeps no copy.`;
      if (await doneInThisJob(orm, target.jobId, [stored])) return {};
      await refuseWhileSandboxBusy(orm, target.jobId);
      await cf().workers.putSecret(SANDBOX_WORKER_NAME, {
        name: appTokenSecretName(installId),
        text: token,
      });
      log.info(stored);
      return {};
    });
  }
  for (const [name, value] of Object.entries(target.secrets)) {
    await steps.run(`store app secret ${name} on the sandbox Worker`, async ({ log, cf, orm }) => {
      if (value.length === 0) throw new JobError(`no value was provided for the secret ${name}`);
      const stored = `Stored ${name} on the sandbox Worker for the installer, which sets it on the app's Workers.`;
      if (await doneInThisJob(orm, target.jobId, [stored])) return {};
      await refuseWhileSandboxBusy(orm, target.jobId);
      await cf().workers.putSecret(SANDBOX_WORKER_NAME, {
        name: appSecretSecretName(installId, name),
        text: value,
      });
      await orm
        .insert(resources)
        .values({
          id: resourceId(installId, "secret", name),
          install_id: installId,
          kind: "secret",
          binding: name,
          name,
          cf_id: null,
          created_at: new Date(steps.now()),
          managed_by: "app",
        })
        .onConflictDoNothing();
      log.info(stored);
      return {};
    });
  }
}

/**
 * Step "check app token on the sandbox Worker": whether the sandbox Worker
 * holds the install's token and every secret. `fresh`: they were just
 * stored, so the step waits for the sandbox Worker's new version to serve
 * them. `required`: a missing one ends the job with what to do. `optional`:
 * the answer is returned either way.
 */
export async function awaitAppCredentialsPhase(
  steps: JobSteps,
  env: JobEnv,
  target: {
    installId: string;
    accountId: string;
    catalog: CatalogManifest;
    mode: "fresh" | "required" | "optional";
  },
): Promise<SelfManagedStatus> {
  const request = selfManagedStatusRequestSchema.parse({
    protocol: SANDBOX_PROTOCOL_VERSION,
    installId: target.installId,
    accountId: target.accountId,
    secretNames: target.catalog.secrets.map((s) => s.name),
    expectedWorkers: expectedWorkers(target.catalog, target.installId),
  });
  return steps.run(
    "check app token on the sandbox Worker",
    async ({ log }) => {
      let status: SelfManagedStatus;
      try {
        status = parseSelfManagedStatus(await binding(env).selfManagedStatus(request));
      } catch (error) {
        if (error instanceof SandboxProtocolError) throw new JobError(error.message);
        throw error;
      }
      if (status.tokenPresent && status.secretsPresent) {
        log.info("The sandbox Worker holds the app's token and secrets for this install.");
        return status;
      }
      const what = !status.tokenPresent ? "the app's token" : "every app secret";
      if (target.mode === "fresh") {
        // The new sandbox Worker version is not serving yet; the step retries.
        throw new Error(`the sandbox Worker does not hold ${what} yet`);
      }
      if (target.mode === "required") {
        throw new JobError(
          `the sandbox Worker does not hold ${what} for this install (it was removed, or the sandbox Worker was deleted and enabled again); enter it again on the install page, then retry`,
        );
      }
      log.warn(`The sandbox Worker does not hold ${what} for this install.`);
      return status;
    },
    target.mode === "fresh" ? CREDENTIALS_VISIBLE_STEP : undefined,
  );
}

type InstallerResult<A> = A extends "deploy" ? SelfManagedDeployResult : SelfManagedDestroyResult;

/**
 * Step "deploy in sandbox" or "destroy in sandbox": one run of the app's
 * installer. The end of its output goes to the job log.
 */
export async function runInstallerPhase<A extends "deploy" | "destroy">(
  steps: JobSteps,
  env: JobEnv,
  action: A,
  request: SelfManagedRunRequest,
): Promise<InstallerResult<A>> {
  return steps.run(
    `${action} in sandbox`,
    async ({ log, attempt }) => {
      const sandbox = binding(env);
      // A retry runs in a container of its own (see the request's `attempt`).
      const attempted = { ...request, attempt };
      let outcome: ReturnType<typeof parseSelfManagedOutcome>;
      try {
        outcome = parseSelfManagedOutcome(
          action === "deploy"
            ? await sandbox.deploySelfManaged(attempted)
            : await sandbox.destroySelfManaged(attempted),
        );
      } catch (error) {
        if (error instanceof SandboxProtocolError) throw new JobError(error.message);
        throw error;
      }
      for (const line of tailLines(outcome.log, INSTALLER_LOG_LINES)) log.log("debug", line);
      if (!outcome.ok) {
        const message = `the installer's ${action} failed in its ${outcome.step} step${outcome.exitCode === null ? "" : ` (exit code ${outcome.exitCode})`}: ${outcome.message}`;
        if (outcome.retryable) throw new Error(message);
        throw new JobError(message);
      }
      if (outcome.action !== action || outcome.installId !== request.installId) {
        throw new JobError(
          `the sandbox Worker answered a ${outcome.action} of ${outcome.installId}, not a ${action} of ${request.installId}`,
        );
      }
      log.info(
        `The installer's ${action} of stage ${request.stage} at ${request.sha.slice(0, 12)} finished in ${outcome.minutes} minute(s) (${outcome.image}).`,
      );
      return outcome as InstallerResult<A>;
    },
    INSTALLER_RUN_STEP,
  );
}

/** The `resources` key of a discovered resource (stable across runs). */
export function discoveredKey(r: SelfManagedResource): string {
  if (r.kind === "durable_object") return `${r.worker}.${r.name}`;
  if (r.kind === "d1" || r.kind === "kv") return r.cfId ?? r.name;
  return r.name;
}

/**
 * Step "record the app's resources": every resource the deploy reported,
 * recorded as managed by the app. Resources already recorded stay as they
 * are; ones a later deploy no longer reports are left recorded and named in
 * the log (the installer may have removed them, or only unbound them).
 */
export async function recordDiscoveredPhase(
  steps: JobSteps,
  installId: string,
  discovered: readonly SelfManagedResource[],
  previous: ReadonlyArray<{ kind: string; name: string }> = [],
): Promise<void> {
  await steps.run("record the app's resources", async ({ log, orm }) => {
    const at = new Date(steps.now());
    for (const r of discovered) {
      await orm
        .insert(resources)
        .values({
          id: resourceId(installId, r.kind, discoveredKey(r)),
          install_id: installId,
          kind: r.kind,
          binding: r.binding,
          name: r.name,
          cf_id: r.cfId,
          created_at: at,
          managed_by: "app",
        })
        .onConflictDoNothing();
    }
    const reported = new Set(discovered.map((r) => `${r.kind}:${r.name}`));
    const unreported = previous.filter(
      (p) => p.kind !== "secret" && !reported.has(`${p.kind}:${p.name}`),
    );
    log.info(
      `Recorded what the installer created (${discovered.length}): ${discovered.map((r) => `${r.kind} ${r.name}`).join(", ")}. The uninstall removes them with the installer's destroy command; Appflare never deletes them itself.`,
    );
    if (unreported.length > 0) {
      log.warn(
        `The installer no longer reports: ${unreported.map((p) => `${p.kind} ${p.name}`).join(", ")}. They stay listed until the uninstall.`,
      );
    }
    return {};
  });
}

/**
 * Deletes the app's token and secrets from the sandbox Worker, one step each
 * and each name once. One already gone counts as deleted; a step that runs
 * again after it finished deletes and logs nothing (see {@link doneInThisJob}).
 */
export async function forgetAppCredentialsPhase(
  steps: JobSteps,
  target: { installId: string; jobId: string },
  secretNames: readonly string[],
): Promise<void> {
  const { installId } = target;
  const names = new Set([
    appTokenSecretName(installId),
    ...secretNames.map((n) => appSecretSecretName(installId, n)),
  ]);
  for (const name of names) {
    await steps.run(`remove ${name} from the sandbox Worker`, async ({ log, cf, orm }) => {
      const deleted = `Deleted the secret ${name} from the sandbox Worker.`;
      const gone = `The sandbox Worker no longer had the secret ${name}.`;
      if (await doneInThisJob(orm, target.jobId, [deleted, gone])) return {};
      await refuseWhileSandboxBusy(orm, target.jobId);
      try {
        await cf().workers.deleteSecret(SANDBOX_WORKER_NAME, name);
        log.info(deleted);
      } catch (error) {
        if (!isNotFound(error)) throw error;
        log.info(gone);
      }
      return {};
    });
  }
}
