import type { FetchLike } from "@appflare/cf-api";
import {
  type FeaturedItem,
  featuredItemSchema,
  type IndexApp,
  type IndexJson,
  indexAppSchema,
} from "@appflare/schema";
import { z } from "zod";
import { CatalogError, fetchCatalogJson, storeIfChanged, validatorFor } from "./conditional-fetch";
import { refreshCatalogStats } from "./stats.server";

export { CatalogError } from "./conditional-fetch";

/**
 * The catalog index cache. `index.json` is fetched from the
 * catalog, validated, and kept in KV under `catalog:index` with the time of the
 * last successful refresh under `catalog:updatedAt`. The cron refreshes it every
 * 30 minutes; a read that finds nothing cached refreshes once.
 *
 * KV writes are scarce on the free plan (1,000 a day): the index body is only
 * rewritten when its sha256 or its ETag changed (see `conditional-fetch.ts`),
 * so a steady catalog costs one write per refresh (the refresh time). The ETag
 * rides along as the cached value's KV metadata and is sent back as
 * `If-None-Match`, so an index that was not redeployed costs no bandwidth.
 *
 * When the index names a `stats` file, it is refreshed right after the index
 * (see `stats.server.ts`); a stats failure is logged and never fails the index.
 */

export const DEFAULT_CATALOG_INDEX_URL = "https://appflare.github.io/catalog/index.json";

export const CATALOG_INDEX_KEY = "catalog:index";
export const CATALOG_UPDATED_AT_KEY = "catalog:updatedAt";

/**
 * Bumped when what is cached under `catalog:index` changes shape, so a
 * manager never answers a `304` with a copy an older version cached
 * without the fields it now keeps.
 */
const CACHE_FORMAT = 1;

export interface CatalogEnv {
  KV: KVNamespace;
  CATALOG_INDEX_URL?: string;
}

export interface CatalogOptions {
  fetch?: FetchLike;
  now?: () => Date;
}

export function catalogIndexUrl(env: Pick<CatalogEnv, "CATALOG_INDEX_URL">): string {
  const configured = env.CATALOG_INDEX_URL?.trim();
  return configured ? configured : DEFAULT_CATALOG_INDEX_URL;
}

const indexEnvelopeSchema = z.object({
  generatedAt: z.iso.datetime(),
  apps: z.array(z.unknown()),
  featured: z.array(z.unknown()).optional(),
  stats: z.unknown().optional(),
});

/** A stats URL this manager will fetch: http(s) only (http for a local development catalog). */
const statsUrlSchema = z.url({ protocol: /^https?$/ });

/** An index entry this manager could not read, and why. */
export interface UnreadableEntry {
  /** The entry's `slug`, when it has a readable one. */
  slug: string | null;
  problem: string;
}

/** What is cached: the envelope with every entry as published, read again on each use. */
export interface RawCatalogIndex {
  generatedAt: string;
  apps: unknown[];
  featured?: unknown[];
  stats?: unknown;
}

export interface ParsedCatalogIndex {
  /** Every entry this manager can read. */
  index: IndexJson;
  unreadable: UnreadableEntry[];
  raw: RawCatalogIndex;
}

function slugOf(entry: unknown): string | null {
  return typeof entry === "object" &&
    entry !== null &&
    "slug" in entry &&
    typeof entry.slug === "string"
    ? entry.slug
    : null;
}

/**
 * `index.json`, keeping every entry this manager can read. An entry it
 * cannot (a newer tier or field shape) is left out and reported rather than
 * failing the whole catalog, so a catalog that grows new kinds of entries
 * never breaks managers that predate them. Featured items are read the same
 * way, one at a time; an unreadable one (or one promoting an app this
 * manager cannot read) is dropped. Null when the envelope itself is invalid.
 */
export function parseCatalogIndex(json: unknown): ParsedCatalogIndex | null {
  const envelope = indexEnvelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  const apps: IndexApp[] = [];
  const unreadable: UnreadableEntry[] = [];
  for (const entry of envelope.data.apps) {
    const app = indexAppSchema.safeParse(entry);
    if (app.success) {
      apps.push(app.data);
      continue;
    }
    unreadable.push({
      slug: slugOf(entry),
      problem: z.prettifyError(app.error).replace(/\s+/g, " ").slice(0, 300),
    });
  }
  const slugs = new Set(apps.map((a) => a.slug));
  const featured: FeaturedItem[] = [];
  for (const entry of envelope.data.featured ?? []) {
    const item = featuredItemSchema.safeParse(entry);
    if (!item.success) continue;
    if (item.data.slug !== undefined && !slugs.has(item.data.slug)) continue;
    if (featured.some((f) => f.id === item.data.id)) continue;
    featured.push(item.data);
  }
  const stats = statsUrlSchema.safeParse(envelope.data.stats);
  const { generatedAt } = envelope.data;
  const raw: RawCatalogIndex = { generatedAt, apps: envelope.data.apps };
  if (envelope.data.featured !== undefined) raw.featured = envelope.data.featured;
  if (envelope.data.stats !== undefined) raw.stats = envelope.data.stats;
  return {
    index: { generatedAt, apps, featured, ...(stats.success ? { stats: stats.data } : {}) },
    unreadable,
    raw,
  };
}

