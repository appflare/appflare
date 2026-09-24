import type { FetchLike } from "@appflare/cf-api";
import {
  isInstallId,
  TELEMETRY_BATCH_URL,
  type TelemetryEvent,
  type TelemetryValue,
  telemetryBatchBody,
} from "@appflare/schema";
import { parseStoredCapabilities, resolveAccountPlan } from "../capabilities/capabilities";
import { DEFAULT_CATALOG_INDEX_URL, readCachedCatalogIndex } from "../catalog/index.server";
import { managerUpdateView, readManagerLatest } from "../catalog/manager-releases.server";
import { createDb } from "../db/client";
import { SCHEMA_VERSION_KEY } from "../db/migrate";
import { readSettings, SETTING, type SettingKey, writeSettings } from "../db/settings";
import { channelCounts } from "../notifications/channels.server";
import { sandboxBinding } from "../sandbox/binding";
import {
  EVENT,
  type HeartbeatInput,
  heartbeatProperties,
  type JobRow,
  jobEvents,
  managerBase,
  utcDay,
  uuidV5,
} from "./events";
import { isDevBuild, lockOf, type TelemetryEnv } from "./state.server";

/**
 * The usage-data report, sent by the cron. Everything is read from D1 and
 * the KV caches the cron has just refreshed, and sent in one `/batch/`
 * request, so jobs pay no subrequests for it and their code does not change.
 *
 * In order, and nothing is read before the earlier checks pass:
 * 1. a development build sends nothing;
 * 2. `APPFLARE_TELEMETRY=off` (or `DO_NOT_TRACK=1`) on the Worker sends nothing;
 * 3. no stored choice (no admin has seen the notice) sends nothing;
 * 4. a stored `off` sends and writes nothing;
 * 5. otherwise: the heartbeat once per UTC day, every job start and end since
 *    the cursor, the last day the manager was opened, and "setup completed"
 *    once. The cursors move only when PostHog accepted the batch, so a failed
 *    send is retried by the next run; anything older than 7 days, or beyond
 *    the newest 500 events, is dropped.
 */

export interface ReportEnv extends TelemetryEnv {
  KV: KVNamespace;
  CATALOG_INDEX_URL?: string;
  SANDBOX?: unknown;
}

export interface ReportOptions {
  fetch?: FetchLike;
  now?: () => number;
}

export type ReportOutcome =
  | { status: "skipped"; reason: string }
  | { status: "sent"; events: number }
  | { status: "failed"; reason: string };

/** Nothing older than this is reported. */
export const BACKLOG_MS = 7 * 86_400_000;
/**
 * How far behind the run's time the job cursor is stored. A job row written
 * just before the read but committed after it is then read again by the next
 * run; its events carry the same uuids and timestamps, so PostHog drops any
 * copy.
 */
export const CURSOR_LAG_MS = 15_000;
/** At most this many events per report; the oldest are dropped. */
export const MAX_EVENTS = 500;

const REPORT_KEYS = [
  SETTING.telemetry,
  SETTING.telemetryNoticeAt,
  SETTING.telemetryInstallId,
  SETTING.telemetryCursor,
  SETTING.telemetryHeartbeatDay,
  SETTING.telemetryOpenedDay,
  SETTING.telemetryOpenedSentDay,
  SETTING.telemetrySetupSent,
  SETTING.accountPlan,
  SETTING.accountCapabilities,
  SETTING.accessEnabledAt,
  SETTING.cfTokenVerifiedAt,
] as const;

type ReportSettings = Partial<Record<(typeof REPORT_KEYS)[number], string>>;

function isOfficialCatalog(env: Pick<ReportEnv, "CATALOG_INDEX_URL">): boolean {
  const configured = env.CATALOG_INDEX_URL?.trim();
  return !configured || configured === DEFAULT_CATALOG_INDEX_URL;
}

async function catalogVersions(kv: KVNamespace): Promise<Map<string, string> | null> {
  const index = await readCachedCatalogIndex(kv);
  return index === null ? null : new Map(index.apps.map((a) => [a.slug, a.version]));
}

