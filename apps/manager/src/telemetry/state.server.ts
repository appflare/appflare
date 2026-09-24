import { isInstallId, type TelemetryLock, telemetryLock } from "@appflare/schema";
import { createDb } from "../db/client";
import { readSettings, SETTING, type SettingKey, writeSettings } from "../db/settings";
import { utcDay } from "./events";
import type { AcknowledgeNoticeInput, TelemetryStatus } from "./telemetry";

/**
 * The stored usage-data choice and the Worker variables that override it.
 * Reads and writes `settings` rows only; the cron's report lives in
 * report.server.ts.
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

export async function readTelemetryStatus(env: TelemetryEnv): Promise<TelemetryStatus> {
  const row = await readSettings(createDb(env.DB), [SETTING.telemetry]);
  const stored = row.telemetry;
  return {
    state: stored === "on" || stored === "off" ? stored : "unset",
    lockedBy: lockOf(env),
    devBuild: isDevBuild(env.APPFLARE_VERSION),
  };
}

/**
 * The rows that record a choice: the choice itself, and on the first one the
 * time the notice was seen and the install id (the CLI's when it deployed a
 * valid one, so its events and the manager's join up). Turning usage data on
 * moves the job cursor to now, so jobs from before are never reported.
 */
async function choiceRows(
  env: TelemetryEnv,
  enabled: boolean,
  now: Date,
  sendSetupCompleted: boolean,
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
  if (!isInstallId(current.telemetry_install_id)) {
    rows[SETTING.telemetryInstallId] = isInstallId(env.APPFLARE_INSTALL_ID)
      ? env.APPFLARE_INSTALL_ID
      : crypto.randomUUID();
  }
  if (enabled && current.telemetry !== "on") {
    rows[SETTING.telemetryCursor] = String(now.getTime());
  }
  if (current.telemetry_setup_sent === undefined && !(enabled && sendSetupCompleted)) {
    rows[SETTING.telemetrySetupSent] = "skipped";
  }
  return rows;
}

/**
 * An admin saw the notice (the setup step, or the home page notice after an
 * update from a version without usage data) and chose. Only a choice made in
 * the setup step reports "manager setup completed". With a Worker variable
 * turning usage data off, the choice is recorded as off.
 */
export async function acknowledgeNotice(
  env: TelemetryEnv,
  input: AcknowledgeNoticeInput,
  now: Date = new Date(),
): Promise<TelemetryStatus> {
  const enabled = input.enabled && lockOf(env) === null;
  await writeSettings(
    createDb(env.DB),
    await choiceRows(env, enabled, now, input.via === "setup"),
    now,
  );
  return readTelemetryStatus(env);
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
  await writeSettings(createDb(env.DB), await choiceRows(env, enabled, now, false), now);
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
 * that changes nothing unless usage data is on and today is not recorded yet. Only the day and the first opener's role are
 * kept: no pages, no users, no counts.
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
     SELECT ?1, ?2, ?3 WHERE EXISTS (SELECT 1 FROM settings WHERE key = ?4 AND value = 'on')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE substr(settings.value, 1, 10) <> substr(excluded.value, 1, 10)`,
  )
    .bind(SETTING.telemetryOpenedDay, `${day} ${role}`, now, SETTING.telemetry)
    .run();
  // Only a real write settles the day: with usage data not on yet (or the day
  // already recorded elsewhere), a later page load tries again.
  if (result.meta.changes > 0) openedMarkedDay = day;
}
