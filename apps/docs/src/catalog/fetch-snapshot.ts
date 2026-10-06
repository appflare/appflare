import { createHash } from "node:crypto";
import { type IndexApp, type IndexJson, indexJsonSchema, readIndexJson } from "@appflare/schema";
import { type OgPicture, pngPicture } from "../og/picture.ts";
import {
  type AppLinks,
  appLinksSchema,
  type CatalogSnapshot,
  parseCatalogSnapshot,
  snapshotProblems,
} from "./snapshot.ts";
import { CATALOG_ORIGIN, catalogMediaUrl } from "./urls.ts";

/**
 * Takes a snapshot of the published catalog for the build: `index.json`, the
 * stats file the index names, and each app's repository and homepage from its
 * catalog manifest, fetched a few at a time with retries. Every file whose
 * digest the index gives is checked against it. Any failure throws, so the
 * build fails and the site already deployed stays up.
 */

/** Where the official catalog publishes its index. */
export const CATALOG_BASE_URL = `${CATALOG_ORIGIN}/catalog/`;

export interface FetchSnapshotOptions {
  /** The catalog's address, ending in `/`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Requests in flight at once. */
  concurrency?: number;
  /** Tries per file before the build fails. */
  attempts?: number;
  /** The wait before the second try; it doubles for each try after. */
  retryDelayMs?: number;
  now?: () => Date;
  /**
   * Only these apps (and the sponsored items and stats that concern them),
   * for writing a small snapshot such as the checked-in fixture.
   */
  only?: readonly string[];
  /** Whether to fetch the icons and first screenshots for OpenGraph cards; true by default. */
  ogMedia?: boolean;
}

export interface FetchedCatalog {
  snapshot: CatalogSnapshot;
  /**
   * The icon of each app, as a data URI, for the OpenGraph cards that show
   * it: the cards are drawn during the build, which reads no network.
   */
  ogIcons: Record<string, string>;
  /** The first screenshot of each app that has one (a PNG), for the same cards. */
  ogScreenshots: Record<string, OgPicture>;
}

/** The largest icon drawn into an OpenGraph card. */
const MAX_ICON_BYTES = 1024 * 1024;
/** The largest screenshot drawn into an OpenGraph card. */
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Runs `work` over `items` with at most `limit` running at once, keeping the order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Where an app's catalog manifest is, and the digest of its bytes. */
export function manifestSource(
  app: Pick<IndexApp, "catalogManifest" | "build" | "artifacts">,
): { url: string; sha256: string; inRelease: boolean } | null {
  // A revised entry's current manifest wins over the copy in its release.
  if (app.catalogManifest !== undefined) {
    return { url: app.catalogManifest.url, sha256: app.catalogManifest.sha256, inRelease: false };
  }
  if (app.build !== undefined) {
    return { url: app.build.manifest, sha256: app.build.manifestDigest, inRelease: false };
  }
  if (app.artifacts !== undefined) {
    // The release's `manifest.json` carries the catalog manifest as `catalog`.
    return { url: app.artifacts.manifest, sha256: app.artifacts.digest, inRelease: true };
  }
  return null;
}

/**
 * The repository and homepage of a catalog manifest. The homepage defaults
 * to the repository, as the manifest's own rules do.
 */
export function linksOf(manifest: unknown): AppLinks {
  const fields = (typeof manifest === "object" && manifest !== null ? manifest : {}) as {
    repo?: unknown;
    homepage?: unknown;
  };
  const repo = fields.repo;
  const homepage =
    fields.homepage ?? (typeof repo === "string" ? `https://github.com/${repo}` : undefined);
  const result = appLinksSchema.safeParse({ repo, homepage });
  if (!result.success) throw new Error(snapshotProblems(result.error).join("; "));
  return result.data;
}

function dataUri(bytes: Uint8Array, url: string): string {
  const type = new URL(url).pathname.endsWith(".svg") ? "image/svg+xml" : "image/png";
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}

