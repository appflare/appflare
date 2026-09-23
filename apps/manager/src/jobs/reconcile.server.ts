import { and, eq, inArray } from "drizzle-orm";
import { createDb, type Database } from "../db/client";
import { installs, jobs } from "../db/schema";
import { StepLog } from "./step-log";

/**
 * Brings job rows in line with their Workflow instances. A job records its
 * own end, but an instance can die outside the job's code (terminated from
 * the dashboard, an engine failure), leaving the row `queued` or `running`
 * for good, which would also block every later job of its install. Pages that
 * show a job call this first: an instance that errored, was terminated, or is
 * unknown fails its job; one that completed succeeds it. A failed install job
 * also fails its install, so the install can be retried or uninstalled; a
 * failed update or rollback returns its install from `updating` to
 * `installed` (the version record changes only inside the job, when it
 * promotes, so it is already right).
 *
 * A database restore runs inside a server function, not a Workflow; its job
 * row has no instance. One still `running` after {@link RESTORE_STALE_MS}
 * lost its request midway and is failed.
 */

/** The part of a Workflow binding this reads (`env.JOBS`). */
export interface WorkflowLookup {
  get(id: string): Promise<{ status(): Promise<{ status: string; error?: { message: string } }> }>;
}

export interface ActiveJobRow {
  id: string;
  kind: string;
  status: string;
  install_id: string | null;
  workflow_instance_id: string | null;
  input_json?: string | null;
  started_at?: Date | null;
}

const DEAD = new Set(["errored", "terminated", "unknown"]);

/** A restore request that has not recorded its end after this long never will. */
export const RESTORE_STALE_MS = 5 * 60 * 1000;

/** Whether the job row is a database restore (it has no Workflow instance). */
export function isRestoreJob(row: Pick<ActiveJobRow, "kind" | "input_json">): boolean {
  if (row.kind !== "rollback" || row.input_json == null) return false;
  try {
    return (JSON.parse(row.input_json) as { restore?: unknown }).restore === true;
  } catch {
    return false;
  }
}

/** Settles a restore row whose request died; true when it changed. */
async function reconcileRestore(db: D1Database, row: ActiveJobRow, at: Date): Promise<boolean> {
  const started = row.started_at?.getTime() ?? null;
  if (started !== null && at.getTime() - started < RESTORE_STALE_MS) return false;
  const error =
    "the restore request ended without recording its result; check the database's Time Travel history in the Cloudflare dashboard";
  const updated = await createDb(db)
    .update(jobs)
    .set({ status: "failed", error, finished_at: at })
    .where(and(eq(jobs.id, row.id), inArray(jobs.status, ["queued", "running"])))
    .returning({ id: jobs.id });
  if (updated.length === 0) return false;
  const log = new StepLog(() => at.getTime());
  log.error(`Stopped: ${error}.`);
  await log.flush(db, row.id);
  return true;
}

/** An update or rollback that ended, one way or another, leaves its install `installed`. */
async function settleUpdating(orm: Database, row: ActiveJobRow, at: Date): Promise<void> {
  if ((row.kind !== "update" && row.kind !== "rollback") || row.install_id === null) return;
  await orm
    .update(installs)
    .set({ status: "installed", updated_at: at })
    .where(and(eq(installs.id, row.install_id), eq(installs.status, "updating")));
}

/** Returns true when a row changed (callers then re-read). */
export async function reconcileJobs(
  db: D1Database,
  workflows: WorkflowLookup,
  rows: readonly ActiveJobRow[],
  now: () => Date = () => new Date(),
): Promise<boolean> {
  let changed = false;
  for (const row of rows) {
    if (row.status !== "queued" && row.status !== "running") continue;
    if (isRestoreJob(row)) {
      if (await reconcileRestore(db, row, now())) changed = true;
      continue;
    }
    let status: string;
    let message: string | undefined;
    try {
      const instance = await workflows.get(row.workflow_instance_id ?? row.id);
      const reported = await instance.status();
      status = reported.status;
      message = reported.error?.message;
    } catch (error) {
      // Only an instance the engine reports as missing is gone. Without a
      // recorded instance id it may still be being created; any other error
      // (a transient binding failure) says nothing, so the job is left as is.
      const reason = error instanceof Error ? error.message : String(error);
      if (row.workflow_instance_id === null || !/not[_ ]found/i.test(reason)) {
        console.debug("job reconciliation skipped", { jobId: row.id, reason });
        continue;
      }
      status = "unknown";
    }
    const orm = createDb(db);
    const at = now();
    const log = new StepLog(() => at.getTime());
    if (status === "complete") {
      const updated = await orm
        .update(jobs)
        .set({ status: "succeeded", finished_at: at })
        .where(and(eq(jobs.id, row.id), inArray(jobs.status, ["queued", "running"])))
        .returning({ id: jobs.id });
      if (updated.length === 0) continue;
      await settleUpdating(orm, row, at);
      log.warn("The Workflow instance completed without recording the end of the job.");
    } else if (DEAD.has(status)) {
      const error =
        status === "unknown"
          ? "the job's Workflow instance no longer exists"
          : `the job's Workflow instance ${status === "errored" ? "failed" : "was terminated"}${message ? `: ${message}` : ""}`;
      const updated = await orm
        .update(jobs)
        .set({ status: "failed", error, finished_at: at })
        .where(and(eq(jobs.id, row.id), inArray(jobs.status, ["queued", "running"])))
        .returning({ id: jobs.id });
      if (updated.length === 0) continue;
      if (row.kind === "install" && row.install_id !== null) {
        await orm
          .update(installs)
          .set({ status: "failed", updated_at: at })
          .where(and(eq(installs.id, row.install_id), eq(installs.status, "installing")));
      }
      await settleUpdating(orm, row, at);
      // An uninstall leaves its install `uninstalling`; the install page offers a retry.
      log.error(`Stopped: ${error}.`);
    } else {
      continue;
    }
    await log.flush(db, row.id);
    changed = true;
  }
  return changed;
}
