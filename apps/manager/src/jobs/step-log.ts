import type { RequestLog } from "@appflare/cf-api";
import type { LOG_LEVELS } from "../db/schema";

/**
 * Job log lines, written as ONE `job_logs` insert per Workflow step attempt
 * (logs are batched per step, not per line; D1 allows 100k writes a
 * day on free). Cloudflare API calls are recorded as `METHOD path -> status`
 * only, collected from cf-api's `onRequest` hook, and attached
 * to the step's last line. Callers must never put a secret value or the API
 * token in a message or in `data`.
 */

export type LogLevel = (typeof LOG_LEVELS)[number];

const ROWS_PER_STATEMENT = 20;

export interface LogLine {
  ts: number;
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export class StepLog {
  readonly lines: LogLine[] = [];
  readonly requests: string[] = [];
  /** Subrequests made through {@link StepLog.onRequest} (every cf-api call). */
  apiCalls = 0;

  constructor(private readonly now: () => number = Date.now) {}

  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    this.lines.push({ ts: this.now(), level, message, ...(data === undefined ? {} : { data }) });
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  /** cf-api `onRequest` hook: path and status only, never a query or body. */
  readonly onRequest = (entry: RequestLog): void => {
    this.apiCalls += 1;
    this.requests.push(`${entry.method} ${entry.path} -> ${entry.status}`);
  };

  /** The rows to insert: request lines ride on the last line's `data.requests`. */
  rows(jobId: string): Array<{
    job_id: string;
    ts: number;
    level: LogLevel;
    message: string;
    data_json: string | null;
  }> {
    const lines = [...this.lines];
    if (this.requests.length > 0) {
      const last = lines.pop() ?? { ts: this.now(), level: "info" as const, message: "API calls" };
      lines.push({ ...last, data: { ...last.data, requests: [...this.requests] } });
    }
    return lines.map((line) => ({
      job_id: jobId,
      ts: line.ts,
      level: line.level,
      message: line.message,
      data_json: line.data === undefined ? null : JSON.stringify(line.data),
    }));
  }

  /**
   * Writes every line in one D1 round trip (one batch; statements hold at most
   * 20 rows because D1 binds at most 100 parameters). Logging is best effort: a
   * failed log write never fails, and so never re-runs, the step it describes.
   */
  async flush(db: D1Database, jobId: string): Promise<void> {
    const rows = this.rows(jobId);
    if (rows.length === 0) return;
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
      const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
      statements.push(
        db
          .prepare(
            `INSERT INTO job_logs (job_id, ts, level, message, data_json) VALUES ${chunk
              .map(() => "(?, ?, ?, ?, ?)")
              .join(", ")}`,
          )
          .bind(...chunk.flatMap((r) => [r.job_id, r.ts, r.level, r.message, r.data_json])),
      );
    }
    try {
      await db.batch(statements);
    } catch (error) {
      console.error("job log write failed", {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.lines.length = 0;
    this.requests.length = 0;
  }
}
