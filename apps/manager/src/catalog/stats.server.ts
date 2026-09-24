import type { FetchLike } from "@appflare/cf-api";
import {
  type CatalogAppStats,
  type CatalogStats,
  catalogAppStatsSchema,
  catalogStatsSchema,
} from "@appflare/schema";
import { z } from "zod";
import { fetchCatalogJson, storeIfChanged, validatorFor } from "./conditional-fetch";

/**
 * The catalog's popularity file (`stats.json`, at the index's `stats` URL),
 * cached in KV under `catalog:stats`. The cron fetches it right after the
 * index, with `If-None-Match`, and rewrites the cached copy only when it
 * changed (the catalog rebuilds it about hourly, so at most about 24 KV
 * writes a day). The manager never asks GitHub or the analytics service for
 * these numbers itself.
 */

export const CATALOG_STATS_KEY = "catalog:stats";

/** Bumped when what is cached under `catalog:stats` changes shape. */
const CACHE_FORMAT = 1;

const statsEnvelopeSchema = z.object({
  generatedAt: z.iso.datetime(),
  apps: z.record(z.string(), z.unknown()),
  sources: catalogStatsSchema.shape.sources,
});

/**
 * `stats.json`, keeping every app entry this manager can read (a newer
 * catalog may publish fields or shapes it does not know). Null when the
 * envelope itself is invalid.
 */
export function parseCatalogStats(json: unknown): CatalogStats | null {
  const envelope = statsEnvelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  const apps: Record<string, CatalogAppStats> = {};
  for (const [slug, entry] of Object.entries(envelope.data.apps)) {
    const parsed = catalogAppStatsSchema.safeParse(entry);
    if (parsed.success) apps[slug] = parsed.data;
  }
  return { ...envelope.data, apps };
}

/**
 * Fetches `url` and caches it when it changed. Returns the stats now cached.
 * Throws (with a message safe to log) when the fetch fails or the file is
 * invalid; the cached copy is then left as it was.
 */
export async function refreshCatalogStats(
  kv: KVNamespace,
  url: string,
  opts: { fetch?: FetchLike } = {},
): Promise<CatalogStats> {
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const cached = await kv.getWithMetadata(CATALOG_STATS_KEY);
  const cachedStats = parseCached(cached.value);
  const etag = cachedStats === null ? null : validatorFor(cached.metadata, url, CACHE_FORMAT);
  const result = await fetchCatalogJson(fetchImpl, url, etag, "catalog stats");
  if (result.status === "not-modified" && cachedStats !== null) return cachedStats;
  if (result.status === "not-modified") throw new Error(`catalog stats at ${url}: unexpected 304`);
  const stats = parseCatalogStats(result.json);
  if (stats === null) throw new Error(`The catalog stats at ${url} are not a valid stats.json.`);
  const stored = await storeIfChanged(kv, CATALOG_STATS_KEY, JSON.stringify(stats), cached, {
    url,
    format: CACHE_FORMAT,
    etag: result.etag,
  });
  if (stored !== "stored") console.log(`catalog stats unchanged (${stored})`);
  return stats;
}

function parseCached(text: string | null): CatalogStats | null {
  if (text === null) return null;
  try {
    return parseCatalogStats(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The cached stats, or null when none are cached. Never fetches. */
export async function readCatalogStats(kv: KVNamespace): Promise<CatalogStats | null> {
  return parseCached(await kv.get(CATALOG_STATS_KEY));
}
