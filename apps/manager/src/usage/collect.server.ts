import { CloudflareApiError, type CloudflareClient } from "@appflare/cf-api";
import { sql } from "drizzle-orm";
import type { AccountPlan } from "../account/plan";
import { type Read, read } from "../db/batch";
import type { Database } from "../db/client";
import type { AppResources, CollectedHour, CollectSource } from "./collect";
import type { HourlyUsage } from "./store/series.server";

/**
 * What the collector reads from the database and the account before asking
 * the analytics: each app's resources. Their ids come from the install
 * record (`resources`), the Workers AI, Analytics Engine and Browser
 * Rendering bindings from the manifest it was installed from, and the
 * Durable Object namespaces and container applications from the account,
 * since the install records only the classes (the script upload creates the
 * namespaces).
 */

/** An app the watcher looks at: every install that is not uninstalled. */
export interface WatchedApp {
  installId: string;
  workerName: string;
  status: string;
  /** Epoch ms. */
  installedAt: number;
  resources: AppResources;
}

interface Row {
  id: string;
  worker_name: string;
  status: string;
  installed_at: number;
  resources_json: string | null;
  bindings_json: string | null;
}

/**
 * Every install not uninstalled, its live resources and the bindings that
 * name what the analytics attribute by, in one statement. The installs
 * table has one row per install ever made and is read whole, as Home reads
 * it; resources are reached through their install index; the bindings come
 * out of the stored manifest with SQLite's JSON functions, so the manifest
 * (module and asset lists included) never leaves the database.
 */
export const WATCHED_APPS_SQL = `SELECT i.id, i.worker_name, i.status, i.installed_at,
  (SELECT json_group_array(json_array(r.kind, r.name, r.cf_id))
     FROM resources r
     WHERE r.install_id = i.id AND r.deleted_at IS NULL
       AND r.kind IN ('worker', 'd1', 'kv', 'r2', 'queue', 'workflow', 'vectorize')) AS resources_json,
  (SELECT json_group_array(json_array(
       json_extract(b.value, '$.type'), json_extract(b.value, '$.name'),
       json_extract(b.value, '$.dataset')))
     FROM (
       SELECT value FROM json_each(
         CASE WHEN json_valid(i.manifest_json) THEN i.manifest_json END, '$.worker.bindings')
       UNION ALL
       SELECT wb.value FROM json_each(
         CASE WHEN json_valid(i.manifest_json) THEN i.manifest_json END, '$.workers') w,
         json_each(w.value, '$.worker.bindings') wb
     ) b
     WHERE json_extract(b.value, '$.type') IN ('ai', 'analytics_engine', 'browser')) AS bindings_json
FROM installs i
WHERE i.status <> 'uninstalled'
ORDER BY i.installed_at, i.id`;

function tuples(json: string | null): Array<Array<string | null>> {
  if (json === null) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((t): t is Array<string | null> => Array.isArray(t))
      : [];
  } catch {
    return [];
  }
}

const unique = (values: Array<string | null | undefined>): string[] => [
  ...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0)),
];

export async function readWatchedApps(d1: D1Database): Promise<WatchedApp[]> {
  const { results } = await d1.prepare(WATCHED_APPS_SQL).all<Row>();
  return watchedAppsFrom(results);
}

/** {@link readWatchedApps} as a read that can share a round trip with others (db/batch.ts). */
export function watchedAppsRead(db: Database): Read<WatchedApp[]> {
  return read([db.all(sql.raw(WATCHED_APPS_SQL))], ([rows]) => watchedAppsFrom(rows as Row[]));
}

function watchedAppsFrom(results: readonly Row[]): WatchedApp[] {
  return results.map((row) => {
    const resources = tuples(row.resources_json);
    const of = (kind: string, pick: (t: Array<string | null>) => string | null | undefined) =>
      unique(resources.filter((t) => t[0] === kind).map(pick));
    const bindings = tuples(row.bindings_json);
    const workers = of("worker", (t) => t[1]);
    return {
      installId: row.id,
      workerName: row.worker_name,
      status: row.status,
      installedAt: Number(row.installed_at),
      resources: {
        installId: row.id,
        // An install recorded before its Worker was, or whose Worker the
        // app's own installer deployed under the install's name.
        workers: workers.length > 0 ? workers : [row.worker_name],
        durableObjects: [],
        d1: of("d1", (t) => t[2]),
        kv: of("kv", (t) => t[2]),
        r2: of("r2", (t) => t[1]),
        queues: of("queue", (t) => t[2]),
        workflows: of("workflow", (t) => t[1]),
        vectorize: of("vectorize", (t) => t[1]),
        // A dataset defaults to the binding's name (wrangler's own default).
        analyticsEngine: unique(
          bindings.filter((b) => b[0] === "analytics_engine").map((b) => b[2] ?? b[1]),
        ),
        containers: [],
        ai: bindings.some((b) => b[0] === "ai"),
        browser: bindings.some((b) => b[0] === "browser"),
      },
    };
  });
}

