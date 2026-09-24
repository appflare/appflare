import type { FetchLike } from "@appflare/cf-api";
import { type IndexApp, type IndexJson, indexAppSchema } from "@appflare/schema";
import { z } from "zod";

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

const indexEnvelopeSchema = z.object({
  generatedAt: z.iso.datetime(),
  apps: z.array(z.unknown()),
});

/** An index entry this manager could not read, and why. */
export interface UnreadableEntry {
  /** The entry's `slug`, when it has a readable one. */
  slug: string | null;
  problem: string;
}

export interface ParsedCatalogIndex {
  /** Every entry this manager can read. */
  index: IndexJson;
  unreadable: UnreadableEntry[];
  /** What to cache: the envelope with every entry as published, read again on each use. */
  raw: { generatedAt: string; apps: unknown[] };
}

/**
 * `index.json`, keeping every entry this manager can read. An entry it
 * cannot (a newer tier or field shape) is left out and reported rather than
 * failing the whole catalog, so a catalog that grows new kinds of entries
 * never breaks managers that predate them. Null when the envelope itself is
 * invalid.
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
    const slug =
      typeof entry === "object" &&
      entry !== null &&
      "slug" in entry &&
      typeof entry.slug === "string"
        ? entry.slug
        : null;
    unreadable.push({
      slug,
      problem: z.prettifyError(app.error).replace(/\s+/g, " ").slice(0, 300),
    });
  }
  return {
    index: { generatedAt: envelope.data.generatedAt, apps },
    unreadable,
    raw: envelope.data,
  };
}

export interface CatalogSnapshot {
  index: IndexJson;
  /** ISO 8601 time of the last successful refresh. */
  updatedAt: string | null;
  /** Entries of the published index this version of Appflare could not read. */
  unreadable: number;
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
  const parsed = parseCatalogIndex(json);
  if (parsed === null) {
    throw new CatalogError(`The catalog at ${url} returned an invalid index.json.`);
  }
  for (const entry of parsed.unreadable) {
    console.warn("catalog entry left out: this version of Appflare cannot read it", entry);
  }
  const text = JSON.stringify(parsed.raw);
  const updatedAt = (opts.now ?? (() => new Date()))().toISOString();
  const cached = await env.KV.get(CATALOG_INDEX_KEY);
  if (cached !== text) await env.KV.put(CATALOG_INDEX_KEY, text);
  await env.KV.put(CATALOG_UPDATED_AT_KEY, updatedAt);
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
  return (
    parseCached(await kv.get(CATALOG_INDEX_KEY))?.index.apps.find((a) => a.slug === slug) ?? null
  );
}