export interface CatalogSnapshot {
  index: IndexJson;
  /** ISO 8601 time of the last successful refresh. */
  updatedAt: string | null;
  /** Entries of the published index this version of Appflare could not read. */
  unreadable: number;
}

/**
 * Fetches (conditionally), validates, and caches `index.json`, then the
 * stats file it names. Throws `CatalogError` for the index only.
 */
export async function refreshCatalogIndex(
  env: CatalogEnv,
  opts: CatalogOptions = {},
): Promise<CatalogSnapshot> {
  const parsed = await fetchAndStore(env.KV, CATALOG_INDEX_KEY, catalogIndexUrl(env), opts);
  const updatedAt = (opts.now ?? (() => new Date()))().toISOString();
  await env.KV.put(CATALOG_UPDATED_AT_KEY, updatedAt);
  const statsUrl = parsed.index.stats;
  if (statsUrl !== undefined) {
    try {
      await refreshCatalogStats(env.KV, statsUrl, opts.fetch ? { fetch: opts.fetch } : {});
    } catch (error) {
      console.error("catalog stats refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { index: parsed.index, updatedAt, unreadable: parsed.unreadable.length };
}

/**
 * Fetches `url` (conditionally, with the ETag of the copy cached under
 * `key`), validates it, and caches it when it changed. Returns the index now
 * cached. Throws `CatalogError`.
 */
async function fetchAndStore(
  kv: KVNamespace,
  key: string,
  url: string,
  opts: CatalogOptions,
): Promise<ParsedCatalogIndex> {
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const cached = await kv.getWithMetadata(key);
  const cachedIndex = parseCached(key, cached.value);
  const etag = cachedIndex === null ? null : validatorFor(cached.metadata, url, CACHE_FORMAT);
  const result = await fetchCatalogJson(fetchImpl, url, etag, "catalog");
  if (result.status === "not-modified" && cachedIndex !== null) return cachedIndex;
  if (result.status !== "ok") {
    // Unreachable: a validator is only sent with a readable cached copy.
    throw new CatalogError(`The catalog at ${url} answered 304 with nothing cached.`);
  }
  const fresh = parseCatalogIndex(result.json);
  if (fresh === null) {
    throw new CatalogError(`The catalog at ${url} returned an invalid index.json.`);
  }
  for (const entry of fresh.unreadable) {
    console.warn("catalog entry left out: this version of Appflare cannot read it", entry);
  }
  await storeFetchedIndex(kv, key, url, fresh, result.etag, cached);
  return fresh;
}

async function storeFetchedIndex(
  kv: KVNamespace,
  key: string,
  url: string,
  fresh: ParsedCatalogIndex,
  etag: string | null,
  cached: { value: string | null; metadata: unknown },
): Promise<void> {
  const stored = await storeIfChanged(kv, key, JSON.stringify(fresh.raw), cached, {
    url,
    format: CACHE_FORMAT,
    etag,
  });
  if (stored !== "stored") console.log(`catalog index unchanged (${stored})`);
}

/**
 * The last parse of each cached index in this isolate, by KV key, with the
 * exact text it was parsed from. An index is only rewritten when it changed,
 * so most reads find the same text again and skip parsing and validating
 * every entry. Callers share the parsed index: it is read, never changed.
 */
const parsedByKey = new Map<string, { text: string; parsed: ParsedCatalogIndex }>();

/** Test-only: forget every parse. */
export function forgetParsedIndexes(): void {
  parsedByKey.clear();
}

/** The cached text under `key`, parsed; once per version of the text in an isolate. */
function parseCached(key: string, text: string | null): ParsedCatalogIndex | null {
  if (text === null) return null;
  const held = parsedByKey.get(key);
  if (held !== undefined && held.text === text) return held.parsed;
  let parsed: ParsedCatalogIndex | null;
  try {
    parsed = parseCatalogIndex(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (parsed === null) parsedByKey.delete(key);
  else parsedByKey.set(key, { text, parsed });
  return parsed;
}

/**
 * KV key of a custom catalog's cached index. The official catalog keeps
 * `catalog:index`, so an older version of Appflare still finds it.
 */
export function customCatalogIndexKey(catalogId: string): string {
  return `catalog:${catalogId}:index`;
}

/** Where a custom catalog's index is fetched from, and whose it is. */
export interface CustomIndexLocation {
  catalogId: string;
  url: string;
}

/** A custom catalog's readable index, as its pages use it. */
export interface CustomCatalogIndex {
  index: IndexJson;
  /** Entries this version of Appflare could not read. */
  unreadable: number;
}

/**
 * What a custom catalog's index is used for: its apps, without images (they
 * show monograms), without a sponsored slot and without popularity. The
 * media proxy, the avatar proxy, the stats file and the sponsored slot
 * belong to the official catalog alone, so nothing a custom index lists is
 * ever fetched besides its releases and revised catalog manifests.
 */
function customView(parsed: ParsedCatalogIndex): CustomCatalogIndex {
  const apps = parsed.index.apps.map(({ media: _media, ...app }) => app);
  return {
    index: { generatedAt: parsed.index.generatedAt, apps, featured: [] },
    unreadable: parsed.unreadable.length,
  };
}

/**
 * Fetches (conditionally) and caches a custom catalog's index. One request,
 * with the ETag of the cached copy; the body is rewritten only when it
 * changed. Throws `CatalogError`.
 */
export async function refreshCustomCatalogIndex(
  kv: KVNamespace,
  location: CustomIndexLocation,
  opts: CatalogOptions = {},
): Promise<CustomCatalogIndex> {
  return customView(
    await fetchAndStore(kv, customCatalogIndexKey(location.catalogId), location.url, opts),
  );
}

/**
 * Caches an index a custom catalog was just checked with (when an admin adds
 * it), so its apps show at once. Written only when it differs from the copy
 * cached for the same URL.
 */
export async function cacheCustomCatalogIndex(
  kv: KVNamespace,
  location: CustomIndexLocation,
  fresh: ParsedCatalogIndex,
  etag: string | null,
): Promise<void> {
  const key = customCatalogIndexKey(location.catalogId);
  await storeFetchedIndex(kv, key, location.url, fresh, etag, await kv.getWithMetadata(key));
}

/** A custom catalog's cached index, without fetching; null when nothing readable is cached. */
export async function readCachedCustomCatalogIndex(
  kv: KVNamespace,
  catalogId: string,
): Promise<CustomCatalogIndex | null> {
  const key = customCatalogIndexKey(catalogId);
  const parsed = parseCached(key, await kv.get(key));
  return parsed === null ? null : customView(parsed);
}

/**
 * Drops everything cached for a custom catalog (`catalog:<id>:*`: its index,
 * the manifests its keys verified, their failures), when it is removed or
 * its keys change.
 */
export async function forgetCustomCatalogCaches(kv: KVNamespace, catalogId: string): Promise<void> {
  const prefix = `catalog:${catalogId}:`;
  let cursor: string | undefined;
  for (;;) {
    const page: KVNamespaceListResult<unknown, string> = await kv.list(
      cursor === undefined ? { prefix } : { prefix, cursor },
    );
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    if (page.list_complete) return;
    cursor = page.cursor;
  }
}

export type CatalogRead =
  | ({ ok: true } & CatalogSnapshot)
  | { ok: false; error: string; updatedAt: string | null };

/** What KV holds of the official catalog's index, without refreshing it. */
export interface CachedCatalogIndex {
  /** Null when nothing readable is cached. */
  snapshot: CatalogSnapshot | null;
  /** The time of the last successful refresh, cached or not. */
  updatedAt: string | null;
}

/** The official catalog's cached index and refresh time (two KV reads, together). */
export async function readCachedCatalogSnapshot(kv: KVNamespace): Promise<CachedCatalogIndex> {
  const [text, updatedAt] = await Promise.all([
    kv.get(CATALOG_INDEX_KEY),
    kv.get(CATALOG_UPDATED_AT_KEY),
  ]);
  const cached = parseCached(CATALOG_INDEX_KEY, text);
  return {
    snapshot:
      cached === null
        ? null
        : { index: cached.index, updatedAt, unreadable: cached.unreadable.length },
    updatedAt,
  };
}

/**
 * The cached index; on a miss (or an unreadable entry) refreshes once. Never
 * throws `CatalogError`. `cached` is what the caller already read from KV.
 */
export async function getCatalogIndex(
  env: CatalogEnv,
  opts: CatalogOptions = {},
  cached?: CachedCatalogIndex,
): Promise<CatalogRead> {
  const { snapshot, updatedAt } = cached ?? (await readCachedCatalogSnapshot(env.KV));
  if (snapshot !== null) return { ok: true, ...snapshot };
  try {
    return { ok: true, ...(await refreshCatalogIndex(env, opts)) };
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    return { ok: false, error: error.message, updatedAt };
  }
}

/** The cached index without refreshing it; null when nothing readable is cached. */
export async function readCachedCatalogIndex(kv: KVNamespace): Promise<IndexJson | null> {
  return parseCached(CATALOG_INDEX_KEY, await kv.get(CATALOG_INDEX_KEY))?.index ?? null;
}
