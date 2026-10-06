import type { FetchLike } from "@appflare/cf-api";
import {
  isInstallId,
  TELEMETRY_BATCH_URL,
  type TelemetryEvent,
  type TelemetryValue,
  telemetryBatchBody,
} from "@appflare/schema";
import { parseStoredCapabilities, resolveAccountPlan } from "../capabilities/capabilities";
import { DEFAULT_CATALOG_INDEX_URL } from "../catalog/index.server";
import { managerUpdateView, readManagerLatest } from "../catalog/manager-releases.server";
import { catalogLookup } from "../catalog/merged.server";
import { installAppKey, OFFICIAL_CATALOG_ID } from "../catalog/sources";
import { createDb } from "../db/client";
import { SCHEMA_VERSION_KEY } from "../db/migrate";
import { readSettings, SETTING, type SettingKey, writeSettings } from "../db/settings";
import { githubTokenCount } from "../github/tokens.server";
import { channelCounts } from "../notifications/channels.server";
import { sandboxBinding } from "../sandbox/binding";
import { runningVersion } from "../server/build-version";
import { hasAnyUser } from "../server/users.server";
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
import { lockOf, newInstallId, type TelemetryEnv, usageDataWithheld } from "./state.server";

/**
 * The usage-data report, sent by the cron. Everything is read from D1 and
 * the KV caches the cron has just refreshed, and sent in one `/batch/`
 * request, so jobs pay no subrequests for it and their code does not change.
 *
 * In order, and nothing is read before the earlier checks pass:
 * 1. a development build sends nothing;
 * 2. `APPFLARE_TELEMETRY=off` (or `DO_NOT_TRACK=1`) on the Worker sends nothing;
 * 3. before setup finished (no Cloudflare token, or no owner yet: setup
 *    stores the token first) nothing is sent;
 * 4. a stored `off` sends and writes nothing;
 * 5. otherwise (on, whether or not an admin ever chose): a manager without an
 *    install id (updated from a version without usage data) gets one first;
 *    then the heartbeat once per UTC day, every job start and end since
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
  SETTING.cfTokenConfigured,
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
  SETTING.autoUpdateApps,
  SETTING.autoUpdateManager,
] as const;

type ReportSettings = Partial<Record<(typeof REPORT_KEYS)[number], string>>;

function isOfficialCatalog(env: Pick<ReportEnv, "CATALOG_INDEX_URL">): boolean {
  const configured = env.CATALOG_INDEX_URL?.trim();
  return !configured || configured === DEFAULT_CATALOG_INDEX_URL;
}

/**
 * The latest version of every app the enabled catalogs list, by app key: an
 * official app under its plain slug (the only kind of slug ever sent), a
 * custom catalog's under `<catalog>:<slug>`, which is only compared with
 * its installs and never sent. Null when no catalog is cached.
 */
async function catalogVersions(env: ReportEnv): Promise<Map<string, string> | null> {
  const listed = await catalogLookup(env, { refreshOnMiss: false });
  return listed.size === 0 ? null : new Map([...listed].map(([key, l]) => [key, l.app.version]));
}

