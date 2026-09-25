import { isInstallId, type TelemetryLock, telemetryLock } from "@appflare/schema";
import { createDb } from "../db/client";
import { readSettings, SETTING, type SettingKey, writeSettings } from "../db/settings";
import { utcDay } from "./events";
import type { TelemetryStatus } from "./telemetry";

/**
 * The stored usage-data choice, the notice, and the Worker variables that
 * override the choice. Reads and writes `settings` rows only; the cron's
 * report lives in report.server.ts.
 */

export interface TelemetryEnv {
  DB: D1Database;
  APPFLARE_VERSION: string;
  APPFLARE_TELEMETRY?: string;
  DO_NOT_TRACK?: string;
  /** The install id the CLI used for its own events, deployed as a plain-text variable. */
  APPFLARE_INSTALL_ID?: string;
}

/** A development build (`0.0.0-dev`, or any `0.0.0` prerelease) never sends anything. */
export function isDevBuild(version: string): boolean {
  return version.startsWith("0.0.0");
}

/** The variable that turns usage data off on this Worker, or null. */
export function lockOf(
  env: Pick<TelemetryEnv, "APPFLARE_TELEMETRY" | "DO_NOT_TRACK">,
): TelemetryLock | null {
  return telemetryLock({
    APPFLARE_TELEMETRY: env.APPFLARE_TELEMETRY,
    DO_NOT_TRACK: env.DO_NOT_TRACK,
  });
}

export class TelemetryLockedError extends Error {
  override name = "TelemetryLockedError";
}

/** On unless an admin turned it off; a Worker variable still overrides it (`lockedBy`). */
export async function readTelemetryStatus(env: TelemetryEnv): Promise<TelemetryStatus> {
  const row = await readSettings(createDb(env.DB), [SETTING.telemetry]);
  return {
    state: row.telemetry === "off" ? "off" : "on",
    lockedBy: lockOf(env),
    devBuild: isDevBuild(env.APPFLARE_VERSION),
  };
}

/**
 * The id every event is tied to: the one the CLI deployed as a variable when
 * it is valid, so its events and the manager's join up; else a random one.
 */
export function newInstallId(env: Pick<TelemetryEnv, "APPFLARE_INSTALL_ID">): string {
  return isInstallId(env.APPFLARE_INSTALL_ID) ? env.APPFLARE_INSTALL_ID : crypto.randomUUID();
}

/**
 * Setup just finished. Records the install id and the job cursor at now, so
 * jobs from before setup finished are never reported. "Setup completed"
 * stays due: the first scheduled report sends it. The usage-data notice is
 * not shown during setup, so it stays due for the home page. Rows already
 * there are kept.
 */
export async function recordSetupFinished(
  env: TelemetryEnv,
  now: Date = new Date(),
): Promise<void> {
  const db = createDb(env.DB);
  const current = await readSettings(db, [SETTING.telemetryInstallId, SETTING.telemetryCursor]);
  const rows: Partial<Record<SettingKey, string>> = {};
  if (!isInstallId(current.telemetry_install_id)) {
    rows[SETTING.telemetryInstallId] = newInstallId(env);
  }
  if (current.telemetry_cursor === undefined) {
    rows[SETTING.telemetryCursor] = String(now.getTime());
  }
  await writeSettings(db, rows, now);
}

/**
 * Whether the home page shows the usage-data notice: once per manager, until
 * an admin dismisses it (or changes the switch in Settings), for a new
 * manager right after setup as for one updated from a version without usage
 * data. Never while a Worker variable turns usage data off.
 */
export async function isNoticeDue(env: TelemetryEnv): Promise<boolean> {
  if (lockOf(env) !== null) return false;
  const row = await readSettings(createDb(env.DB), [SETTING.telemetryNoticeAt]);
  return row.telemetry_notice_at === undefined;
}

/** The home page notice was dismissed, for every admin of this manager. */
export async function dismissNotice(env: TelemetryEnv, now: Date = new Date()): Promise<void> {
  const db = createDb(env.DB);
  const row = await readSettings(db, [SETTING.telemetryNoticeAt]);
  if (row.telemetry_notice_at !== undefined) return;
  await writeSettings(db, { [SETTING.telemetryNoticeAt]: now.toISOString() }, now);
}

/**
 * The rows a choice in Settings writes: the choice itself; the time the
 * notice was seen, if it was not recorded yet; and the install id when there
 * is none yet. A manager without one was set up before usage data existed,
 * so "setup completed" is never sent for it; nor is it once usage data is
 * turned off before the first report. Turning usage data back on moves the
 * job cursor to now, so jobs that ran while it was off are never reported.
 */
async function choiceRows(
  env: TelemetryEnv,
  enabled: boolean,
  now: Date,
): Promise<Partial<Record<SettingKey, string>>> {
  const current = await readSettings(createDb(env.DB), [
    SETTING.telemetry,
    SETTING.telemetryNoticeAt,
    SETTING.telemetryInstallId,
    SETTING.telemetrySetupSent,
  ]);
  const rows: Partial<Record<SettingKey, string>> = {
    [SETTING.telemetry]: enabled ? "on" : "off",
  };
  if (current.telemetry_notice_at === undefined) {
    rows[SETTING.telemetryNoticeAt] = now.toISOString();
  }
  const hasId = isInstallId(current.telemetry_install_id);
  if (!hasId) rows[SETTING.telemetryInstallId] = newInstallId(env);
  if (enabled && current.telemetry === "off") {
    rows[SETTING.telemetryCursor] = String(now.getTime());
  }
  if (current.telemetry_setup_sent === undefined && (!enabled || !hasId)) {
    rows[SETTING.telemetrySetupSent] = "skipped";
  }
  return rows;
}

/** Settings, Usage data: refused while a Worker variable turns usage data off. */
export async function setTelemetryEnabled(
  env: TelemetryEnv,
  enabled: boolean,
  now: Date = new Date(),
): Promise<TelemetryStatus> {
  const lock = lockOf(env);
  if (lock !== null) {
    throw new TelemetryLockedError(
      `Usage data is turned off by the ${lock} variable on this Worker. Remove the variable to change it here.`,
    );
  }
  await writeSettings(createDb(env.DB), await choiceRows(env, enabled, now), now);
  return readTelemetryStatus(env);
}

/** The UTC day this isolate last recorded an opening for. */
let openedMarkedDay: string | null = null;

/** Test-only: forget the memo. */
export function resetOpenedMemo(): void {
  openedMarkedDay = null;
}

/**
 * Records that the manager was opened today, for the daily "manager opened"
 * event. Called on every signed-in page load; once this isolate has written
 * today's row it skips the call, otherwise it runs one conditional upsert
 * that changes nothing when usage data is turned off or today is already
 * recorded. Only the day and the first opener's role are kept: no pages, no
 * users, no counts.
 */
export async function markOpenedToday(
  env: TelemetryEnv,
  role: "admin" | "member",
  now: number = Date.now(),
): Promise<void> {
  if (isDevBuild(env.APPFLARE_VERSION) || lockOf(env) !== null) return;
  const day = utcDay(now);
  if (openedMarkedDay === day) return;
  const result = await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at)
     SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = ?4 AND value = 'off')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE substr(settings.value, 1, 10) <> substr(excluded.value, 1, 10)`,
  )
    .bind(SETTING.telemetryOpenedDay, `${day} ${role}`, now, SETTING.telemetry)
    .run();
  // Only a real write settles the day: with usage data turned off (or the day
  // already recorded elsewhere), a later page load tries again.
  if (result.meta.changes > 0) openedMarkedDay = day;
}
