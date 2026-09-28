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

export function appPath(slug: string): string {
  return `/apps/${slug}/`;
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
