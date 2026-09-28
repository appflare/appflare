import { desc, eq, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { installs, type JobStarter, jobs } from "../db/schema";
import { namedInstall, readInstallLabels } from "../installs/install-names.server";
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
  install: { id: string; label: string } | null;
}

/**
 * The most recent jobs across every install and Appflare itself, newest
 * first (by start, jobs not started yet first). Read only: jobs still
 * running are settled by the pages that show them one by one.
 */
export async function listRecentJobs(
  d1: D1Database,
  limit: number = JOB_LIST_LIMIT,
): Promise<JobListRow[]> {
  const rows = await createDb(d1)
    .select({
      id: jobs.id,
      kind: jobs.kind,
      status: jobs.status,
      inputJson: jobs.input_json,
      startedBy: jobs.started_by,
      startedAt: jobs.started_at,
      finishedAt: jobs.finished_at,
      installId: installs.id,
      appSlug: installs.app_slug,
      displayName: installs.display_name,
      workerName: installs.worker_name,
      manifestJson: installs.manifest_json,
    })
    .from(jobs)
    .leftJoin(installs, eq(jobs.install_id, installs.id))
    .orderBy(sql`${jobs.started_at} IS NULL DESC`, desc(jobs.started_at), desc(jobs.id))
    .limit(limit);
  // Two installs that read the same are told apart, as in the sidebar.
  const named = rows.flatMap((row) =>
    row.installId === null
      ? []
      : [
          namedInstall({
            id: row.installId,
            app_slug: row.appSlug ?? "",
            worker_name: row.workerName ?? row.installId,
            display_name: row.displayName,
            manifest_json: row.manifestJson,
          }),
        ],
  );
  const labels =
    named.length === 0 ? new Map<string, string>() : await readInstallLabels(d1, named);
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
        : { id: row.installId, label: labels.get(row.installId) ?? row.installId },
  }));
}
