import type { CloudflareClient, RequestLog, WorkerVersion } from "@appflare/cf-api";
import { eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import {
  readAutoUpdateDefaults,
  writeAutoUpdateDefaults,
} from "../../auto-update/auto-update.server";
import {
  NO_REMOVAL_IN_PROGRESS_SQL,
  REMOVAL_IN_PROGRESS_MESSAGE,
  removalInProgress,
} from "../../danger/removal-flag";
import { createDb } from "../../db/client";
import { readSchemaVersion } from "../../db/migrate";
import { jobs } from "../../db/schema";
import { readSettings, SETTING, writeSettings } from "../../db/settings";
import { reconcileJobs, type WorkflowLookup } from "../reconcile.server";
import { StepLog } from "../step-log";
import { activeVersionId, previewUrl } from "../update/plan";
import { appendVersionHistory, VERSION_BINDING } from "./plan";
import {
  appflareVersionOf,
  bindingNamesOf,
  changedSecretsOf,
  hasPreview,
  MANAGER_VERSIONS_LIMIT,
  type ManagerHealthReport,
  type ManagerVersionRow,
  managerVersionRows,
  readManagerHealth,
  rollbackSchemaRefusal,
} from "./rollback";

/**
 * Rolling the manager back to one of its own earlier Worker versions, from
 * Settings, Updates, Recent versions (admins), and the list that offers it.
 *
 * It runs inside the admin's request rather than as a Workflow job. The
 * switch is one API call (a deployment of an existing version), and a
 * Workflow instance running when the script is replaced resumes on the new
 * code: here that is older code, which may not know the steps of the newer
 * one. A request that promotes completes on the code that started it and its
 * response is delivered, as a self-update's promotion does. So, like a
 * database restore, the rollback is recorded as a job row without a Workflow
 * instance (kind `self_rollback`), its log written as it goes; a row whose
 * request died is settled by reconciliation.
 *
 * Before the switch the target must answer `/api/health` at its preview URL
 * as the Appflare release its binding names, with a working database, and
 * its code must know every migration the database has (./rollback.ts). The
 * database itself is never touched. Cloudflare refuses a version whose
 * secrets changed since (an older API token or auth secret would come back);
 * that refusal is passed on, never forced. The switch turns Appflare's
 * automatic updates off, so the cron does not move it forward again at once.
 */

export class ManagerRollbackError extends Error {
  override name = "ManagerRollbackError";
}

/** The part of the Cloudflare client the rollback and the list use. */
export interface ManagerVersionsApi {
  versions: Pick<
    CloudflareClient["versions"],
    "listVersions" | "getVersion" | "listDeployments" | "createDeployment"
  >;
  workers: Pick<CloudflareClient["workers"], "getAccountSubdomain">;
}

/** Version details never change, so an isolate reads each one once. */
const detailCache = new Map<string, WorkerVersion>();
const DETAIL_CACHE_LIMIT = 200;

async function versionDetail(
  api: ManagerVersionsApi,
  workerName: string,
  id: string,
  cache: Map<string, WorkerVersion>,
): Promise<WorkerVersion> {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const detail = await api.versions.getVersion(workerName, id);
  if (cache.size >= DETAIL_CACHE_LIMIT) cache.clear();
  cache.set(id, detail);
  return detail;
}

async function workerName(db: D1Database): Promise<string> {
  const settings = await readSettings(createDb(db), [SETTING.accountId, SETTING.workerName]);
  if (!settings.account_id || !settings.worker_name) {
    throw new ManagerRollbackError(
      "Appflare does not know its Cloudflare account and Worker yet. Finish setup first.",
    );
  }
  return settings.worker_name;
}

export interface ManagerVersionsView {
  versions: ManagerVersionRow[];
  /** The version serving all traffic; null during a gradual deployment. */
  servingVersionId: string | null;
}

/**
 * The Worker's newest versions (one page of the versions list), each with
 * the Appflare release its `APPFLARE_VERSION` binding names, and which one
 * serves. One API call per version not read before in this isolate.
 */
export async function listManagerVersionsCore(deps: {
  db: D1Database;
  api: ManagerVersionsApi;
  cache?: Map<string, WorkerVersion>;
}): Promise<ManagerVersionsView> {
  const cache = deps.cache ?? detailCache;
  const name = await workerName(deps.db);
  const [listed, deployments] = await Promise.all([
    deps.api.versions.listVersions(name),
    deps.api.versions.listDeployments(name),
  ]);
  const newest = [...listed]
    .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))
    .slice(0, MANAGER_VERSIONS_LIMIT);
  const servingId = activeVersionId(deployments);
  const ids = new Set(newest.map((v) => v.id));
  if (servingId !== null) ids.add(servingId);
  const details = new Map(
    await Promise.all(
      [...ids].map(async (id) => [id, await versionDetail(deps.api, name, id, cache)] as const),
    ),
  );
  const serving = servingId === null ? undefined : details.get(servingId);
  const servingNumber = typeof serving?.number === "number" ? serving.number : null;
  return {
    versions: managerVersionRows(newest, details, servingId, servingNumber),
    servingVersionId: servingId,
  };
}

