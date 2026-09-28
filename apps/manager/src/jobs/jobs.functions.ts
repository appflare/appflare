import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { installs, type JobStarter, job_logs, jobs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { appAddress } from "../installs/app-address";
import { readAddressDomains } from "../installs/app-address.server";
import { installLabel } from "../installs/display-name";
import { namedInstall, readInstallLabels } from "../installs/install-names.server";
import { isDeleteRetainedJob } from "../installs/removed-apps.server";
import { sandboxBinding } from "../sandbox/binding";
import {
  type BuildProgressView,
  readBuildProgress,
  sandboxBuildOfInput,
} from "../sandbox/progress";
import { requireSession } from "../server/auth.server";
import { type JobListRow, listRecentJobs } from "./job-list.server";
import { isRestoreJob, reconcileJobs } from "./reconcile.server";

export type { BuildProgressView } from "../sandbox/progress";
export type { JobListRow } from "./job-list.server";

/** `/jobs`: any signed-in user; the most recent jobs, newest first. */
export const listJobs = createServerFn({ method: "GET" }).handler(
  async (): Promise<JobListRow[]> => {
    await requireSession();
    return listRecentJobs(env.DB);
  },
);

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
  /** A deletion of the data an uninstall kept (recorded as an `uninstall` job). */
  deleteRetained: boolean;
  status: "queued" | "running" | "succeeded" | "failed";
  error: string | null;
  /** The Workers version an update uploaded or a rollback deployed. */
  workerVersionId: string | null;
  /** The Appflare version a self-update or a rollback of Appflare moves to; null for other kinds. */
  targetVersion: string | null;
  /** Who started it: an admin, or the cron (automatic updates). */
  startedBy: JobStarter;
  startedAt: string | null;
  finishedAt: string | null;
  /** When an admin sent a report of this failure to the Appflare team; null when not. */
  reportedAt: string | null;
  install: {
    id: string;
    slug: string;
    workerName: string;
    /** The name an admin gave the install; null when it has none. */
    displayName: string | null;
    /** What the UI calls the install (`distinctLabels`). */
    label: string;
    status: string;
    /** Where "Open" takes the app (`appAddress`); null until installed, or with no address. */
    address: string | null;
  } | null;
  logs: JobLogRow[];
  /**
   * A build from a repository or from source: what it is for (its review
   * is at `/catalog/source/<job id>`). Null for other jobs.
   */
  sourceBuild: { purpose: string; origin: string } | null;
  /**
   * The sandbox build the job is waiting on, read live from the sandbox
   * Worker while it runs (the job log gets its output when it ends); null
   * otherwise.
   */
  build: BuildProgressView | null;
}

/** The `version` a self-update's (or an Appflare rollback's) input names. */
function targetVersionOf(kind: string, inputJson: string | null): string | null {
  if ((kind !== "self_update" && kind !== "self_rollback") || inputJson === null) return null;
  try {
    const version = (JSON.parse(inputJson) as { version?: unknown }).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
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

/** What a `source_build` job's input says it builds for. */
function sourceBuildOfInput(inputJson: string | null): { purpose: string; origin: string } {
  try {
    const input = JSON.parse(inputJson ?? "{}") as { purpose?: unknown; origin?: unknown };
    return {
      purpose: typeof input.purpose === "string" ? input.purpose : "install",
      origin: typeof input.origin === "string" ? input.origin : "repository",
    };
  } catch {
    return { purpose: "install", origin: "repository" };
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
              displayName: installs.display_name,
              manifestJson: installs.manifest_json,
              status: installs.status,
              workersDevEnabled: installs.workers_dev_enabled,
              servedDomain: installs.served_domain,
            })
            .from(installs)
            .where(eq(installs.id, job.install_id))
            .limit(1),
      db.select().from(job_logs).where(eq(job_logs.job_id, job.id)).orderBy(asc(job_logs.id)),
    ]);
    const installRow = installRows[0];
    let install: JobView["install"] = null;
    if (installRow !== undefined) {
      const { workersDevEnabled, servedDomain, manifestJson, ...rest } = installRow;
      const named = namedInstall({
        id: installRow.id,
        app_slug: installRow.slug,
        worker_name: installRow.workerName,
        display_name: installRow.displayName,
        manifest_json: manifestJson,
      });
      const labels = await readInstallLabels(env.DB, [named]);
      let address: string | null = null;
      if (installRow.status === "installed") {
        const [domains, settings] = await Promise.all([
          readAddressDomains(db, [installRow.id]),
          readSettings(db, [SETTING.accountSubdomain]),
        ]);
        address = appAddress({
          workerName: installRow.workerName,
          workersDevEnabled,
          servedDomain,
          domains: domains.get(installRow.id) ?? [],
          subdomain: settings.account_subdomain || null,
        });
      }
      install = { ...rest, label: labels.get(named.id) ?? installLabel(named), address };
    }
    const building =
      job.status === "queued" || job.status === "running"
        ? sandboxBuildOfInput(job.input_json)
        : null;
    // A build from a repository for a new install has no install row yet.
    const buildInstallId = building?.installId ?? job.install_id;
    const build =
      building === null || buildInstallId === null
        ? null
        : await readBuildProgress(sandboxBinding(env), {
            installId: buildInstallId,
            version: building.version,
            kind: building.kind,
          });
    return {
      id: job.id,
      kind: job.kind,
      build,
      sourceBuild: job.kind === "source_build" ? sourceBuildOfInput(job.input_json) : null,
      restore: isRestoreJob(job),
      deleteRetained: isDeleteRetainedJob(job),
      status: job.status,
      error: job.error,
      workerVersionId: job.worker_version_id,
      targetVersion: targetVersionOf(job.kind, job.input_json),
      startedBy: job.started_by,
      startedAt: job.started_at?.toISOString() ?? null,
      finishedAt: job.finished_at?.toISOString() ?? null,
      reportedAt: job.reported_at?.toISOString() ?? null,
      install,
      logs: logs.map((l) => ({
        id: l.id,
        ts: l.ts.toISOString(),
        level: l.level,
        message: l.message,
        ...splitData(l.data_json),
      })),
    };
  });
