import type { IndexApp, IndexJson } from "@appflare/schema";
import { createDb } from "../db/client";
import {
  type CatalogRecord,
  type CatalogTrust,
  listCatalogRecords,
  OFFICIAL_TRUST,
  recordCatalogRefresh,
  sourceOf,
  trustOf,
} from "./catalogs.server";
import {
  type CatalogEnv,
  CatalogError,
  type CatalogOptions,
  getCatalogIndex,
  readCachedCatalogIndex,
  readCachedCustomCatalogIndex,
  refreshCatalogIndex,
  refreshCustomCatalogIndex,
} from "./index.server";
import { appKey, type CatalogSource, OFFICIAL_CATALOG_ID, parseAppKey } from "./sources";

/**
 * Every enabled catalog at once: what the catalog pages browse, and where an
 * install's app is looked up. Each catalog's index is cached on its own
 * (`index.server.ts`); apps are addressed by their app key (`sources.ts`).
 * A catalog that is turned off is neither browsed nor refreshed, and its
 * installs find no listing (no update is offered) until it is on again.
 */

export interface MergedEnv extends CatalogEnv {
  DB: D1Database;
}

/** An app as one catalog lists it, with that catalog's badge and trust. */
export interface ListedApp {
  /** `slug`, or `<catalogId>:<slug>` for a custom catalog. */
  key: string;
  app: IndexApp;
  source: CatalogSource;
  trust: CatalogTrust;
}

/** One enabled catalog's index, as far as it could be read. */
export type CatalogIndexRead =
  | {
      source: CatalogSource;
      trust: CatalogTrust;
      ok: true;
      index: IndexJson;
      updatedAt: string | null;
      unreadable: number;
    }
  | {
      source: CatalogSource;
      trust: CatalogTrust;
      ok: false;
      error: string;
      updatedAt: string | null;
    };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One catalog's index as the pages and jobs read it. Never throws: whatever
 * goes wrong with one catalog (its site, its cached copy, KV, D1) is that
 * catalog's error, so one bad catalog never takes the others down.
 */
async function readOne(
  env: MergedEnv,
  record: CatalogRecord,
  refreshOnMiss: boolean,
  opts: CatalogOptions,
): Promise<CatalogIndexRead> {
  const source = sourceOf(record);
  const trust = trustOf(record);
  try {
    return await readOneOrThrow(env, record, refreshOnMiss, opts);
  } catch (error) {
    console.error("catalog could not be read", { catalog: record.id, error: messageOf(error) });
    return {
      source,
      trust,
      ok: false,
      error: `${record.label} could not be read: ${messageOf(error)}`,
      updatedAt: record.refreshedAt?.toISOString() ?? null,
    };
  }
}

async function readOneOrThrow(
  env: MergedEnv,
  record: CatalogRecord,
  refreshOnMiss: boolean,
  opts: CatalogOptions,
): Promise<CatalogIndexRead> {
  const source = sourceOf(record);
  const trust = trustOf(record);
  if (record.kind === "official") {
    if (refreshOnMiss) return { source, trust, ...(await getCatalogIndex(env, opts)) };
    const index = await readCachedCatalogIndex(env.KV);
    return index === null
      ? { source, trust, ok: false, error: "The catalog has not been loaded yet.", updatedAt: null }
      : { source, trust, ok: true, index, updatedAt: null, unreadable: 0 };
  }
  const updatedAt = record.refreshedAt?.toISOString() ?? null;
  const cached = await readCachedCustomCatalogIndex(env.KV, record.id);
  if (cached !== null) return { source, trust, ok: true, updatedAt, ...cached };
  if (!refreshOnMiss) {
    return {
      source,
      trust,
      ok: false,
      error: record.refreshError ?? "The catalog has not been loaded yet.",
      updatedAt,
    };
  }
  try {
    const fresh = await refreshCustomCatalog(env, record, opts);
    return { source, trust, ok: true, ...fresh };
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    return { source, trust, ok: false, error: error.message, updatedAt };
  }
}

/**
 * Fetches a custom catalog's index (conditionally) and records how it went
 * on its row. Throws `CatalogError`.
 */
export async function refreshCustomCatalog(
  env: MergedEnv,
  record: CatalogRecord,
  opts: CatalogOptions = {},
): Promise<{ index: IndexJson; unreadable: number; updatedAt: string }> {
  const at = (opts.now ?? (() => new Date()))();
  const db = createDb(env.DB);
  try {
    const fresh = await refreshCustomCatalogIndex(
      env.KV,
      { catalogId: record.id, url: record.indexUrl },
      opts,
    );
    await recordCatalogRefresh(db, record.id, { at, error: null });
    return { ...fresh, updatedAt: at.toISOString() };
  } catch (error) {
    await recordRefreshFailure(db, record.id, at, error);
    throw error;
  }
}