function status(error: unknown): number | null {
  return error instanceof CloudflareApiError ? error.status : null;
}

/** What {@link addAccountResources} could not list: its name, the sources it leaves unread, and why. */
export interface AccountResourcesUnread {
  what: "Durable Object namespaces" | "container applications";
  unread: CollectSource[];
  error: unknown;
}

/**
 * Fills in each app's Durable Object namespaces (the account's namespaces
 * whose script is one of the app's Workers) and, on Workers Paid, the
 * container applications behind them. One list call each; containers only
 * when some app has a namespace. A list that fails leaves out only the
 * products it covers for this check: without the namespaces, Durable
 * Objects, their alarms and containers; without the container
 * applications, containers alone (the namespaces read stay filled in).
 */
export async function addAccountResources(
  api: CloudflareClient,
  apps: readonly WatchedApp[],
  plan: AccountPlan,
): Promise<AccountResourcesUnread | null> {
  const byScript = new Map<string, WatchedApp>();
  for (const app of apps) for (const w of app.resources.workers) byScript.set(w, app);
  if (byScript.size === 0) return null;
  let namespaces: Awaited<ReturnType<typeof api.workers.listDurableObjectNamespaces>>;
  try {
    namespaces = await api.workers.listDurableObjectNamespaces();
  } catch (error) {
    return {
      what: "Durable Object namespaces",
      unread: ["durableObjects", "containers", "alarms"],
      error,
    };
  }
  const byNamespace = new Map<string, WatchedApp>();
  for (const ns of namespaces) {
    const app = ns.script === undefined ? undefined : byScript.get(ns.script);
    if (app === undefined) continue;
    app.resources.durableObjects.push(ns.id);
    byNamespace.set(ns.id, app);
  }
  // Containers exist only on Workers Paid, always behind a Durable Object.
  if (plan !== "paid" || byNamespace.size === 0) return null;
  let applications: Awaited<ReturnType<typeof api.containers.listApplications>>;
  try {
    applications = await api.containers.listApplications();
  } catch (error) {
    // No Containers on the account (401) or the token may not read them (403).
    const s = status(error);
    if (s === 401 || s === 403) return null;
    return { what: "container applications", unread: ["containers"], error };
  }
  for (const application of applications) {
    const app = byNamespace.get(application.durable_objects?.namespace_id ?? "");
    if (app !== undefined) app.resources.containers.push(application.id);
  }
  return null;
}

/** Two numbers are the same reading (stored values pass through floating point). */
export function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

const keyOf = (installId: string, product: string, hour: number) =>
  `${installId}\u0000${product}\u0000${hour}`;

/** Stored hourly values by install, product and hour, for {@link changedHours}. */
export function storedIndex(
  rows: ReadonlyArray<{ installId: string; product: string; t: number; value: number }>,
): Map<string, number> {
  return new Map(rows.map((r) => [keyOf(r.installId, r.product, r.t), r.value]));
}

/**
 * The collected hours to write: those whose value differs from what is
 * stored. A count Cloudflare no longer reports is never overwritten with
 * zero (the analytics of a deleted Durable Object namespace disappear; the
 * stored hours are the record), and nothing is written as zero that was not
 * stored before.
 */
export function changedHours(
  collected: readonly CollectedHour[],
  stored: ReadonlyMap<string, number>,
): HourlyUsage[] {
  const out: HourlyUsage[] = [];
  for (const h of collected) {
    const before = stored.get(keyOf(h.installId, h.product, h.hour));
    if (before !== undefined && sameValue(before, h.value)) continue;
    if (before === undefined && h.value === 0) continue;
    out.push({ installId: h.installId, product: h.product, hour: h.hour, value: h.value });
  }
  return out;
}
