import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { installs, job_logs, jobs } from "../db/schema";
import { requireSession } from "../server/auth.server";
import { isRestoreJob, reconcileJobs } from "./reconcile.server";

/** `/jobs/$jobId`: the job and its log, polled every 2 s while it runs. */

export interface JobLogRow {
  id: number;
  /** ISO 8601 */
  ts: string;
  level: string;
  message: string;
  /** Cloudflare API calls the step made, `METHOD path -> status`. */
  requests: string[];
  /** Any other structured data, as compact JSON. */
  detail: string | null;
}

export interface JobView {
  id: string;
  kind: string;
  /** A database restore (recorded as a `rollback` job). */
  restore: boolean;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  /** The Workers version an update uploaded or a rollback deployed. */
  workerVersionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  install: {
    id: string;
    slug: string;
    workerName: string;
    /** The install's label (`instance_name`); the Worker name when unset. */
    instanceName: string | null;
    status: string;
  } | null;
  logs: JobLogRow[];
}

function splitData(json: string | null): { requests: string[]; detail: string | null } {
  if (json === null) return { requests: [], detail: null };
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null) return { requests: [], detail: json };
    const { requests, ...rest } = value as { requests?: unknown };
    return {
      requests: Array.isArray(requests) ? requests.map(String) : [],
      detail: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null,
    };
  } catch {
    return { requests: [], detail: json };
  }
}

/** Any signed-in user. Null when there is no such job. */
export const getJob = createServerFn({ method: "GET" })
  .validator(z.object({ jobId: z.string().min(1).max(64) }))
  .handler(async ({ data }): Promise<JobView | null> => {
    await requireSession();
    const db = createDb(env.DB);
    let [job] = await db.select().from(jobs).where(eq(jobs.id, data.jobId)).limit(1);
    if (job === undefined) return null;
    if (job.status === "queued" || job.status === "running") {
      if (await reconcileJobs(env.DB, env.JOBS, [job])) {
        [job] = await db.select().from(jobs).where(eq(jobs.id, data.jobId)).limit(1);
        if (job === undefined) return null;
      }
    }
    const [installRows, logs] = await Promise.all([
      job.install_id === null
        ? Promise.resolve([])
        : db
            .select({
              id: installs.id,
              slug: installs.app_slug,
              workerName: installs.worker_name,
              instanceName: installs.instance_name,
              status: installs.status,
            })
            .from(installs)
            .where(eq(installs.id, job.install_id))
            .limit(1),
      db.select().from(job_logs).where(eq(job_logs.job_id, job.id)).orderBy(asc(job_logs.id)),
    ]);
    return {
      id: job.id,
      kind: job.kind,
      restore: isRestoreJob(job),
      status: job.status,
      error: job.error,
      workerVersionId: job.worker_version_id,
      startedAt: job.started_at?.toISOString() ?? null,
      finishedAt: job.finished_at?.toISOString() ?? null,
      install: installRows[0] ?? null,
      logs: logs.map((l) => ({
        id: l.id,
        ts: l.ts.toISOString(),
        level: l.level,
        message: l.message,
        ...splitData(l.data_json),
      })),
    };
  });
