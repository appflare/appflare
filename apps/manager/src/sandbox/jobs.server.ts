import type { CloudflareClient } from "@appflare/cf-api";
import { probeContainers, probeR2 } from "@appflare/cf-api/capabilities";
import { SANDBOX_WORKER_NAME } from "@appflare/schema";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import { NO_REMOVAL_IN_PROGRESS_SQL } from "../danger/removal-flag";
import { createDb } from "../db/client";
import { job_logs, jobs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { reconcileJobs, type WorkflowLookup } from "../jobs/reconcile.server";
import { refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import { installsNeedingSandbox, sandboxInUseMessage } from "./blockers";
import type { SandboxDisableJobParams } from "./disable-job";
import type { SandboxEnableJobParams } from "./enable-job";
import { firstLine, lastSandboxFailure } from "./failure-hint";
import { sandboxPreflightProblems } from "./preflight";
import { PINNED_SANDBOX_VERSION } from "./release";

/**
 * Starting "Enable sandbox builds", "Update sandbox" and "Disable sandbox
 * builds". Admins only (the server function checks). Each is a job, so its
 * progress is in the job log; the job row is the claim, inserted only while
 * no job at all is queued or running: uploading or deleting the sandbox
 * Worker restarts every container in it, and connecting deploys a new
 * version of Appflare itself. The account is checked first with the same
 * probes Settings shows (two read calls), so a refusal names its reason
 * before anything starts.
 */

export class SandboxJobError extends Error {
  override name = "SandboxJobError";
}

export type SandboxAction = "enable" | "update" | "disable";

export interface StartSandboxJobDeps {
  db: D1Database;
  /** Built only when the checks get that far. */
  client: () => Promise<CloudflareClient>;
  workflows: WorkflowLookup;
  createJob(
    id: string,
    params: SandboxEnableJobParams | SandboxDisableJobParams,
  ): Promise<{
    id: string;
  }>;
  /** The running `APPFLARE_VERSION`. */
  currentVersion: string;
  /** The sandbox Worker release to deploy; the manager's pin. */
  sandboxVersion?: string;
  /** The version the connected sandbox Worker reports, for the job's record. */
  deployedSandboxVersion?: string | null;
  now?: () => Date;
  newId?: () => string;
}

const BUSY =
  "Another job is queued or running. Sandbox builds are changed only while nothing else runs; wait for it to finish.";

export async function startSandboxJobCore(
  deps: StartSandboxJobDeps,
  request: { action: SandboxAction; confirm?: string },
): Promise<{ jobId: string }> {
  const fail = (message: string) => new SandboxJobError(message);
  await refuseDuringSelfUpdate(deps.db, deps.workflows, fail);
  const orm = createDb(deps.db);
  const settings = await readSettings(orm, [SETTING.accountId, SETTING.workerName]);
  if (!settings.account_id || !settings.worker_name) {
    throw fail("Appflare does not know its Cloudflare account and Worker yet. Finish setup first.");
  }

  const disable = request.action === "disable";
  if (disable) {
    if (request.confirm?.trim() !== SANDBOX_WORKER_NAME) {
      throw fail(`Type ${SANDBOX_WORKER_NAME} to confirm; nothing was changed.`);
    }
    const blocking = await installsNeedingSandbox(orm);
    if (blocking.length > 0) throw fail(sandboxInUseMessage(blocking));
  }

  const client = await deps.client();
  const [r2, containers] = await Promise.all([
    disable ? Promise.resolve(null) : probeR2(client),
    probeContainers(client),
  ]);
  const problems = sandboxPreflightProblems({ r2, containers }, { containersOnly: disable });
  if (problems.length > 0) throw fail(problems.join(" "));

  const active = await orm
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]));
  if (active.length > 0) await reconcileJobs(deps.db, deps.workflows, active);

  const now = (deps.now ?? (() => new Date()))();
  const jobId = (deps.newId ?? (() => ulid()))();
  const version = deps.sandboxVersion ?? PINNED_SANDBOX_VERSION;
  const params: SandboxEnableJobParams | SandboxDisableJobParams = disable
    ? { kind: "sandbox_disable", jobId, managerVersion: deps.currentVersion }
    : {
        kind: request.action === "update" ? "sandbox_update" : "sandbox_enable",
        jobId,
        version,
        managerVersion: deps.currentVersion,
      };
  const { kind } = params;
  // What the job list and usage data read: the sandbox Worker version it
  // deploys (or removes), and the one it replaces.
  const input = disable
    ? { version: deps.deployedSandboxVersion ?? null }
    : { version, fromVersion: deps.deployedSandboxVersion ?? null };
  const claimed = await deps.db
    .prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by)
       SELECT ?1, NULL, ?2, 'queued', ?3, 'admin'
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE status IN ('queued', 'running'))
         AND ${NO_REMOVAL_IN_PROGRESS_SQL}`,
    )
    .bind(jobId, kind, JSON.stringify(input))
    .run();
  if (claimed.meta.changes !== 1) throw fail(BUSY);

  let instanceId: string;
  try {
    instanceId = (await deps.createJob(jobId, params)).id;
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await orm
      .update(jobs)
      .set({ status: "failed", error: reason, finished_at: now })
      .where(eq(jobs.id, jobId));
    throw fail(reason);
  }
  await orm.update(jobs).set({ workflow_instance_id: instanceId }).where(eq(jobs.id, jobId));
  return { jobId };
}

/** The sandbox job queued or running, if any, for the Settings card. */
export async function activeSandboxWorkerJob(
  db: D1Database,
): Promise<{ id: string; kind: string } | null> {
  const [row] = await createDb(db)
    .select({ id: jobs.id, kind: jobs.kind })
    .from(jobs)
    .where(
      and(inArray(jobs.kind, SANDBOX_WORKER_KINDS), inArray(jobs.status, ["queued", "running"])),
    )
    .limit(1);
  return row ?? null;
}

const SANDBOX_WORKER_KINDS = ["sandbox_enable", "sandbox_update", "sandbox_disable"] as const;

/** A failed sandbox job the Settings card names, with the line that says why. */
export interface SandboxJobFailure {
  id: string;
  kind: string;
  /** The job's first error log line, else the first line of its recorded error. */
  message: string;
}

/**
 * The most recent failed enable, update or disable job, unless a newer one
 * succeeded (see `lastSandboxFailure`). Its first error log line names the
 * step that failed and why; a job refused before it ran has no log, only
 * its recorded error.
 */
export async function lastSandboxJobFailure(db: D1Database): Promise<SandboxJobFailure | null> {
  const orm = createDb(db);
  // Job ids are ULIDs, so they sort by creation time.
  const recent = await orm
    .select({ id: jobs.id, kind: jobs.kind, status: jobs.status, error: jobs.error })
    .from(jobs)
    .where(inArray(jobs.kind, SANDBOX_WORKER_KINDS))
    .orderBy(desc(jobs.id))
    .limit(20);
  const failed = lastSandboxFailure(recent);
  if (failed === null) return null;
  const [line] = await orm
    .select({ message: job_logs.message })
    .from(job_logs)
    .where(and(eq(job_logs.job_id, failed.id), eq(job_logs.level, "error")))
    .orderBy(asc(job_logs.id))
    .limit(1);
  return {
    id: failed.id,
    kind: failed.kind,
    message: firstLine(line?.message) ?? firstLine(failed.error) ?? "The job failed.",
  };
}