/** Records a failed refresh on the catalog's row; a failure to record it is only logged. */
async function recordRefreshFailure(
  db: ReturnType<typeof createDb>,
  id: string,
  at: Date,
  error: unknown,
): Promise<void> {
  try {
    await recordCatalogRefresh(db, id, { at, error: messageOf(error).slice(0, 500) });
  } catch (recordError) {
    console.error("catalog refresh outcome not recorded", {
      catalog: id,
      error: messageOf(recordError),
    });
  }
}

/**
 * The official catalog's refresh (index, then its stats), recorded on its
 * row too. Throws `CatalogError`.
 */
export async function refreshOfficialCatalog(
  env: MergedEnv,
  opts: CatalogOptions = {},
): Promise<{ index: IndexJson; unreadable: number; updatedAt: string | null }> {
  const at = (opts.now ?? (() => new Date()))();
  const db = createDb(env.DB);
  try {
    const snapshot = await refreshCatalogIndex(env, opts);
    await recordCatalogRefresh(db, OFFICIAL_CATALOG_ID, { at, error: null });
    return snapshot;
  } catch (error) {
    await recordRefreshFailure(db, OFFICIAL_CATALOG_ID, at, error);
    throw error;
  }
}

/**
 * Every enabled catalog's index, the official one first. With
 * `refreshOnMiss` (the pages), a catalog with nothing cached is fetched
 * once; without it (jobs, the cron's own checks), only caches are read.
 */
export async function readEnabledCatalogs(
  env: MergedEnv,
  opts: CatalogOptions & { refreshOnMiss?: boolean } = {},
): Promise<CatalogIndexRead[]> {
  const records = (await listCatalogRecords(createDb(env.DB))).filter((r) => r.enabled);
  return Promise.all(records.map((r) => readOne(env, r, opts.refreshOnMiss ?? true, opts)));
}

/** Every app the reads list, by app key. */
export function listedApps(reads: readonly CatalogIndexRead[]): ListedApp[] {
  return reads.flatMap((read) =>
    read.ok
      ? read.index.apps.map((app) => ({
          key: appKey(read.source.id, app.slug),
          app,
          source: read.source,
          trust: read.trust,
        }))
      : [],
  );
}

/** A lookup of listed apps by app key. */
export type AppLookup = ReadonlyMap<string, ListedApp>;

/** The official catalog's badge, as its migration seeds it. */
export const OFFICIAL_SOURCE: CatalogSource = {
  id: OFFICIAL_CATALOG_ID,
  label: "Official",
  colour: "orange",
  official: true,
};

/**
 * A lookup of `apps` as one catalog lists them (the official one unless
 * `source` and `trust` say otherwise).
 */
export function lookupOf(
  apps: readonly IndexApp[],
  source: CatalogSource = OFFICIAL_SOURCE,
  trust: CatalogTrust = OFFICIAL_TRUST,
): AppLookup {
  return new Map(
    apps.map((app) => {
      const key = appKey(source.id, app.slug);
      return [key, { key, app, source, trust }];
    }),
  );
}

/** The listed apps of every enabled catalog, by app key. */
export async function catalogLookup(
  env: MergedEnv,
  opts: CatalogOptions & { refreshOnMiss?: boolean } = {},
): Promise<AppLookup> {
  return new Map(listedApps(await readEnabledCatalogs(env, opts)).map((l) => [l.key, l]));
}

export type FoundApp =
  | { ok: true; listed: ListedApp | null }
  | { ok: false; error: string; source: CatalogSource | null };

async function enabledRecord(env: MergedEnv, catalogId: string): Promise<CatalogRecord | null> {
  const records = await listCatalogRecords(createDb(env.DB));
  return records.find((r) => r.id === catalogId && r.enabled) ?? null;
}

function listingIn(read: CatalogIndexRead, slug: string): ListedApp | null {
  if (!read.ok) return null;
  const app = read.index.apps.find((a) => a.slug === slug);
  return app === undefined
    ? null
    : { key: appKey(read.source.id, slug), app, source: read.source, trust: read.trust };
}

/**
 * The app `key` names, from its catalog's index (fetched once when nothing
 * is cached). Null when its catalog is off, unknown, or does not list it.
 */
export async function findCatalogApp(
  env: MergedEnv,
  key: string,
  opts: CatalogOptions = {},
): Promise<FoundApp> {
  const { catalogId, slug } = parseAppKey(key);
  const record = await enabledRecord(env, catalogId);
  if (record === null) return { ok: true, listed: null };
  const read = await readOne(env, record, true, opts);
  if (!read.ok) return { ok: false, error: read.error, source: read.source };
  return { ok: true, listed: listingIn(read, slug) };
}

/**
 * The app `slug` of `catalogId` (null: the official catalog) in the cached
 * index, without fetching: jobs compare a request against what the admin
 * saw and never fetch an index themselves. Null when nothing is cached, the
 * catalog is off or unknown, or it does not list the app.
 */
export async function readCachedListing(
  env: MergedEnv,
  catalogId: string | null,
  slug: string,
): Promise<ListedApp | null> {
  const record = await enabledRecord(env, catalogId ?? OFFICIAL_CATALOG_ID);
  if (record === null) return null;
  return listingIn(await readOne(env, record, false, {}), slug);
}
