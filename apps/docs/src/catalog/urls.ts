/**
 * Addresses of the catalog's pages on this site. App pages live under
 * `/apps/` because `/catalog/` holds the pages about packaging apps for the
 * catalog, which released managers already link to.
 */

export const appsPath = "/apps/";

/**
 * The catalog's own site. Pages show an image only when it is hosted there,
 * as the manager does, so an index can never make the site load images from
 * anywhere else.
 */
export const CATALOG_ORIGIN = "https://appflare.github.io";

/** `url` when it is on `origin` (the catalog's by default), else null. */
export function catalogMediaUrl(
  url: string | undefined,
  origin: string = CATALOG_ORIGIN,
): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).origin === origin ? url : null;
  } catch {
    return null;
  }
}

/** The catalog's repository, where apps are added. */
export const catalogRepositoryUrl = "https://github.com/appflare/catalog";

/**
 * Where a visitor asks for an app the catalog does not have: a new issue on
 * the catalog's repository, titled with the app's name when it is known.
 */
export function suggestAppUrl(name = ""): string {
  const url = new URL(`${catalogRepositoryUrl}/issues/new`);
  url.searchParams.set("title", `App request: ${name.trim()}`);
  url.searchParams.set("body", "The app's repository:\n\nWhat it does:\n");
  return url.href;
}

export function appPath(slug: string): string {
  return `/apps/${slug}/`;
}

/** The longest search a missing app's address is turned into. */
const MAX_MISSING_WORDS = 60;

/**
 * For the address of an app's page that does not exist (`/apps/trading-edge/`,
 * from a link elsewhere), the words to search the catalog for
 * (`trading edge`); null for any other address.
 */
export function missingAppWords(pathname: string): string | null {
  const segment = /^\/apps\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (segment === undefined) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(segment);
  } catch {
    return null;
  }
  const words = slug
    .split(/[-_\s]+/)
    .filter((word) => word !== "")
    .join(" ")
    .slice(0, MAX_MISSING_WORDS)
    .trim();
  return words === "" ? null : words;
}

/** The apps page with `words` in its search field. */
export function appsSearchPath(words: string): string {
  return `${appsPath}?q=${encodeURIComponent(words)}`;
}

export function categoryPath(id: string): string {
  return `/categories/${id}/`;
}

/** Where "Install" sends a visitor, to open the app in their own Appflare. */
export function installPath(slug: string): string {
  return `/install/${slug}/`;
}

/** The install page for a GitHub repository, which takes it as `?repo=<owner>/<repo>`. */
export const installRepoPath = "/install/";

/** Where an Appflare tells this site its address; Appflare links here. */
export const myPath = "/my/";

/**
 * The pages that pass a visitor on to their own Appflare: one install page
 * per app, the repository install page, and `/my/`. They are built and
 * linked like any page, but search engines and the site's indexes leave
 * them out.
 */
export function handoffPagePaths(catalog: { apps: ReadonlyArray<{ slug: string }> }): string[] {
  return [installRepoPath, ...catalog.apps.map((app) => installPath(app.slug)), myPath];
}

/** Every catalog page of the site: the apps page, one page per app, one per category. */
export function catalogPagePaths(catalog: {
  apps: ReadonlyArray<{ slug: string }>;
  categories: ReadonlyArray<{ id: string }>;
}): string[] {
  return [
    appsPath,
    ...catalog.apps.map((app) => appPath(app.slug)),
    ...catalog.categories.map((category) => categoryPath(category.id)),
  ];
}