export interface RollBackManagerDeps {
  db: D1Database;
  /** The Cloudflare client, reporting every API call to `onRequest` (the job log). */
  api(onRequest: (entry: RequestLog) => void): Promise<ManagerVersionsApi>;
  /** The running `APPFLARE_VERSION`. */
  currentVersion: string;
  /** For settling jobs whose Workflow instance died, so they do not block the rollback. */
  workflows?: WorkflowLookup;
  /** Reaches the target's preview URL. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  newId?: () => string;
  /** Preview requests before giving up (the preview of an existing version answers at once). */
  probeAttempts?: number;
  /** Version details already read (the isolate's cache unless given). */
  cache?: Map<string, WorkerVersion>;
}

export interface RollBackManagerResult {
  jobId: string;
  /** The Appflare release now serving. */
  version: string;
  /** The Workers version now serving. */
  versionId: string;
  /** The Appflare release that served before. */
  fromVersion: string;
  /** ISO 8601 */
  finishedAt: string;
}

export const ROLLBACK_BUSY =
  "Another job is queued or running. Appflare rolls itself back only when nothing else runs; wait for it to finish.";

const PROBE_ATTEMPTS = 4;
const PROBE_DELAY_MS = 1500;

/** A failure already logged and recorded on the job row. */
class Refused extends Error {}

