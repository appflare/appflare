import { and, asc, eq, gt } from "drizzle-orm";
import type { Database } from "../db/client";
import { job_logs } from "../db/schema";

/**
 * A job's log lines in the order they were written (`id` only grows), all of
 * them or only those after `afterId`: a job page that is following a running
 * job already holds the earlier lines and asks for the new ones only.
 */
export function readJobLogs(
  db: Database,
  jobId: string,
  afterId?: number,
): Promise<Array<typeof job_logs.$inferSelect>> {
  const ofJob = eq(job_logs.job_id, jobId);
  return db
    .select()
    .from(job_logs)
    .where(afterId === undefined ? ofJob : and(ofJob, gt(job_logs.id, afterId)))
    .orderBy(asc(job_logs.id));
}
