import type { IndexJson, IndexMedia, IndexMediaFile } from "@appflare/schema";

/**
 * Catalog images (app icons, covers, screenshots, and the sponsored item's
 * image) reach the browser only through the manager's own
 * `/api/catalog/media/<sha256>` route, never straight from the catalog site:
 *
 * - the manager serves an image only when the cached index lists it and its
 *   URL is on the index's own origin, so no index entry (and no sponsor) can
 *   make a user's browser load anything from elsewhere or count views;
 * - it checks the bytes against the sha256 the index pins before serving
 *   them, the same way it treats every other file the catalog publishes;
 * - the user's browser never contacts the catalog site at all, so it learns
 *   neither the user's address nor the manager's hostname.
 */

/** Where the manager serves a catalog image, followed by its sha256. */
export const CATALOG_MEDIA_PATH = "/api/catalog/media/";

/** The largest image the manager relays. Covers are 1200x630 PNGs, well below this. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** The content type for an image URL's extension, or null when it is not an image the catalog publishes. */
export function mediaContentType(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const ext = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? null;
}

/** Whether `url` may be served: http(s), on the same origin as the index, and an image type. */
export function mediaAllowed(url: string, indexUrl: string): boolean {
  try {
    const media = new URL(url);
    const index = new URL(indexUrl);
    return (
      (media.protocol === "https:" || media.protocol === "http:") &&
      media.origin === index.origin &&
      mediaContentType(url) !== null
    );
  } catch {
    return false;
  }
}

/** The manager path of an image, or null when it may not be served (see {@link mediaAllowed}). */
export function mediaSrc(file: IndexMediaFile | undefined, indexUrl: string): string | null {
  if (file === undefined || !mediaAllowed(file.url, indexUrl)) return null;
  return `${CATALOG_MEDIA_PATH}${file.sha256}`;
}

/** An entry's images as the UI uses them: manager paths, with anything not servable left out. */
export interface AppMediaView {
  icon: string | null;
  cover: string | null;
  screenshots: Array<{ src: string; alt: string }>;
}

export function appMediaView(media: IndexMedia | undefined, indexUrl: string): AppMediaView {
  return {
    icon: mediaSrc(media?.icon, indexUrl),
    cover: mediaSrc(media?.cover, indexUrl),
    screenshots: (media?.screenshots ?? []).flatMap((shot) => {
      const src = mediaSrc(shot, indexUrl);
      return src === null ? [] : [{ src, alt: shot.alt }];
    }),
  };
}

/** Every image the index lists, apps first, then featured items. */
function* indexMedia(index: IndexJson): Generator<IndexMediaFile> {
  for (const app of index.apps) {
    if (app.media?.icon) yield app.media.icon;
    if (app.media?.cover) yield app.media.cover;
    yield* app.media?.screenshots ?? [];
  }
  for (const item of index.featured) {
    if (item.image) yield item.image;
  }
}

/** The servable image the index pins to `sha256`, or null. */
export function findCatalogMedia(
  index: IndexJson,
  sha256: string,
  indexUrl: string,
): IndexMediaFile | null {
  for (const file of indexMedia(index)) {
    if (file.sha256 === sha256 && mediaAllowed(file.url, indexUrl)) return file;
  }
  return null;
}