export async function rollBackManagerCore(
  deps: RollBackManagerDeps,
  request: { versionId: string },
): Promise<RollBackManagerResult> {
  const now = deps.now ?? (() => new Date());
  const orm = createDb(deps.db);
  if ((await removalInProgress(deps.db)) !== null) {
    throw new ManagerRollbackError(REMOVAL_IN_PROGRESS_MESSAGE);
  }
  const name = await workerName(deps.db);
  const target = request.versionId;

  // A job whose Workflow instance died must not block the rollback.
  const active = await orm
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]));
  if (active.length > 0 && deps.workflows !== undefined) {
    await reconcileJobs(deps.db, deps.workflows, active);
  }

  // The job row is the claim: the script is replaced only while nothing else runs.
  const jobId = (deps.newId ?? (() => ulid()))();
  const input = { versionId: target, fromVersion: deps.currentVersion };
  const claimed = await deps.db
    .prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at)
       SELECT ?1, NULL, 'self_rollback', 'running', ?2, ?3
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE status IN ('queued', 'running'))
         AND ${NO_REMOVAL_IN_PROGRESS_SQL}`,
    )
    .bind(jobId, JSON.stringify(input), now().getTime())
    .run();
  if (claimed.meta.changes !== 1) throw new ManagerRollbackError(ROLLBACK_BUSY);

  const log = new StepLog(() => now().getTime());
  const recordFailure = async (message: string): Promise<void> => {
    log.error(message);
    await log.flush(deps.db, jobId);
    await orm
      .update(jobs)
      .set({ status: "failed", error: message, finished_at: now() })
      .where(eq(jobs.id, jobId));
  };
  const refuse = async (message: string): Promise<never> => {
    await recordFailure(message);
    throw new Refused(message);
  };

  let switched: { version: string; at: Date } | null = null;
  try {
    const api = await deps.api(log.onRequest);
    log.info(`Rolling Appflare back to Worker version ${target} on Worker "${name}".`);

    // 1. What serves now, and what the target is.
    const servingId = activeVersionId(await api.versions.listDeployments(name));
    if (servingId === null) {
      return await refuse(
        "No single version serves all of Appflare's traffic (a gradual deployment is in progress); finish or undo it in the Cloudflare dashboard first.",
      );
    }
    if (servingId === target) return await refuse(`Version ${target} already serves all traffic.`);
    const [detail, serving] = await Promise.all([
      versionDetail(api, name, target, deps.cache ?? detailCache),
      versionDetail(api, name, servingId, deps.cache ?? detailCache),
    ]);
    const targetVersion = appflareVersionOf(detail);
    if (targetVersion === null) {
      return await refuse(
        `Version ${target} has no ${VERSION_BINDING} binding, so it is not an Appflare build.`,
      );
    }
    if (
      typeof detail.number === "number" &&
      typeof serving.number === "number" &&
      detail.number >= serving.number
    ) {
      return await refuse(
        `Version ${target} is not older than the version serving now; only older versions are rolled back to.`,
      );
    }
    await orm
      .update(jobs)
      .set({
        input_json: JSON.stringify({ ...input, version: targetVersion, fromVersionId: servingId }),
        worker_version_id: target,
      })
      .where(eq(jobs.id, jobId));
    log.info(
      `Version ${target} runs Appflare ${targetVersion}; version ${servingId} (Appflare ${deps.currentVersion}) serves now.`,
    );
    await log.flush(deps.db, jobId);

    // 2. The target's own report, from its preview URL.
    if (!hasPreview(detail)) {
      return await refuse(
        `Cloudflare serves no preview of version ${target}, so Appflare cannot check it before it serves traffic.`,
      );
    }
    const subdomain = await accountSubdomain(deps.db, api, now());
    const health = await probeHealth(deps, previewUrl(target, name, subdomain, "/api/health"), log);
    if (health === null) {
      return await refuse(
        `The preview of version ${target} did not answer with Appflare's health report.`,
      );
    }
    if (health.version !== targetVersion) {
      return await refuse(
        `The preview of version ${target} reports Appflare ${health.version}, not ${targetVersion}.`,
      );
    }
    if (health.db !== "ok") {
      return await refuse(
        `The preview of version ${target} reports its database as ${health.db ?? "unknown"}.`,
      );
    }

    // 3. Its code must know the database's schema; the database stays as it is.
    const recorded = await readSchemaVersion(deps.db);
    const refusal = rollbackSchemaRefusal(targetVersion, recorded, health.knownSchemaVersion);
    if (refusal !== null) return await refuse(refusal);
    log.info(
      `Appflare ${targetVersion} answers with a working database, and its code knows every migration the database has (${recorded}).`,
    );
    const targetBindings = bindingNamesOf(detail);
    const missing = bindingNamesOf(serving).filter((n) => !targetBindings.includes(n));
    if (missing.length > 0) {
      log.warn(
        `Version ${target} does not have the binding(s) ${missing.join(", ")} that the serving version has; what they connect stays unavailable until Appflare is updated again.`,
      );
    }
    await log.flush(deps.db, jobId);

    // 4. The switch. Never forced: changed secrets would come back with their old values.
    try {
      await api.versions.createDeployment(name, {
        versions: [{ version_id: target, percentage: 100 }],
        annotations: { "workers/message": `Appflare: roll back to ${targetVersion}` },
      });
    } catch (error) {
      const secrets = changedSecretsOf(error);
      if (secrets === null) {
        return await refuse(`Cloudflare did not deploy version ${target}: ${errorText(error)}`);
      }
      const which =
        secrets.length > 0 ? `the secret(s) ${secrets.join(", ")} changed` : "its secrets changed";
      return await refuse(
        `Cloudflare refused: ${which} since version ${target} was deployed, and rolling back would bring back their earlier values (an older API token or auth secret). Pick a newer version of the same release.`,
      );
    }
    const at = now();
    switched = { version: targetVersion, at };
    log.info(`Version ${target} (Appflare ${targetVersion}) now serves all traffic.`);

    // 5. Record it. This request still runs the code it started on.
    const defaults = await readAutoUpdateDefaults(orm);
    if (defaults.manager) {
      await writeAutoUpdateDefaults(orm, { manager: false }, at);
      log.info("Automatic updates of Appflare are now off, so the cron does not update it again.");
    }
    const { manager_version_history: history } = await readSettings(orm, [
      SETTING.managerVersionHistory,
    ]);
    await writeSettings(
      orm,
      {
        [SETTING.managerVersionHistory]: appendVersionHistory(history, {
          version: targetVersion,
          from: deps.currentVersion,
          jobId,
          workerVersionId: target,
          at: at.toISOString(),
        }),
      },
      at,
    );
  } catch (error) {
    if (error instanceof Refused) throw new ManagerRollbackError(error.message);
    if (switched === null) {
      const message = `Rollback failed: ${errorText(error)}`;
      await recordFailure(message);
      throw new ManagerRollbackError(message);
    }
    // The switch happened; only the bookkeeping after it failed.
    log.warn(`The rollback's records could not all be written: ${errorText(error)}`);
  }
  if (switched === null) throw new ManagerRollbackError("the rollback ended without a result");
  await log.flush(deps.db, jobId);
  await orm
    .update(jobs)
    .set({ status: "succeeded", finished_at: switched.at, error: null })
    .where(eq(jobs.id, jobId));
  return {
    jobId,
    version: switched.version,
    versionId: target,
    fromVersion: deps.currentVersion,
    finishedAt: switched.at.toISOString(),
  };
}

