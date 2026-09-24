import { createDb } from "../db/client";
import { deleteSettings, readSettings, SETTING, writeSettings } from "../db/settings";

/**
 * While Appflare is being removed from the account, no job may start: a job
 * would work against resources the removal is deleting, and once the D1
 * database is gone nothing could record it. The removal sets this setting
 * before its first delete and clears it when it stops early (the manager
 * then keeps working and the removal can be run again). Every job start path
 * checks it, and its SQL is part of each start's conditional insert, so a
 * start that raced the removal's own check of running jobs still loses.
 *
 * A removal takes a few minutes at most. A mark older than
 * {@link REMOVAL_STALE_MS} belongs to a request that died without clearing
 * it, and no longer counts, so a lost request never blocks jobs for good.
 */

export const REMOVAL_STALE_MS = 15 * 60 * 1000;

/** SQL condition that holds while Appflare is not being removed. */
export const NO_REMOVAL_IN_PROGRESS_SQL = `NOT EXISTS (SELECT 1 FROM settings WHERE key = '${SETTING.removalInProgress}' AND updated_at > CAST(unixepoch('subsecond') * 1000 AS INTEGER) - ${REMOVAL_STALE_MS})`;

export const REMOVAL_IN_PROGRESS_MESSAGE =
  "Appflare is being removed from this account, so no job can start.";

/** ISO 8601 time the running removal started, or null when none is running. */
export async function removalInProgress(
  db: D1Database,
  now: Date = new Date(),
): Promise<string | null> {
  const row = await readSettings(createDb(db), [SETTING.removalInProgress]);
  const started = row.removal_in_progress;
  if (started === undefined) return null;
  const at = Date.parse(started);
  return Number.isFinite(at) && now.getTime() - at < REMOVAL_STALE_MS ? started : null;
}

export async function markRemovalStarted(db: D1Database, at: Date): Promise<void> {
  await writeSettings(createDb(db), { [SETTING.removalInProgress]: at.toISOString() }, at);
}

export async function clearRemovalStarted(db: D1Database): Promise<void> {
  await deleteSettings(createDb(db), [SETTING.removalInProgress]);
}
