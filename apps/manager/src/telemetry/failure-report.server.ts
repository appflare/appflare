import type { FetchLike } from "@appflare/cf-api";
import {
  isInstallId,
  TELEMETRY_BATCH_URL,
  type TelemetryValue,
  telemetryBatchBody,
} from "@appflare/schema";
import { parseStoredCapabilities, resolveAccountPlan } from "../capabilities/capabilities";
import { DEFAULT_CATALOG_INDEX_URL } from "../catalog/index.server";
import { installAppKey } from "../catalog/sources";
import { plainMessage } from "../components/message-links";
import { createDb } from "../db/client";
import { readSettings, SETTING, type SettingKey, writeSettings } from "../db/settings";
import { classifyJobError, cloudflareErrorCodes, splitJobError } from "./classify";
import { type JobRow, jobKind, jobProperties, managerBase, uuidV5 } from "./events";
import {
  FAILURE_REPORT_COPY,
  FAILURE_REPORT_EVENT,
  type FailureReportEvent,
  type FailureReportPreview,
  type ReportLogLine,
  reportLog,
  withNote,
} from "./failure-report";
import { type AccountNames, redactReportText } from "./redact";
import { isDevBuild, lockOf, newInstallId, type TelemetryEnv } from "./state.server";

/**
 * Failure reports: reads a failed job, builds the report the dialog shows,
 * and sends it through the usage-data pipeline (PostHog EU `/batch/`) when
 * an admin asks. Sent whether or not usage data is on, since the admin
 * chose to; never from a development build; at most once per job, which
 * `jobs.reported_at` records.
 */

export interface FailureReportEnv extends TelemetryEnv {
  CATALOG_INDEX_URL?: string;
}

export interface FailureReportOptions {
  fetch?: FetchLike;
  now?: () => number;
  /**
   * The install id the preview showed, used when the manager has none
   * stored yet (a random id is not the same twice).
   */
  proposedInstallId?: string;
}

export class FailureReportError extends Error {
  override name = "FailureReportError";
}

export type SendOutcome =
  | { status: "sent"; reportedAt: string }
  | { status: "already_sent"; reportedAt: string };

const REPORT_SETTINGS = [
  SETTING.telemetry,
  SETTING.telemetryInstallId,
  SETTING.telemetrySetupSent,
  SETTING.telemetryCursor,
  SETTING.accountPlan,
  SETTING.accountCapabilities,
  SETTING.accountSubdomain,
  SETTING.workerName,
] as const;

type ReportSettings = Partial<Record<(typeof REPORT_SETTINGS)[number], string>>;

interface FailedJob {
  row: JobRow;
  reportedAt: number | null;
  logs: ReportLogLine[];
  /** Hostnames and Worker names recorded anywhere in this manager. */
  hostnames: string[];
  workers: string[];
}

/** Resource kinds whose name is (or starts with) a hostname. */
const HOSTNAME_KINDS = [
  "domain",
  "custom_hostname",
  "wildcard_domain",
  "dns_record",
  "worker_route",
] as const;

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0) || 0;
}

