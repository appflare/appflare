import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { installs, type JobStarter, jobs } from "../db/schema";
import { isDeleteRetainedJob } from "../installs/removed-apps.server";
import { JOB_LIST_LIMIT } from "./job-list";
import { isRestoreJob } from "./reconcile.server";

/** One row of `/jobs`: a job, newest first, with the install it belongs to. */
export interface JobListRow {
  id: string;
  kind: string;
  /** A database restore (recorded as a `rollback` job). */
  restore: boolean;
  /** A deletion of the data an uninstall kept (recorded as an `uninstall` job). */
  deleteRetained: boolean;
  status: string;
  startedBy: JobStarter;
  /** ISO 8601 */
  startedAt: string | null;
  /** ISO 8601 */
  finishedAt: string | null;
  /** Null for a job of Appflare itself (its self-update). */
  install: { id: string; instanceName: string } | null;
}

/**
 * The most recent jobs across every install and Appflare itself, newest
 * first (by start, jobs not started yet first). Read only: jobs still
 * running are settled by the pages that show them one by one.
 */
export async function listRecentJobs(
  db: Database,
  limit: number = JOB_LIST_LIMIT,
): Promise<JobListRow[]> {
  const rows = await db
    .select({
      id: jobs.id,
      kind: jobs.kind,
      status: jobs.status,
      inputJson: jobs.input_json,
      startedBy: jobs.started_by,
      startedAt: jobs.started_at,
      finishedAt: jobs.finished_at,
      installId: installs.id,
      instanceName: installs.instance_name,
      workerName: installs.worker_name,
    })
    .from(jobs)
    .leftJoin(installs, eq(jobs.install_id, installs.id))
    .orderBy(sql`${jobs.started_at} IS NULL DESC`, desc(jobs.started_at), desc(jobs.id))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    restore: isRestoreJob({ kind: row.kind, input_json: row.inputJson }),
    deleteRetained: isDeleteRetainedJob({ kind: row.kind, input_json: row.inputJson }),
    status: row.status,
    startedBy: row.startedBy,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    install:
      row.installId === null
        ? null
        : { id: row.installId, instanceName: row.instanceName ?? row.workerName ?? row.installId },
  }));
}
