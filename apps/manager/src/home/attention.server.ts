import { NEEDS_ADMIN_COPY, unattendedUpdateBlock } from "../auto-update/auto-update";
import {
  type CandidateRow,
  candidateKey,
  readCandidateRows,
  updateCandidates,
} from "../auto-update/cron.server";
import type { AppLookup } from "../catalog/merged.server";
import { isUpdateAvailable } from "../catalog/versions";
import { buildIdOfInput } from "../installs/install-again";
import type { InstallRecord } from "../installs/install-rows.server";
import { isDeleteRetainedJob } from "../installs/removed-apps.server";
import { isAccessChangeJob, isRestoreJob } from "../jobs/reconcile.server";
import type { FailedJob } from "./attention";

/** What "Needs attention" reads from D1 besides the installs themselves. Server only. */

function versionOf(inputJson: string | null): string | null {
  if (inputJson === null) return null;
  try {
    const value = (JSON.parse(inputJson) as { version?: unknown }).version;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The latest finished job of each app that is not uninstalled, when that job
 * failed: a failure stays until a later job of the same app succeeds. Jobs
 * still queued or running do not count either way, and builds for review
 * (which only produce something to look at) are left out.
 */
export async function readFailedJobs(db: D1Database): Promise<FailedJob[]> {
  const rows = await db
    .prepare(
      `SELECT id, install_id, kind, input_json, finished_at FROM (
         SELECT j.id, j.install_id, j.kind, j.status, j.input_json, j.finished_at,
           ROW_NUMBER() OVER (
             PARTITION BY j.install_id
             ORDER BY coalesce(j.finished_at, j.started_at, 0) DESC, j.id DESC
           ) AS latest
         FROM jobs j JOIN installs i ON i.id = j.install_id
         WHERE j.status IN ('succeeded', 'failed')
           AND j.kind <> 'source_build'
           AND i.status <> 'uninstalled'
       )
       WHERE latest = 1 AND status = 'failed'
       ORDER BY id`,
    )
    .all<{
      id: string;
      install_id: string;
      kind: string;
      input_json: string | null;
      finished_at: number | null;
    }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    installId: row.install_id,
    kind: row.kind,
    restore: isRestoreJob(row),
    accessChange: isAccessChangeJob(row),
    deleteRetained: isDeleteRetainedJob(row),
    version: versionOf(row.input_json),
    buildId: buildIdOfInput(row.input_json),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
  }));
}

/** A stored install as the update rules read it (`readCandidateRows`). */
function candidateOf(row: InstallRecord): CandidateRow {
  return {
    id: row.id,
    slug: row.app_slug,
    catalogId: row.catalog_id,
    displayName: row.display_name,
    workerName: row.worker_name,
    status: row.status,
    buildKind: row.build_kind,
    origin: row.origin,
    choice: row.auto_update,
    version: row.catalog_version,
    waiting: row.auto_update_waiting,
  };
}

/** Why an update the cron already tried is waiting: it found the update needs something. */
export const WAITING_FOR_INPUT =
  "It needs something from you first, such as a new setting or a confirmation.";

/**
 * Why each available update waits for the admin's input, by install id:
 * the rules automatic updates and "Update all" follow (an update built in
 * the account, one that failed or was rolled back before), and the updates
 * the cron already found need a value or a confirmation. An update missing
 * here can start from its Update button (which may still ask for something
 * the new version needs; only starting it reads that). Reads the jobs
 * only when some install has an update, which is rarely.
 */
export async function readUpdateNeeds(
  db: D1Database,
  /** The installs as stored, when the caller read them already. */
  records: readonly InstallRecord[] | null,
  listed: AppLookup,
): Promise<Map<string, string>> {
  const rows = records === null ? await readCandidateRows(db) : records.map(candidateOf);
  const withUpdate = rows.filter((r) => {
    const latest = listed.get(candidateKey(r))?.app.version;
    return (
      r.status === "installed" && r.origin !== "repository" && isUpdateAvailable(r.version, latest)
    );
  });
  const needs = new Map<string, string>();
  if (withUpdate.length === 0) return needs;
  const candidates = await updateCandidates(db, withUpdate, listed);
  for (const c of candidates) {
    const block = unattendedUpdateBlock(c);
    if (
      block === "reinstall-needed" ||
      block === "needs-approval" ||
      block === "failed-before" ||
      block === "rolled-back"
    ) {
      needs.set(c.installId, NEEDS_ADMIN_COPY[block]);
    } else if (block === null && c.latest !== null && c.waiting === c.latest.version) {
      needs.set(c.installId, WAITING_FOR_INPUT);
    }
  }
  return needs;
}