async function readFailedJob(db: D1Database, jobId: string): Promise<FailedJob | null> {
  const [jobs, logs, hostnames, workers] = await db.batch([
    db
      .prepare(
        `SELECT j.id, j.kind, j.status, j.input_json, j.error, j.started_at, j.finished_at,
                j.started_by, j.reported_at,
                i.app_slug, i.catalog_id, i.catalog_version, i.build_kind, s.target_catalog_version,
                (SELECT count(*) FROM resources r
                 WHERE r.install_id = j.install_id AND r.kind = 'worker') AS workers
         FROM jobs j
         LEFT JOIN installs i ON i.id = j.install_id
         LEFT JOIN snapshots s ON j.kind = 'rollback' AND json_valid(j.input_json)
           AND s.id = json_extract(j.input_json, '$.snapshotId')
         WHERE j.id = ?1`,
      )
      .bind(jobId),
    db
      .prepare("SELECT ts, level, message, data_json FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(jobId),
    db.prepare(
      `SELECT name FROM resources WHERE kind IN (${HOSTNAME_KINDS.map((k) => `'${k}'`).join(", ")})
       UNION SELECT served_domain FROM installs WHERE served_domain IS NOT NULL`,
    ),
    db.prepare(
      `SELECT worker_name AS name FROM installs
       UNION SELECT name FROM resources WHERE kind = 'worker'`,
    ),
  ]);
  const names = (result: D1Result | undefined) =>
    ((result?.results ?? []) as Record<string, unknown>[])
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
  const r = (jobs?.results ?? [])[0] as Record<string, unknown> | undefined;
  if (r === undefined) return null;
  return {
    row: {
      id: String(r.id),
      kind: String(r.kind),
      status: String(r.status),
      inputJson: typeof r.input_json === "string" ? r.input_json : null,
      // Errors and log lines can carry links to manager pages; the report is read elsewhere.
      error: typeof r.error === "string" ? plainMessage(r.error) : null,
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
    },
    reportedAt: r.reported_at == null ? null : num(r.reported_at),
    logs: ((logs?.results ?? []) as Record<string, unknown>[]).map((l) => ({
      ts: num(l.ts),
      level: String(l.level),
      message: plainMessage(String(l.message)),
      dataJson: typeof l.data_json === "string" ? l.data_json : null,
    })),
    hostnames: names(hostnames),
    workers: names(workers),
  };
}

function isOfficialCatalog(env: Pick<FailureReportEnv, "CATALOG_INDEX_URL">): boolean {
  const configured = env.CATALOG_INDEX_URL?.trim();
  return !configured || configured === DEFAULT_CATALOG_INDEX_URL;
}

/** The plan in force as installs read it; `unset` when neither detected nor chosen. */
function reportedPlan(settings: ReportSettings): "free" | "paid" | "unset" {
  const resolved = resolveAccountPlan(
    settings.account_plan,
    parseStoredCapabilities(settings.account_capabilities),
  );
  return resolved.source === "default" ? "unset" : resolved.plan;
}

/** Usage data is off for this manager: by the switch, or by a Worker variable. */
function usageDataOff(env: FailureReportEnv, settings: ReportSettings): boolean {
  return lockOf(env) !== null || settings.telemetry === "off";
}

/** This account's names, which every text of the report has taken out. */
function accountNamesOf(settings: ReportSettings, job: FailedJob): AccountNames {
  return {
    subdomain: settings.account_subdomain || null,
    hostnames: job.hostnames,
    workers: settings.worker_name ? [...job.workers, settings.worker_name] : job.workers,
  };
}

/**
 * The install id every usage-data event is tied to, so a report joins the
 * manager's other events. A manager that has none yet reports under a new
 * one: the one the preview showed, when the dialog passes it back, so the
 * report sent is the report shown. It is stored only once a report is sent.
 */
function reportInstallId(
  env: FailureReportEnv,
  settings: ReportSettings,
  proposed: string | undefined,
): { installId: string; stored: boolean } {
  if (isInstallId(settings.telemetry_install_id)) {
    return { installId: settings.telemetry_install_id, stored: true };
  }
  return { installId: isInstallId(proposed) ? proposed : newInstallId(env), stored: false };
}

/**
 * Stores a new install id the way the scheduled report would: with "setup
 * completed" marked as skipped and the job cursor at now, so neither setup
 * nor earlier jobs are reported later.
 */
async function storeInstallId(
  env: FailureReportEnv,
  settings: ReportSettings,
  installId: string,
  now: number,
): Promise<void> {
  const rows: Partial<Record<SettingKey, string>> = { [SETTING.telemetryInstallId]: installId };
  if (settings.telemetry_setup_sent === undefined) rows[SETTING.telemetrySetupSent] = "skipped";
  if (settings.telemetry_cursor === undefined) rows[SETTING.telemetryCursor] = String(now);
  await writeSettings(createDb(env.DB), rows, new Date(now));
}

/** The report's properties. Pure: everything is read beforehand. */
export function failureReportProperties(input: {
  job: FailedJob;
  names: AccountNames;
  managerVersion: string;
  plan: "free" | "paid" | "unset";
  usageDataOff: boolean;
  officialCatalog: boolean;
}): Record<string, TelemetryValue> {
  const { row } = input.job;
  const failure = classifyJobError(row.error);
  const { step } = splitJobError(row.error);
  const { log, truncated } = reportLog(input.job.logs, input.names);
  const codes = cloudflareErrorCodes([
    row.error ?? "",
    ...input.job.logs.flatMap((l) => [l.message, l.dataJson ?? ""]),
  ]);
  return {
    ...managerBase(input.managerVersion),
    ...jobProperties(row, input.officialCatalog, null),
    account_plan: input.plan,
    usage_data: input.usageDataOff ? "off" : "on",
    duration_s:
      row.startedAt === null || row.finishedAt === null
        ? null
        : Math.max(0, Math.round((row.finishedAt - row.startedAt) / 1000)),
    error_category: failure.errorCategory,
    failed_phase: failure.failedPhase,
    failed_step: step.length > 0 ? redactReportText(step, input.names) : null,
    error: row.error === null ? null : redactReportText(row.error, input.names),
    cf_status: failure.cfStatus,
    cf_code: failure.cfCode,
    cf_codes: codes.map(String),
    log,
    log_truncated: truncated,
    note: null,
  };
}

async function buildPreview(
  env: FailureReportEnv,
  job: FailedJob,
  settings: ReportSettings,
  installId: string,
): Promise<FailureReportPreview> {
  const off = usageDataOff(env, settings);
  const plan = reportedPlan(settings);
  const names = accountNamesOf(settings, job);
  const properties = failureReportProperties({
    job,
    names,
    managerVersion: env.APPFLARE_VERSION,
    plan,
    usageDataOff: off,
    officialCatalog: isOfficialCatalog(env),
  });
  const { row } = job;
  const at = row.finishedAt ?? row.startedAt ?? 0;
  const event: FailureReportEvent = {
    event: FAILURE_REPORT_EVENT,
    // Deterministic, so a report resent after a lost reply is dropped as a copy.
    uuid: await uuidV5(`${installId}:${FAILURE_REPORT_EVENT}:${row.id}`),
    timestamp: new Date(at).toISOString(),
    distinct_id: installId,
    properties: { ...properties, distinct_id: installId },
  };
  const log = properties.log as readonly string[];
  const kind = jobKind(row);
  return {
    jobId: row.id,
    reportedAt: job.reportedAt === null ? null : new Date(job.reportedAt).toISOString(),
    usageDataOff: off,
    devBuild: isDevBuild(env.APPFLARE_VERSION),
    summary: {
      kind: row.kind,
      restore: kind === "restore",
      deleteRetained: kind === "delete_retained",
      app: typeof properties.slug === "string" ? properties.slug : null,
      version: typeof properties.catalog_version === "string" ? properties.catalog_version : null,
      managerVersion: env.APPFLARE_VERSION,
      plan,
      cloudflareCodes: (properties.cf_codes as readonly string[]).map(Number),
      failedStep: typeof properties.failed_step === "string" ? properties.failed_step : null,
      logLines: log.length,
      logTruncated: properties.log_truncated === true,
    },
    event,
    accountNames: names,
  };
}

/** Reads the failed job and the settings a report needs. Writes nothing. */
async function load(
  env: FailureReportEnv,
  jobId: string,
): Promise<{ job: FailedJob; settings: ReportSettings }> {
  const [job, settings] = await Promise.all([
    readFailedJob(env.DB, jobId),
    readSettings(createDb(env.DB), REPORT_SETTINGS) as Promise<ReportSettings>,
  ]);
  if (job === null) throw new FailureReportError("There is no such job.");
  if (job.row.status !== "failed") {
    throw new FailureReportError("Only a job that failed can be reported.");
  }
  return { job, settings };
}

/**
 * What the dialog shows: the report exactly as it would be sent, without a
 * note. Reads only; nothing is stored until a report is sent.
 */
export async function previewFailureReport(
  env: FailureReportEnv,
  jobId: string,
): Promise<FailureReportPreview> {
  const { job, settings } = await load(env, jobId);
  const { installId } = reportInstallId(env, settings, undefined);
  return buildPreview(env, job, settings, installId);
}

/**
 * Sends the report of a failed job, once. The report is built first; then
 * the job is marked reported, so two clicks never send two reports; when
 * PostHog cannot be reached or refuses it, the mark is taken back and the
 * admin can try again. A new install id is stored only once PostHog took
 * the report.
 */
export async function sendFailureReport(
  env: FailureReportEnv,
  jobId: string,
  note: string,
  opts: FailureReportOptions = {},
): Promise<SendOutcome> {
  if (isDevBuild(env.APPFLARE_VERSION)) throw new FailureReportError(FAILURE_REPORT_COPY.devBuild);
  const now = (opts.now ?? Date.now)();
  const { job, settings } = await load(env, jobId);
  if (job.reportedAt !== null) {
    return { status: "already_sent", reportedAt: new Date(job.reportedAt).toISOString() };
  }
  const { installId, stored } = reportInstallId(env, settings, opts.proposedInstallId);
  const preview = await buildPreview(env, job, settings, installId);
  const { distinct_id: _id, ...event } = withNote(preview.event, note, preview.accountNames);
  const body = JSON.stringify(telemetryBatchBody(installId, [event]));

  const claim = await env.DB.prepare(
    "UPDATE jobs SET reported_at = ?1 WHERE id = ?2 AND status = 'failed' AND reported_at IS NULL",
  )
    .bind(now, jobId)
    .run();
  if (claim.meta.changes === 0) {
    const current = await env.DB.prepare("SELECT reported_at FROM jobs WHERE id = ?1")
      .bind(jobId)
      .first<{ reported_at: number | null }>();
    if (current?.reported_at != null) {
      return { status: "already_sent", reportedAt: new Date(current.reported_at).toISOString() };
    }
    throw new FailureReportError("Only a job that failed can be reported.");
  }

  const release = () =>
    env.DB.prepare("UPDATE jobs SET reported_at = NULL WHERE id = ?1 AND reported_at = ?2")
      .bind(jobId, now)
      .run();
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(TELEMETRY_BATCH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    await release();
    throw new FailureReportError(FAILURE_REPORT_COPY.sendFailed);
  }
  await response.body?.cancel();
  if (!response.ok) {
    await release();
    throw new FailureReportError(FAILURE_REPORT_COPY.sendFailed);
  }
  if (!stored) await storeInstallId(env, settings, installId, now);
  return { status: "sent", reportedAt: new Date(now).toISOString() };
}