/** Reads the rows a heartbeat counts, in one D1 batch with any extra statements. */
function heartbeatStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare("SELECT value FROM settings WHERE key = ?1").bind(SCHEMA_VERSION_KEY),
    db.prepare(
      `SELECT count(*) AS users,
              coalesce(sum(CASE WHEN ',' || replace(coalesce(role, ''), ' ', '') || ',' LIKE '%,admin,%'
                           THEN 1 ELSE 0 END), 0) AS admins
       FROM user`,
    ),
    db.prepare("SELECT count(*) AS passkeys, count(DISTINCT user_id) AS users FROM passkey"),
    db.prepare(
      `SELECT app_slug, status, build_kind, catalog_version, updated_at
       FROM installs WHERE status <> 'uninstalled'`,
    ),
    db.prepare(
      `SELECT r.kind AS kind, count(DISTINCT r.install_id) AS installs
       FROM resources r JOIN installs i ON i.id = r.install_id
       WHERE i.status <> 'uninstalled' AND r.deleted_at IS NULL
         AND r.kind IN ('domain', 'email_route', 'cron')
       GROUP BY r.kind`,
    ),
    db.prepare(
      `SELECT count(DISTINCT r.install_id) AS installs
       FROM resources r JOIN installs i ON i.id = r.install_id
       WHERE i.status = 'uninstalled' AND r.retained_at IS NOT NULL AND r.deleted_at IS NULL`,
    ),
  ];
}

/**
 * The plan in force, as installs and updates read it: detected by the
 * capability probes first, else what an admin set. Undefined (reported as
 * "unset") when neither exists.
 */