/** Reads the rows a heartbeat counts, in one D1 batch with any extra statements. */
function heartbeatStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare("SELECT value FROM settings WHERE key = ?1").bind(SCHEMA_VERSION_KEY),
    db.prepare(
      `SELECT count(*) AS users, min(created_at) AS first_user_at,
              coalesce(sum(CASE WHEN ',' || replace(coalesce(role, ''), ' ', '') || ',' LIKE '%,admin,%'
                           THEN 1 ELSE 0 END), 0) AS admins
       FROM user`,
    ),
    db.prepare("SELECT count(*) AS passkeys, count(DISTINCT user_id) AS users FROM passkey"),
    db.prepare(
      `SELECT app_slug, catalog_id, status, build_kind, catalog_version, updated_at, auto_update,
              (SELECT count(*) FROM resources r
               WHERE r.install_id = installs.id AND r.kind = 'worker' AND r.deleted_at IS NULL)
                AS workers
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
    // How many custom catalogs there are; never their URLs or labels.
    db.prepare("SELECT count(*) AS custom FROM catalogs WHERE kind = 'custom'"),
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
  const [schema, users, passkeys, installs, features, removed, catalogRows] = results.map(
    (r) => (r.results ?? []) as Record<string, unknown>[],
  );
  const feature = (kind: string) => num(features?.find((f) => f.kind === kind)?.installs);
  const latest = await readManagerLatest(env.KV);
  // Setup time: the earlier of the first user's creation (the first step of
  // setup) and `telemetry_notice_at`, which earlier versions wrote when an
  // admin answered a usage-data notice. Nothing writes it any more; a stored
  // one always comes after the first user, so it never moves setup forward.
  const setupTimes = [
    settings.telemetry_notice_at ? Date.parse(settings.telemetry_notice_at) : Number.NaN,
    num(users?.[0]?.first_user_at) || Number.NaN,
  ].filter((t) => !Number.isNaN(t));
  const setupAt = setupTimes.length > 0 ? Math.min(...setupTimes) : Number.NaN;
  return {
    now,
    managerVersion: runningVersion(env),
    schemaVersion: num(schema?.[0]?.value),
    accountPlan: reportedAccountPlan(settings),
    officialCatalog: isOfficialCatalog(env),
    setupAt: Number.isNaN(setupAt) ? null : setupAt,
    users: num(users?.[0]?.users),
    admins: num(users?.[0]?.admins),
    passkeys: num(passkeys?.[0]?.passkeys),
    passkeyUsers: num(passkeys?.[0]?.users),
    accessEnabled: settings.access_enabled_at !== undefined,
    sandboxConnected: sandboxBinding(env) !== undefined,
    managerBehindLatest: managerUpdateView(runningVersion(env), latest).updateAvailable,
    managerSelfUpdateAuto: settings.auto_update_manager === "on",
    autoUpdateDefault: settings.auto_update_apps === "on",
    customCatalogs: num(catalogRows?.[0]?.custom),
    installs: (installs ?? []).map((row) => ({
      // The app key: a custom catalog's app never passes for an official one.
      slug: installAppKey({
        app_slug: String(row.app_slug),
        catalog_id: typeof row.catalog_id === "string" ? row.catalog_id : null,
      }),
      fromCustomCatalog:
        typeof row.catalog_id === "string" && row.catalog_id !== OFFICIAL_CATALOG_ID,
      status: String(row.status),
      buildKind: String(row.build_kind),
      version: String(row.catalog_version),
      updatedAt: num(row.updated_at),
      autoUpdate: String(row.auto_update ?? "inherit"),
      workers: num(row.workers),
    })),
    catalogVersions: versions,
    installsWithDomain: feature("domain"),
    installsWithEmailRouting: feature("email_route"),
    installsWithCrons: feature("cron"),
    removedWithRetained: num(removed?.[0]?.installs),
    notificationChannels: await channelCounts(env.DB),
    githubTokens: await githubTokenCount(env.DB),
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
    catalogVersions(env),
  ]);
  const installId = isInstallId(settings.telemetry_install_id)
    ? settings.telemetry_install_id
    : null;
  const input = await heartbeatInput(env, results, settings, now, versions);
  const event = await heartbeatEvent(installId ?? "", input, managerBase(runningVersion(env)));
  return { distinct_id: installId, ...event };
}

function jobsStatement(db: D1Database, from: number, to: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT j.id, j.kind, j.status, j.input_json, j.error, j.started_at, j.finished_at,
              j.started_by,
              i.app_slug, i.catalog_id, i.catalog_version, i.build_kind, s.target_catalog_version,
              (SELECT count(*) FROM resources r
               WHERE r.install_id = j.install_id AND r.kind = 'worker') AS workers
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
    // The app key: a custom catalog's app is never reported under its slug.
    appSlug:
      typeof r.app_slug === "string"
        ? installAppKey({
            app_slug: r.app_slug,
            catalog_id: typeof r.catalog_id === "string" ? r.catalog_id : null,
          })
        : null,
    installVersion: typeof r.catalog_version === "string" ? r.catalog_version : null,
    buildKind: typeof r.build_kind === "string" ? r.build_kind : null,
    snapshotTargetVersion:
      typeof r.target_catalog_version === "string" ? r.target_catalog_version : null,
    startedBy: typeof r.started_by === "string" ? r.started_by : "admin",
    workers: num(r.workers) > 0 ? num(r.workers) : null,
  }));
}

/** The version this isolate last said it sends no usage data for. */
let withheldLoggedFor: string | null = null;

/** Test-only: forget which version the skip was logged for. */
export function resetWithheldLog(): void {
  withheldLoggedFor = null;
}

/**
 * Sends the report due now. Never throws: every failure is an outcome to log.
 * A development build or a pre-release sends nothing and reads nothing, and
 * says so in the Worker's log once (per isolate), not on every run.
 */
export async function reportTelemetry(
  env: ReportEnv,
  opts: ReportOptions = {},
): Promise<ReportOutcome> {
  const version = runningVersion(env);
  const withheld = usageDataWithheld(version);
  if (withheld !== null) {
    if (withheldLoggedFor !== version) {
      withheldLoggedFor = version;
      console.log(
        `usage data not sent: ${version} is a ${withheld}, and only released versions send usage data, so test managers stay out of the usage stats`,
      );
    }
    return { status: "skipped", reason: withheld };
  }
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
  if (settings.cf_token_configured !== "1" || !(await hasAnyUser(db))) {
    return { status: "skipped", reason: "setup not finished" };
  }
  if (settings.telemetry === "off") return { status: "skipped", reason: "turned off" };

  const now = (opts.now ?? Date.now)();
  let installId = settings.telemetry_install_id;
  if (!isInstallId(installId)) {
    // Set up before usage data existed (setup records the id): report from
    // now on under a new id. Its setup was long ago, so "setup completed" is
    // not sent, and jobs from before now are not reported.
    installId = newInstallId(env);
    const identity: Partial<Record<SettingKey, string>> = {
      [SETTING.telemetryInstallId]: installId,
    };
    if (settings.telemetry_setup_sent === undefined) {
      identity[SETTING.telemetrySetupSent] = "skipped";
    }
    if (settings.telemetry_cursor === undefined) {
      identity[SETTING.telemetryCursor] = String(now);
    }
    await writeSettings(db, identity, new Date(now));
    Object.assign(settings, identity);
  }

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
  const [results, versions] = await Promise.all([env.DB.batch(statements), catalogVersions(env)]);
  const [jobs, ...rest] = results;
  const firstAdmin = setupDue ? rest.shift() : undefined;

  const base = managerBase(runningVersion(env));
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
    // Setup ends with whichever step came last: the token (managers set up
    // admin first) or the owner (token first).
    const at = Number.isNaN(verifiedAt) ? now : Math.max(verifiedAt, adminAt);
    events.push({
      event: EVENT.setupCompleted,
      timestamp: new Date(at).toISOString(),
      uuid: await uuidV5(`${installId}:${EVENT.setupCompleted}`),
      properties: {
        ...base,
        setup_minutes:
          adminAt > 0 && !Number.isNaN(verifiedAt)
            ? Math.round(Math.abs(verifiedAt - adminAt) / 60_000)
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