/**
 * The rollback as the server function runs it: `authorize` (the admin
 * check; the owner is an admin) runs first and throws for anyone else,
 * before anything is read or written.
 */
export async function rollBackManagerAs(
  authorize: () => Promise<unknown>,
  deps: RollBackManagerDeps,
  request: { versionId: string },
): Promise<RollBackManagerResult> {
  await authorize();
  return rollBackManagerCore(deps, request);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function accountSubdomain(
  db: D1Database,
  api: ManagerVersionsApi,
  at: Date,
): Promise<string> {
  const orm = createDb(db);
  const cached = await readSettings(orm, [SETTING.accountSubdomain]);
  if (cached.account_subdomain) return cached.account_subdomain;
  const found = (await api.workers.getAccountSubdomain()).subdomain;
  await writeSettings(orm, { [SETTING.accountSubdomain]: found }, at);
  return found;
}

/** Requests the preview's health report a few times; null when it never answers with one. */
async function probeHealth(
  deps: RollBackManagerDeps,
  url: string,
  log: StepLog,
): Promise<ManagerHealthReport | null> {
  const fetchFn = deps.fetch ?? ((u: string, init?: RequestInit) => fetch(u, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = deps.probeAttempts ?? PROBE_ATTEMPTS;
  let last = "no answer";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchFn(url, { headers: { "cache-control": "no-store" } });
      const report = readManagerHealth(await res.text());
      if (report !== null) return report;
      last = `HTTP ${res.status} without a health report`;
    } catch (error) {
      last = errorText(error);
    }
    if (attempt < attempts) await sleep(PROBE_DELAY_MS);
  }
  log.warn(`The preview did not answer with a health report after ${attempts} attempts (${last}).`);
  return null;
}