export async function fetchCatalogSnapshot(
  options: FetchSnapshotOptions = {},
): Promise<FetchedCatalog> {
  const {
    baseUrl = CATALOG_BASE_URL,
    fetch: fetchImpl = fetch,
    concurrency = 8,
    attempts = 3,
    retryDelayMs = 500,
    now = () => new Date(),
    only,
    ogMedia = true,
  } = options;

  async function bytesOf(url: string, digest?: string): Promise<Uint8Array> {
    let problem = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(retryDelayMs * 2 ** (attempt - 2));
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
          problem = `HTTP ${response.status}`;
          continue;
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        // A digest mismatch is not retried: the file is not the one the index names.
        if (digest !== undefined && sha256(bytes) !== digest) {
          throw new DigestMismatch(`${url} does not match the digest the catalog index gives`);
        }
        return bytes;
      } catch (error) {
        if (error instanceof DigestMismatch) throw error;
        problem = error instanceof Error ? error.message : String(error);
      }
    }
    throw new Error(`Could not fetch ${url} after ${attempts} tries: ${problem}`);
  }

  const jsonOf = async (url: string, digest?: string): Promise<unknown> =>
    JSON.parse(new TextDecoder().decode(await bytesOf(url, digest)));

  const indexUrl = new URL("index.json", baseUrl).href;
  const published = await jsonOf(indexUrl);
  const rawIndex = only === undefined ? published : narrowIndex(published, only);
  const parsedIndex = indexJsonSchema.safeParse(rawIndex);
  if (!parsedIndex.success) {
    throw new Error(
      `${indexUrl} is not a valid catalog index:\n  ${snapshotProblems(parsedIndex.error).join("\n  ")}`,
    );
  }
  // The manager features rows name are the site's concern no more than a
  // manager's that has them: dropped.
  const index: IndexJson = readIndexJson(parsedIndex.data);

  const publishedStats = index.stats === undefined ? null : await jsonOf(index.stats);
  const stats =
    only === undefined || publishedStats === null
      ? publishedStats
      : narrowStats(publishedStats, only);

  const links = await mapLimit(index.apps, concurrency, async (app) => {
    const source = manifestSource(app);
    if (source === null) throw new Error(`"${app.slug}" has no catalog manifest to read`);
    const document = await jsonOf(source.url, source.sha256);
    const manifest = source.inRelease ? (document as { catalog?: unknown }).catalog : document;
    try {
      return [app.slug, linksOf(manifest)] as const;
    } catch (error) {
      throw new Error(`The catalog manifest of "${app.slug}" at ${source.url}: ${String(error)}`);
    }
  });

  // Only media on the catalog's own site, as the pages show them.
  const origin = new URL(baseUrl).origin;
  const onSite = (url: string | undefined) => ogMedia && catalogMediaUrl(url, origin) !== null;
  const icons = await mapLimit(
    index.apps.filter((app) => onSite(app.media?.icon?.url)),
    concurrency,
    async (app) => {
      const icon = app.media?.icon;
      if (icon === undefined) return null;
      const bytes = await bytesOf(icon.url, icon.sha256);
      if (bytes.byteLength > MAX_ICON_BYTES) return null;
      return [app.slug, dataUri(bytes, icon.url)] as const;
    },
  );
  const screenshots = await mapLimit(
    index.apps.filter((app) => onSite(app.media?.screenshots[0]?.url)),
    concurrency,
    async (app) => {
      const screenshot = app.media?.screenshots[0];
      if (screenshot === undefined) return null;
      const bytes = await bytesOf(screenshot.url, screenshot.sha256);
      if (bytes.byteLength > MAX_SCREENSHOT_BYTES) return null;
      // The cards read a picture's size from its PNG header; anything else is left out.
      const picture = pngPicture(bytes);
      return picture === null ? null : ([app.slug, picture] as const);
    },
  );

  const snapshot = parseCatalogSnapshot(
    {
      takenAt: now().toISOString(),
      index: rawIndex,
      stats,
      links: Object.fromEntries(links),
    },
    baseUrl,
  );
  return {
    snapshot,
    ogIcons: Object.fromEntries(icons.filter((entry) => entry !== null)),
    ogScreenshots: Object.fromEntries(screenshots.filter((entry) => entry !== null)),
  };
}

class DigestMismatch extends Error {}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** The index with only the named apps, and only the sponsored items that promote none or one of them. */
export function narrowIndex(index: unknown, slugs: readonly string[]): unknown {
  const keep = new Set(slugs);
  const object = asObject(index);
  const apps = Array.isArray(object.apps) ? object.apps : [];
  const featured = Array.isArray(object.featured) ? object.featured : [];
  return {
    ...object,
    apps: apps.filter((app) => keep.has(String(asObject(app).slug))),
    featured: featured.filter((item) => {
      const slug = asObject(item).slug;
      return slug === undefined || keep.has(String(slug));
    }),
  };
}

/** The stats with only the named apps. */
export function narrowStats(stats: unknown, slugs: readonly string[]): unknown {
  const object = asObject(stats);
  const apps = asObject(object.apps);
  return {
    ...object,
    apps: Object.fromEntries(
      slugs.filter((slug) => slug in apps).map((slug) => [slug, apps[slug]]),
    ),
  };
}
