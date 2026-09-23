import type { FetchLike } from "@appflare/cf-api";
import { type IndexApp, type IndexJson, indexJsonSchema } from "@appflare/schema";

/**
 * The catalog index cache. `index.json` is fetched from the
 * catalog, validated, and kept in KV under `catalog:index` with the time of the
 * last successful refresh under `catalog:updatedAt`. The cron refreshes it every
 * 30 minutes; a read that finds nothing cached refreshes once.
 *
 * KV writes are scarce on the free plan (1,000 a day): the index body is only
 * rewritten when it changed, so a steady catalog costs one write per refresh.
 */

export const DEFAULT_CATALOG_INDEX_URL = "https://appflare.github.io/catalog/index.json";

export const CATALOG_INDEX_KEY = "catalog:index";
export const CATALOG_UPDATED_AT_KEY = "catalog:updatedAt";

export interface CatalogEnv {
  KV: KVNamespace;
  CATALOG_INDEX_URL?: string;
}

export interface CatalogOptions {
  fetch?: FetchLike;
  now?: () => Date;
}

/** Why the index could not be loaded; the message is safe to show. */
export class CatalogError extends Error {
  override name = "CatalogError";
}

export function catalogIndexUrl(env: Pick<CatalogEnv, "CATALOG_INDEX_URL">): string {
  const configured = env.CATALOG_INDEX_URL?.trim();
  return configured ? configured : DEFAULT_CATALOG_INDEX_URL;
}

export interface CatalogSnapshot {
  index: IndexJson;
  /** ISO 8601 time of the last successful refresh. */
  updatedAt: string | null;
}

/** Fetches, validates, and caches `index.json`. Throws `CatalogError`. */
export async function refreshCatalogIndex(
  env: CatalogEnv,
  opts: CatalogOptions = {},
): Promise<CatalogSnapshot> {
  const url = catalogIndexUrl(env);
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new CatalogError(
      `Could not reach the catalog at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CatalogError(`The catalog at ${url} answered HTTP ${response.status}.`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new CatalogError(`The catalog at ${url} did not return JSON.`);
  }
  const parsed = indexJsonSchema.safeParse(json);
  if (!parsed.success) {
    throw new CatalogError(`The catalog at ${url} returned an invalid index.json.`);
  }
  const text = JSON.stringify(parsed.data);
  const updatedAt = (opts.now ?? (() => new Date()))().toISOString();
  const cached = await env.KV.get(CATALOG_INDEX_KEY);
  if (cached !== text) await env.KV.put(CATALOG_INDEX_KEY, text);
  await env.KV.put(CATALOG_UPDATED_AT_KEY, updatedAt);
  return { index: parsed.data, updatedAt };
}

function parseCached(text: string | null): IndexJson | null {
  if (text === null) return null;
  try {
    const parsed = indexJsonSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
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
  const index = parseCached(text);
  if (index !== null) return { ok: true, index, updatedAt };
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

/**
 * The app's entry in the cached index, without refreshing: jobs compare a
 * request against what the admin saw, and never fetch the index themselves.
 * Null when nothing is cached or the app is not listed.
 */
export async function readCachedCatalogApp(
  kv: KVNamespace,
  slug: string,
): Promise<IndexApp | null> {
  return parseCached(await kv.get(CATALOG_INDEX_KEY))?.apps.find((a) => a.slug === slug) ?? null;
}