function reportedAccountPlan(settings: ReportSettings): string | undefined {
  const resolved = resolveAccountPlan(
    settings.account_plan,
    parseStoredCapabilities(settings.account_capabilities),
  );
  return resolved.source === "default" ? undefined : resolved.plan;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

async function heartbeatInput(
  env: ReportEnv,
  results: D1Result[],
  settings: ReportSettings,
  now: number,
  versions: Map<string, string> | null,
): Promise<HeartbeatInput> {
  const [schema, users, passkeys, installs, features, removed] = results.map(
    (r) => (r.results ?? []) as Record<string, unknown>[],
  );
  const feature = (kind: string) => num(features?.find((f) => f.kind === kind)?.installs);
  const latest = await readManagerLatest(env.KV);
  const noticeAt = settings.telemetry_notice_at
    ? Date.parse(settings.telemetry_notice_at)
    : Number.NaN;
  return {
    now,
    managerVersion: env.APPFLARE_VERSION,
    schemaVersion: num(schema?.[0]?.value),
    accountPlan: reportedAccountPlan(settings),
    officialCatalog: isOfficialCatalog(env),
    noticeAt: Number.isNaN(noticeAt) ? null : noticeAt,
    users: num(users?.[0]?.users),
    admins: num(users?.[0]?.admins),
    passkeys: num(passkeys?.[0]?.passkeys),
    passkeyUsers: num(passkeys?.[0]?.users),
    accessEnabled: settings.access_enabled_at !== undefined,
    sandboxConnected: sandboxBinding(env) !== undefined,
    managerBehindLatest: managerUpdateView(env.APPFLARE_VERSION, latest).updateAvailable,
    installs: (installs ?? []).map((row) => ({
      slug: String(row.app_slug),
      status: String(row.status),
      buildKind: String(row.build_kind),
      version: String(row.catalog_version),
      updatedAt: num(row.updated_at),
    })),
    catalogVersions: versions,
    installsWithDomain: feature("domain"),
    installsWithEmailRouting: feature("email_route"),
    installsWithCrons: feature("cron"),
    removedWithRetained: num(removed?.[0]?.installs),
    notificationChannels: await channelCounts(env.DB),
  };
}

async function heartbeatEvent(
  installId: string,
  input: HeartbeatInput,
  base: Record<string, TelemetryValue>,
): Promise<TelemetryEvent> {
  return {
    event: EVENT.heartbeat,
    // Midnight UTC of the reported day, so a batch resent after a lost reply
    // carries the same uuid and timestamp and PostHog drops the copy.
    timestamp: `${utcDay(input.now)}T00:00:00.000Z`,
    uuid: await uuidV5(`${installId}:${EVENT.heartbeat}:${utcDay(input.now)}`),
    properties: { ...base, ...heartbeatProperties(input) },
  };
}

/** The next heartbeat, built live the way the cron builds it (Settings' preview). */
export async function previewHeartbeat(
  env: ReportEnv,
  now: number = Date.now(),
): Promise<{ distinct_id: string | null } & TelemetryEvent> {
  const settings: ReportSettings = await readSettings(createDb(env.DB), REPORT_KEYS);
  const [results, versions] = await Promise.all([
    env.DB.batch(heartbeatStatements(env.DB)),
    catalogVersions(env.KV),
  ]);
  const installId = isInstallId(settings.telemetry_install_id)
    ? settings.telemetry_install_id
    : null;
  const input = await heartbeatInput(env, results, settings, now, versions);
  const event = await heartbeatEvent(installId ?? "", input, managerBase(env.APPFLARE_VERSION));
  return { distinct_id: installId, ...event };
}

function jobsStatement(db: D1Database, from: number, to: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT j.id, j.kind, j.status, j.input_json, j.error, j.started_at, j.finished_at,
              i.app_slug, i.catalog_version, i.build_kind, s.target_catalog_version
       FROM jobs j
       LEFT JOIN installs i ON i.id = j.install_id
       LEFT JOIN snapshots s ON j.kind = 'rollback' AND json_valid(j.input_json)
         AND s.id = json_extract(j.input_json, '$.snapshotId')
       WHERE (j.started_at > ?1 AND j.started_at <= ?2)
          OR (j.finished_at > ?1 AND j.finished_at <= ?2)
       ORDER BY coalesce(j.finished_at, j.started_at) DESC
       LIMIT ?3`,
    )
    .bind(from, to, MAX_EVENTS);
}

function jobRows(result: D1Result | undefined): JobRow[] {
  return ((result?.results ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    status: String(r.status),
    inputJson: typeof r.input_json === "string" ? r.input_json : null,
    error: typeof r.error === "string" ? r.error : null,
    startedAt: r.started_at == null ? null : num(r.started_at),
    finishedAt: r.finished_at == null ? null : num(r.finished_at),
    appSlug: typeof r.app_slug === "string" ? r.app_slug : null,
    installVersion: typeof r.catalog_version === "string" ? r.catalog_version : null,
    buildKind: typeof r.build_kind === "string" ? r.build_kind : null,
    snapshotTargetVersion:
      typeof r.target_catalog_version === "string" ? r.target_catalog_version : null,
  }));
}

/** Sends the report due now. Never throws: every failure is an outcome to log. */
export async function reportTelemetry(
  env: ReportEnv,
  opts: ReportOptions = {},
): Promise<ReportOutcome> {
  if (isDevBuild(env.APPFLARE_VERSION)) return { status: "skipped", reason: "development build" };
  const lock = lockOf(env);
  if (lock !== null) return { status: "skipped", reason: `turned off by ${lock}` };
  try {
    return await report(env, opts);
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function report(env: ReportEnv, opts: ReportOptions): Promise<ReportOutcome> {
  const db = createDb(env.DB);
  const settings: ReportSettings = await readSettings(db, REPORT_KEYS);
  if (settings.telemetry === undefined) return { status: "skipped", reason: "notice not seen" };
  if (settings.telemetry !== "on") return { status: "skipped", reason: "turned off" };
  const installId = settings.telemetry_install_id;
  if (!isInstallId(installId)) return { status: "skipped", reason: "no install id" };

  const now = (opts.now ?? Date.now)();
  const today = utcDay(now);
  const oldest = now - BACKLOG_MS;
  const storedCursor = Number(settings.telemetry_cursor);
  const cursor =
    Number.isFinite(storedCursor) && settings.telemetry_cursor !== undefined
      ? Math.max(storedCursor, oldest)
      : now;
  const heartbeatDue = settings.telemetry_heartbeat_day !== today;
  const setupDue = settings.telemetry_setup_sent === undefined;

  const statements = [
    jobsStatement(env.DB, cursor, now),
    ...(setupDue
      ? [
          env.DB.prepare(
            `SELECT min(created_at) AS at FROM user
             WHERE ',' || replace(coalesce(role, ''), ' ', '') || ',' LIKE '%,admin,%'`,
          ),
        ]
      : []),
    ...(heartbeatDue ? heartbeatStatements(env.DB) : []),
  ];
  const [results, versions] = await Promise.all([
    env.DB.batch(statements),
    catalogVersions(env.KV),
  ]);
  const [jobs, ...rest] = results;
  const firstAdmin = setupDue ? rest.shift() : undefined;

  const base = managerBase(env.APPFLARE_VERSION);
  const official = isOfficialCatalog(env);
  const events = await jobEvents(
    jobRows(jobs),
    { from: cursor, to: now },
    base,
    installId,
    official,
    versions,
  );
  if (heartbeatDue) {
    events.push(
      await heartbeatEvent(
        installId,
        await heartbeatInput(env, rest, settings, now, versions),
        base,
      ),
    );
  }

  const [openedDay, openedRole] = (settings.telemetry_opened_day ?? "").split(" ");
  const openedDue =
    openedDay !== undefined &&
    /^\d{4}-\d{2}-\d{2}$/.test(openedDay) &&
    openedDay > (settings.telemetry_opened_sent_day ?? "") &&
    openedDay >= utcDay(oldest);
  if (openedDue) {
    events.push({
      event: EVENT.opened,
      timestamp: `${openedDay}T00:00:00.000Z`,
      uuid: await uuidV5(`${installId}:${EVENT.opened}:${openedDay}`),
      properties: { ...base, day: openedDay, role: openedRole === "admin" ? "admin" : "member" },
    });
  }

  if (setupDue) {
    const adminAt = num((firstAdmin?.results?.[0] as Record<string, unknown> | undefined)?.at);
    const verifiedAt = settings.cf_token_verified_at
      ? Date.parse(settings.cf_token_verified_at)
      : Number.NaN;
    const at = Number.isNaN(verifiedAt) ? now : verifiedAt;
    events.push({
      event: EVENT.setupCompleted,
      timestamp: new Date(at).toISOString(),
      uuid: await uuidV5(`${installId}:${EVENT.setupCompleted}`),
      properties: {
        ...base,
        setup_minutes:
          adminAt > 0 && !Number.isNaN(verifiedAt)
            ? Math.max(0, Math.round((verifiedAt - adminAt) / 60_000))
            : null,
        cli_install_id_used: env.APPFLARE_INSTALL_ID === installId,
      },
    });
  }

  const moved: Partial<Record<SettingKey, string>> = {
    [SETTING.telemetryCursor]: String(Math.max(cursor, now - CURSOR_LAG_MS)),
  };
  if (events.length === 0) {
    // Nothing to send; record the cursor only when there was none.
    if (settings.telemetry_cursor === undefined) await writeSettings(db, moved, new Date(now));
    return { status: "sent", events: 0 };
  }

  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const batch = events.slice(-MAX_EVENTS);
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(TELEMETRY_BATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(telemetryBatchBody(installId, batch)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return {
      status: "failed",
      reason: `could not reach PostHog: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  await response.body?.cancel();
  if (!response.ok) return { status: "failed", reason: `PostHog answered HTTP ${response.status}` };

  if (heartbeatDue) moved[SETTING.telemetryHeartbeatDay] = today;
  if (openedDue && openedDay !== undefined) moved[SETTING.telemetryOpenedSentDay] = openedDay;
  if (setupDue) moved[SETTING.telemetrySetupSent] = "1";
  await writeSettings(db, moved, new Date(now));
  return { status: "sent", events: batch.length };
}
