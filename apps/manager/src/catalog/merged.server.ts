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
  type CachedCatalogIndex,
  type CatalogEnv,
  CatalogError,
  type CatalogOptions,
  type CustomCatalogIndex,
  getCatalogIndex,
  readCachedCatalogIndex,
  readCachedCatalogSnapshot,
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
 * A catalog's cached index, read from KV before its record was known: the
 * KV key depends only on the catalog's id, so the read goes alongside the
 * record's.
 */
type PrefetchedIndex =
  | { kind: "official"; cached: CachedCatalogIndex }
  | { kind: "custom"; cached: CustomCatalogIndex | null };

/**
 * Reads the cached index of the catalog `catalogId` without its record.
 * Never throws: when KV fails, the read is left to `readOne`, which reports it.
 */
async function prefetchIndex(
  env: MergedEnv,
  catalogId: string,
): Promise<PrefetchedIndex | undefined> {
  try {
    return catalogId === OFFICIAL_CATALOG_ID
      ? { kind: "official", cached: await readCachedCatalogSnapshot(env.KV) }
      : { kind: "custom", cached: await readCachedCustomCatalogIndex(env.KV, catalogId) };
  } catch {
    return undefined;
  }
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
  prefetched?: PrefetchedIndex,
): Promise<CatalogIndexRead> {
  const source = sourceOf(record);
  const trust = trustOf(record);
  try {
    return await readOneOrThrow(env, record, refreshOnMiss, opts, prefetched);
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
  prefetched?: PrefetchedIndex,
): Promise<CatalogIndexRead> {
  const source = sourceOf(record);
  const trust = trustOf(record);
  if (record.kind === "official") {
    const cached = prefetched?.kind === "official" ? prefetched.cached : undefined;
    if (refreshOnMiss) return { source, trust, ...(await getCatalogIndex(env, opts, cached)) };
    const index =
      cached === undefined
        ? await readCachedCatalogIndex(env.KV)
        : (cached.snapshot?.index ?? null);
    return index === null
      ? { source, trust, ok: false, error: "The catalog has not been loaded yet.", updatedAt: null }
      : { source, trust, ok: true, index, updatedAt: null, unreadable: 0 };
  }
  const updatedAt = record.refreshedAt?.toISOString() ?? null;
  const cached =
    prefetched?.kind === "custom"
      ? prefetched.cached
      : await readCachedCustomCatalogIndex(env.KV, record.id);
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
 * `records` are the catalogs as the caller already read them
 * (`listCatalogRecords`), which saves reading them again, or are being read
 * (a promise). Unless they are already read, the official catalog's cached
 * index is read alongside them (it is almost always on).
 */
export async function readEnabledCatalogs(
  env: MergedEnv,
  opts: CatalogOptions & { refreshOnMiss?: boolean } = {},
  records?: readonly CatalogRecord[] | Promise<readonly CatalogRecord[]>,
): Promise<CatalogIndexRead[]> {
  const early = Array.isArray(records) ? undefined : prefetchIndex(env, OFFICIAL_CATALOG_ID);
  const all = await (records ?? listCatalogRecords(createDb(env.DB)));
  const official = await early;
  const enabled = all.filter((r) => r.enabled);
  return Promise.all(
    enabled.map((r) =>
      readOne(
        env,
        r,
        opts.refreshOnMiss ?? true,
        opts,
        r.kind === "official" ? official : undefined,
      ),
    ),
  );
}

/** Catalogs whose refresh this isolate has under way, so page loads start one each. */
const refreshing = new Set<string>();

/**
 * For a page that reads only cached indexes: every enabled catalog with
 * nothing cached is fetched after the answer is sent (`background`, the
 * Worker's `waitUntil`), so the next page load has it without waiting for
 * the cron. One refresh per catalog at a time in an isolate; a failure is
 * recorded on the catalog's row and logged.
 */
export function refreshMissingInBackground(
  env: MergedEnv,
  reads: readonly CatalogIndexRead[],
  records: readonly CatalogRecord[],
  background: (promise: Promise<unknown>) => void,
  opts: CatalogOptions = {},
): void {
  for (const read of reads) {
    if (read.ok || refreshing.has(read.source.id)) continue;
    const record = records.find((r) => r.id === read.source.id);
    if (record === undefined) continue;
    refreshing.add(record.id);
    const refresh =
      record.kind === "official"
        ? refreshOfficialCatalog(env, opts)
        : refreshCustomCatalog(env, record, opts);
    background(
      refresh
        .catch((error: unknown) => {
          console.error("catalog refresh after a page load failed", {
            catalog: record.id,
            error: messageOf(error),
          });
        })
        .finally(() => refreshing.delete(record.id)),
    );
  }
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
  | {
      ok: true;
      listed: ListedApp | null;
      /** The index of the catalog it was looked up in; null when that catalog is off or unknown. */
      index: IndexJson | null;
    }
  | { ok: false; error: string; source: CatalogSource | null };

async function enabledRecord(
  env: MergedEnv,
  catalogId: string,
  records?: Promise<readonly CatalogRecord[]>,
): Promise<CatalogRecord | null> {
  const all = await (records ?? listCatalogRecords(createDb(env.DB)));
  return all.find((r) => r.id === catalogId && r.enabled) ?? null;
}

function listingIn(read: CatalogIndexRead, slug: string): ListedApp | null {
  if (!read.ok) return null;
  const app = read.index.apps.find((a) => a.slug === slug);
  return app === undefined
    ? null
    : { key: appKey(read.source.id, slug), app, source: read.source, trust: read.trust };
}

/**
 * The first half of {@link findCatalogApp}: what a lookup reads from D1 and
 * KV, without fetching anything. A page that must check the session before
 * anything is fetched reads this alongside the session, then finishes with
 * {@link finishCatalogLookup}.
 */
export interface CatalogLookupStart {
  key: string;
  record: CatalogRecord | null;
  prefetched: PrefetchedIndex | undefined;
}

export async function startCatalogLookup(
  env: MergedEnv,
  key: string,
  /** The catalogs' records, when the caller reads them anyway. */
  records?: Promise<readonly CatalogRecord[]>,
): Promise<CatalogLookupStart> {
  const { catalogId } = parseAppKey(key);
  // The cached index is read alongside the catalog's record, not after it.
  const [record, prefetched] = await Promise.all([
    enabledRecord(env, catalogId, records),
    prefetchIndex(env, catalogId),
  ]);
  return { key, record, prefetched };
}

/**
 * The second half of {@link findCatalogApp}: the listing, from the cached
 * index read at the start (no further I/O), or fetched once when nothing
 * was cached.
 */
export async function finishCatalogLookup(
  env: MergedEnv,
  start: CatalogLookupStart,
  opts: CatalogOptions = {},
): Promise<FoundApp> {
  const { record, prefetched } = start;
  if (record === null) return { ok: true, listed: null, index: null };
  const read = await readOne(env, record, true, opts, prefetched);
  if (!read.ok) return { ok: false, error: read.error, source: read.source };
  return { ok: true, listed: listingIn(read, parseAppKey(start.key).slug), index: read.index };
}

/**
 * The app `key` names, from its catalog's index (fetched once when nothing
 * is cached). Null when its catalog is off, unknown, or does not list it.
 */
export async function findCatalogApp(
  env: MergedEnv,
  key: string,
  opts: CatalogOptions = {},
  /** The catalogs' records, when the caller reads them anyway. */
  records?: Promise<readonly CatalogRecord[]>,
): Promise<FoundApp> {
  return finishCatalogLookup(env, await startCatalogLookup(env, key, records), opts);
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
  const id = catalogId ?? OFFICIAL_CATALOG_ID;
  // The cached index is read alongside the catalog's record, not after it.
  const [record, prefetched] = await Promise.all([enabledRecord(env, id), prefetchIndex(env, id)]);
  if (record === null) return null;
  return listingIn(await readOne(env, record, false, {}, prefetched), slug);
}
