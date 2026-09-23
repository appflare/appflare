import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../../db/client";
import { jobs } from "../../db/schema";
import { reconcileJobs, type WorkflowLookup } from "../reconcile.server";

/**
 * While the manager updates itself nothing else may run: a Workflow instance
 * running when the manager's script is replaced continues on the new code,
 * which may name its steps differently. So a self-update starts only when no
 * job is queued or running, and no other job starts while one is. Before
 * refusing, a self-update whose Workflow instance died is settled, so a dead
 * instance never blocks everything silently.
 */

/** SQL condition (for a claim's `WHERE`) that holds while no self-update is queued or running. */
export const NO_ACTIVE_SELF_UPDATE_SQL =
  "NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'self_update' AND status IN ('queued', 'running'))";

/** Why another job cannot start; names the self-update and where to follow it. */
export function selfUpdateBusyMessage(jobId: string): string {
  return `Appflare is updating itself (job ${jobId}). Wait for it to finish, then try again. Follow it at /jobs/${jobId}.`;
}

/**
 * The self-update queued or running, if any. With `workflows`, rows whose
 * Workflow instance ended are reconciled first.
 */
export async function activeSelfUpdateJob(
  db: D1Database,
  workflows?: WorkflowLookup,
): Promise<string | null> {
  const orm = createDb(db);
  const read = () =>
    orm
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, "self_update"), inArray(jobs.status, ["queued", "running"])));
  let rows = await read();
  if (rows.length > 0 && workflows !== undefined && (await reconcileJobs(db, workflows, rows))) {
    rows = await read();
  }
  return rows[0]?.id ?? null;
}

/** Throws `toError(<busy message>)` while a self-update is queued or running. */
export async function refuseDuringSelfUpdate(
  db: D1Database,
  workflows: WorkflowLookup | undefined,
  toError: (message: string) => Error,
): Promise<void> {
  const active = await activeSelfUpdateJob(db, workflows);
  if (active !== null) throw toError(selfUpdateBusyMessage(active));
}
