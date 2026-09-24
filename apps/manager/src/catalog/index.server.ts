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
  const url = catalogIndexUrl(env);
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const cached = await env.KV.getWithMetadata(CATALOG_INDEX_KEY);
  const cachedIndex = parseCached(cached.value);
  const etag = cachedIndex === null ? null : validatorFor(cached.metadata, url, CACHE_FORMAT);
  const result = await fetchCatalogJson(fetchImpl, url, etag, "catalog");
  let parsed: ParsedCatalogIndex;
  if (result.status === "not-modified" && cachedIndex !== null) {
    parsed = cachedIndex;
  } else if (result.status === "ok") {
    const fresh = parseCatalogIndex(result.json);
    if (fresh === null) {
      throw new CatalogError(`The catalog at ${url} returned an invalid index.json.`);
    }
    for (const entry of fresh.unreadable) {
      console.warn("catalog entry left out: this version of Appflare cannot read it", entry);
    }
    const stored = await storeIfChanged(
      env.KV,
      CATALOG_INDEX_KEY,
      JSON.stringify(fresh.raw),
      cached,
      {
        url,
        format: CACHE_FORMAT,
        etag: result.etag,
      },
    );
    if (stored !== "stored") console.log(`catalog index unchanged (${stored})`);
    parsed = fresh;
  } else {
    // Unreachable: a validator is only sent with a readable cached copy.
    throw new CatalogError(`The catalog at ${url} answered 304 with nothing cached.`);
  }
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

function parseCached(text: string | null): ParsedCatalogIndex | null {
  if (text === null) return null;
  try {
    return parseCatalogIndex(JSON.parse(text));
  } catch {
    return null;
  }
}

export type CatalogRead =
  | ({ ok: true } & CatalogSnapshot)
  | { ok: false; error: string; updatedAt: string | null };

/** The cached index; on a miss (or an unreadable entry) refreshes once. Never throws `CatalogError`. */
export async function getCatalogIndex(
  env: CatalogEnv,
  opts: CatalogOptions = {},
): Promise<CatalogRead> {
  const [text, updatedAt] = await Promise.all([
    env.KV.get(CATALOG_INDEX_KEY),
    env.KV.get(CATALOG_UPDATED_AT_KEY),
  ]);
  const cached = parseCached(text);
  if (cached !== null) {
    return { ok: true, index: cached.index, updatedAt, unreadable: cached.unreadable.length };
  }
  try {
    return { ok: true, ...(await refreshCatalogIndex(env, opts)) };
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    return { ok: false, error: error.message, updatedAt };
  }
}

/** One app from the cached index, or null when the index has no such slug. */
export async function getCatalogApp(
  env: CatalogEnv,
  slug: string,
  opts: CatalogOptions = {},
): Promise<{ ok: true; app: IndexApp | null } | { ok: false; error: string }> {
  const read = await getCatalogIndex(env, opts);
  if (!read.ok) return read;
  return { ok: true, app: read.index.apps.find((a) => a.slug === slug) ?? null };
}

/** The cached index without refreshing it; null when nothing readable is cached. */
export async function readCachedCatalogIndex(kv: KVNamespace): Promise<IndexJson | null> {
  return parseCached(await kv.get(CATALOG_INDEX_KEY))?.index ?? null;
}

/**
 * The app's entry in the cached index, without refreshing: jobs compare a
 * request against what the admin saw, and never fetch the index themselves.
 * Null when nothing is cached or the app is not listed.
 */
export async function readCachedCatalogApp(
  kv: KVNamespace,
  slug: string,
): Promise<IndexApp | null> {
  return (await readCachedCatalogIndex(kv))?.apps.find((a) => a.slug === slug) ?? null;
}
