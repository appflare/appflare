import type { FetchLike } from "@appflare/cf-api";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { type HealthStatus, installs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { healthCheckOfManifest, probeHealth, settleHealthProbe } from "../jobs/install/health";
import { readAppBaseUrl } from "./app-address.server";

/**
 * "Check now" on an install's page: one GET of the app's address (its
 * workers.dev URL, or its primary custom domain while workers.dev is off) at its
 * health path (the catalog's `install.healthPath`, else `/`), recorded on the
 * install the way the jobs' final health check records it. One probe, no
 * retries: the admin can press the button again.
 */

export class HealthCheckError extends Error {
  override name = "HealthCheckError";
}

export interface HealthCheckDeps {
  db: D1Database;
  /** The manager's `fetch` (it carries `global_fetch_strictly_public`). */
  fetch: FetchLike;
  now?: () => number;
}

export interface HealthCheckResult {
  status: HealthStatus;
  /** What the Worker answered ("HTTP 200", "connection failed (...)"). */
  detail: string;
  url: string;
  /** ISO 8601 */
  checkedAt: string;
  /**
   * False when the install stopped being `installed` during the probe (an
   * update or uninstall started): the answer may predate that change, so it is
   * not recorded.
   */
  recorded: boolean;
}

export async function checkInstallHealthCore(
  deps: HealthCheckDeps,
  input: { installId: string },
): Promise<HealthCheckResult> {
  const orm = createDb(deps.db);
  const now = deps.now ?? Date.now;
  const [row] = await orm
    .select({
      status: installs.status,
      workerName: installs.worker_name,
      manifestJson: installs.manifest_json,
      workersDev: installs.workers_dev_enabled,
      servedDomain: installs.served_domain,
    })
    .from(installs)
    .where(eq(installs.id, input.installId))
    .limit(1);
  if (row === undefined) throw new HealthCheckError("There is no such install.");
  if (row.status !== "installed") {
    throw new HealthCheckError(`Only an installed app can be checked; this one is ${row.status}.`);
  }
  const settings = await readSettings(orm, [SETTING.accountSubdomain]);
  const base = await readAppBaseUrl(
    orm,
    {
      id: input.installId,
      worker_name: row.workerName,
      workers_dev_enabled: row.workersDev,
      served_domain: row.servedDomain,
    },
    settings.account_subdomain,
  );
  if (base === null) {
    throw new HealthCheckError("The account's workers.dev subdomain is not known yet.");
  }
  const check = healthCheckOfManifest(row.manifestJson);
  const url = `${base}${check.path}`;
  const probe = await probeHealth(deps.fetch, url);
  const checkedAt = new Date(now());
  const settled = settleHealthProbe(probe, check.mode);
  const written = await orm
    .update(installs)
    .set({ health_status: settled.status, health_checked_at: checkedAt })
    .where(and(eq(installs.id, input.installId), eq(installs.status, "installed")))
    .returning({ id: installs.id });
  return { ...settled, url, checkedAt: checkedAt.toISOString(), recorded: written.length > 0 };
}
