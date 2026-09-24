import type { FetchLike } from "@appflare/cf-api";
import type { IndexApp } from "@appflare/schema";
import { type AppFacts, appFacts, indexHasFacts } from "./app-facts";
import {
  type AppManifestEnv,
  type AppManifestOptions,
  getCatalogManifest,
  readCachedCatalogManifest,
} from "./app-manifest.server";

/**
 * The facts of the catalog list's apps. The catalog index publishes them per
 * app, so the list normally reads no manifest at all. For rows of an older
 * index the page answers from the manifests
 * already cached in KV and never waits on GitHub: manifests not cached yet
 * are fetched after the response (`defer`, the Worker's `waitUntil`), a few
 * per view, so the next view shows them. A manifest that could not be read
 * is not tried again for an hour, so a broken release never takes the slots
 * of the others.
 */

/**
 * Manifests fetched after one view. Each costs up to 4 subrequests (the
 * manifest and its signature, each through a release redirect), so a view
 * stays far below the 50 a request may make.
 */
export const LIST_MANIFEST_FETCHES = 4;

/** How long a manifest that failed to load is left alone. */
export const MANIFEST_FAILURE_TTL_SECONDS = 60 * 60;

/** How long one background manifest fetch may take. */
export const MANIFEST_FETCH_TIMEOUT_MS = 10_000;

/** KV key remembering that `app`'s current version could not be read. */
export function manifestFailureKey(app: Pick<IndexApp, "slug" | "version">): string {
  return `catalog:manifest-failed:${app.slug}@${app.version}`;
}

/** `fetch` with a time limit on every call. */
function withTimeout(fetchImpl: FetchLike, ms: number): FetchLike {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Fetches (and so caches) `app`'s manifest; a failure is remembered for an hour. */
async function warmManifest(
  env: AppManifestEnv,
  app: IndexApp,
  opts: AppManifestOptions,
): Promise<void> {
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  let ok = false;
  try {
    const read = await getCatalogManifest(env, app, {
      ...opts,
      fetch: withTimeout(fetchImpl, MANIFEST_FETCH_TIMEOUT_MS),
    });
    ok = read.ok;
    if (!read.ok) console.warn("catalog manifest not read", { slug: app.slug, error: read.error });
  } catch (error) {
    console.warn("catalog manifest not read", {
      slug: app.slug,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!ok) {
    await env.KV.put(manifestFailureKey(app), "1", {
      expirationTtl: MANIFEST_FAILURE_TTL_SECONDS,
    });
  }
}

/**
 * The facts of every app, by slug. A row that publishes its services and
 * categories answers alone, with no KV read. The others (rows from an index
 * written before the catalog published them) use cached manifests only, and
 * up to {@link LIST_MANIFEST_FETCHES} uncached manifests that have not failed
 * within the hour are handed to `defer` to be fetched.
 */
export async function listAppFacts(
  env: AppManifestEnv,
  apps: readonly IndexApp[],
  defer: (work: Promise<unknown>) => void,
  opts: AppManifestOptions = {},
): Promise<Map<string, AppFacts>> {
  const facts = new Map<string, AppFacts>();
  const needManifest: IndexApp[] = [];
  for (const app of apps) {
    if (indexHasFacts(app)) facts.set(app.slug, appFacts(app, null));
    else needManifest.push(app);
  }
  const cached = await Promise.all(needManifest.map((app) => readCachedCatalogManifest(env, app)));
  const uncached: IndexApp[] = [];
  needManifest.forEach((app, i) => {
    const read = cached[i] ?? null;
    facts.set(app.slug, appFacts(app, read));
    if (read === null) uncached.push(app);
  });
  const failed = await Promise.all(
    uncached.map(async (app) => (await env.KV.get(manifestFailureKey(app))) !== null),
  );
  const toFetch = uncached.filter((_, i) => !failed[i]).slice(0, LIST_MANIFEST_FETCHES);
  if (toFetch.length > 0) {
    defer(Promise.all(toFetch.map((app) => warmManifest(env, app, opts))));
  }
  return facts;
}
