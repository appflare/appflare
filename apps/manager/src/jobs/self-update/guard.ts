import { and, inArray } from "drizzle-orm";
import {
  NO_REMOVAL_IN_PROGRESS_SQL,
  REMOVAL_IN_PROGRESS_MESSAGE,
  removalInProgress,
} from "../../danger/removal-flag";
import { createDb } from "../../db/client";
import { jobs } from "../../db/schema";
import { reconcileJobs, type WorkflowLookup } from "../reconcile.server";

/**
 * While the manager updates itself nothing else may run: a Workflow instance
 * running when the manager's script is replaced continues on the new code,
 * which may name its steps differently. So a self-update starts only when no
 * job is queued or running, and no other job starts while one is. Before
 * refusing, a self-update whose Workflow instance died is settled, so a dead
 * instance never blocks everything silently. A rollback of the manager
 * (`self_rollback`) replaces the script too and is held to the same rule.
 *
 * The same checks also refuse every start while Appflare is being removed
 * from the account (danger/removal-flag.ts).
 */

/**
 * SQL condition (for a claim's `WHERE`) that holds while no self-update is
 * queued or running and Appflare is not being removed.
 */
export const NO_ACTIVE_SELF_UPDATE_SQL = `NOT EXISTS (SELECT 1 FROM jobs WHERE kind IN ('self_update', 'self_rollback') AND status IN ('queued', 'running')) AND ${NO_REMOVAL_IN_PROGRESS_SQL}`;

/** The job kinds that replace the manager's own Worker version. */
export const SELF_VERSION_JOB_KINDS = ["self_update", "self_rollback"] as const;

/** A queued or running job that replaces the manager's own version. */
export interface ActiveSelfJob {
  id: string;
  kind: (typeof SELF_VERSION_JOB_KINDS)[number];
}

/**
 * Why another job cannot start; names the self-update (or the rollback of
 * Appflare, given as a job) and where to follow it.
 */
export function selfUpdateBusyMessage(job: string | ActiveSelfJob): string {
  const { id, kind } = typeof job === "string" ? { id: job, kind: "self_update" } : job;
  const doing = kind === "self_rollback" ? "rolling itself back" : "updating itself";
  return `Appflare is ${doing} (job ${id}). Wait for it to finish, then try again. Follow it at /jobs/${id}.`;
}

/**
 * The self-update queued or running, if any. With `workflows`, rows whose
 * Workflow instance ended are reconciled first. A rollback of Appflare is
 * not a self-update: the sidebar card and the updates page follow only these.
 */
export async function activeSelfUpdateJob(
  db: D1Database,
  workflows?: WorkflowLookup,
): Promise<string | null> {
  return (await activeSelfJobOf(db, workflows, ["self_update"]))?.id ?? null;
}

/**
 * The self-update or rollback of Appflare queued or running, if any, which
 * every other job waits for. Reconciled first as above.
 */
export async function activeSelfJob(
  db: D1Database,
  workflows?: WorkflowLookup,
): Promise<ActiveSelfJob | null> {
  return activeSelfJobOf(db, workflows, SELF_VERSION_JOB_KINDS);
}

async function activeSelfJobOf(
  db: D1Database,
  workflows: WorkflowLookup | undefined,
  kinds: readonly ActiveSelfJob["kind"][],
): Promise<ActiveSelfJob | null> {
  const orm = createDb(db);
  const read = () =>
    orm
      .select()
      .from(jobs)
      .where(and(inArray(jobs.kind, [...kinds]), inArray(jobs.status, ["queued", "running"])));
  let rows = await read();
  if (rows.length > 0 && workflows !== undefined && (await reconcileJobs(db, workflows, rows))) {
    rows = await read();
  }
  const row = rows[0];
  if (row === undefined) return null;
  return { id: row.id, kind: row.kind === "self_rollback" ? "self_rollback" : "self_update" };
}

/**
 * Throws `toError(<busy message>)` while a self-update or a rollback of
 * Appflare is queued or running, or while Appflare is being removed.
 */
export async function refuseDuringSelfUpdate(
  db: D1Database,
  workflows: WorkflowLookup | undefined,
  toError: (message: string) => Error,
): Promise<void> {
  if ((await removalInProgress(db)) !== null) throw toError(REMOVAL_IN_PROGRESS_MESSAGE);
  const active = await activeSelfJob(db, workflows);
  if (active !== null) throw toError(selfUpdateBusyMessage(active));
}
