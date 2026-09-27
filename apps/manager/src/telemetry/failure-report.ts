import type { TelemetryValue } from "@appflare/schema";
import { type AccountNames, NO_ACCOUNT_NAMES, redactReportText } from "./redact";

/**
 * A failure report: when a job fails, an admin may send the Appflare team
 * what went wrong, after seeing exactly what is sent. Client-safe (no
 * bindings); the server side reads and sends in failure-report.server.ts.
 *
 * Unlike usage data, a report carries text: the job's log and error, with
 * every private-looking value removed (redact.ts), and an optional note.
 * It is sent only when an admin asks, at most once per job, whether or not
 * usage data is on.
 */

/** The PostHog event a report is sent as. */
export const FAILURE_REPORT_EVENT = "job_failure_report";

/** The longest note an admin can add. */
export const NOTE_MAX_LENGTH = 2000;
/** At most this many log lines are sent, the last ones (the failure is at the end). */
export const LOG_MAX_LINES = 400;
/** At most this many bytes (UTF-8) of log are sent. */
export const LOG_MAX_BYTES = 60_000;

/** One item of the `/batch/` request, exactly as it is sent. */
export interface FailureReportEvent {
  event: typeof FAILURE_REPORT_EVENT;
  uuid: string;
  /** When the job failed (so the event is the same whether it is previewed or sent). */
  timestamp: string;
  distinct_id: string;
  properties: Record<string, TelemetryValue>;
}

/** What the "Send a report" dialog shows before anything is sent. */
export interface FailureReportPreview {
  jobId: string;
  /** When the report was sent (ISO 8601); null while it has not been. */
  reportedAt: string | null;
  /** Usage data is off (by the switch or a Worker variable); the report is still sent. */
  usageDataOff: boolean;
  /** A development build never sends reports. */
  devBuild: boolean;
  /** The plain-language summary shown first. */
  summary: {
    kind: string;
    restore: boolean;
    deleteRetained: boolean;
    /** The app as reported: a catalog slug, `custom`, or `appflare` for Appflare itself. */
    app: string | null;
    version: string | null;
    managerVersion: string;
    plan: "free" | "paid" | "unset";
    cloudflareCodes: number[];
    failedStep: string | null;
    logLines: number;
    logTruncated: boolean;
  };
  /** The event with no note; {@link withNote} adds the admin's. */
  event: FailureReportEvent;
  /**
   * This account's names, which the note has taken out too (so the preview
   * shows the note exactly as it is sent). Shown only to this manager's admins.
   */
  accountNames: AccountNames;
}

/**
 * The note as it is sent: trimmed, cut to length, private values and this
 * account's names removed; null when empty.
 */
export function cleanNote(note: string, names: AccountNames = NO_ACCOUNT_NAMES): string | null {
  const trimmed = note.trim().slice(0, NOTE_MAX_LENGTH);
  return trimmed.length === 0 ? null : redactReportText(trimmed, names);
}

/** The event with the admin's note, as it is sent. */
export function withNote(
  event: FailureReportEvent,
  note: string,
  names: AccountNames = NO_ACCOUNT_NAMES,
): FailureReportEvent {
  return { ...event, properties: { ...event.properties, note: cleanNote(note, names) } };
}

/** A job log line as a report carries it (before redaction). */
export interface ReportLogLine {
  ts: number;
  level: string;
  message: string;
  dataJson: string | null;
}

/**
 * One log line's texts, each redacted on its own before the time and level
 * are put in front, so a value at the start of a message (`NAME=value`) is
 * still at the start of a line for the redaction rules.
 */
function lineTexts(line: ReportLogLine, names: AccountNames): string[] {
  const redact = (text: string) => redactReportText(text, names);
  const out = [`${new Date(line.ts).toISOString()} ${line.level} ${redact(line.message)}`];
  if (line.dataJson === null) return out;
  try {
    const value: unknown = JSON.parse(line.dataJson);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const { requests, ...rest } = value as { requests?: unknown };
      if (Array.isArray(requests)) for (const r of requests) out.push(`  ${redact(String(r))}`);
      if (Object.keys(rest).length > 0) out.push(`  ${redact(JSON.stringify(rest))}`);
      return out;
    }
  } catch {
    // Not JSON: sent as written.
  }
  out.push(`  ${redact(line.dataJson)}`);
  return out;
}

const utf8 = new TextEncoder();

/**
 * The job's log as a report sends it: one text per line (API calls and data
 * indented under their line), every private-looking value and this
 * account's names removed, and only the end when it is long (at most
 * {@link LOG_MAX_LINES} lines and {@link LOG_MAX_BYTES} bytes of UTF-8).
 */
export function reportLog(
  lines: readonly ReportLogLine[],
  names: AccountNames = NO_ACCOUNT_NAMES,
): { log: string[]; truncated: boolean } {
  const all = lines.flatMap((line) => lineTexts(line, names));
  const kept: string[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0 && kept.length < LOG_MAX_LINES; i--) {
    const text = all[i] ?? "";
    const size = utf8.encode(text).byteLength;
    if (bytes + size > LOG_MAX_BYTES) break;
    bytes += size;
    kept.push(text);
  }
  kept.reverse();
  return { log: kept, truncated: kept.length < all.length };
}

/** Everything the dialog says, in plain words. */
export const FAILURE_REPORT_COPY = {
  action: "Send a report",
  title: "Send a report to the Appflare team so we can fix this",
  description:
    "The report tells us what went wrong. Passwords, keys, tokens, email addresses, your Cloudflare account id, your domains and your Worker names are taken out before it leaves.",
  summaryTitle: "What the report contains",
  noteLabel: "Anything to add? (optional)",
  noteDescription:
    "What you were trying to do, or anything that looked odd. Please leave out passwords and keys.",
  usageDataOff:
    "Usage data is turned off for this manager. This report is still sent, because you chose to send it. Nothing else is.",
  devBuild: "This is a development build of Appflare, which never sends reports.",
  details: "See exactly what is sent",
  detailsDescription:
    "The report as it leaves this Worker for the Appflare team's PostHog project in the EU. Values shown as [redacted], [email], [account id], [id], [domain] or [worker] were removed.",
  send: "Send",
  sent: "Thanks, report sent",
  alreadySent: "This failure was already reported. Thanks.",
  sendFailed: "The report could not be sent. Try again in a moment.",
} as const;
