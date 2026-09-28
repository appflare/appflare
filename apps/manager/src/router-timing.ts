/**
 * How long pages wait before showing the loading indicator, and how long a
 * page's data serves navigations back to it.
 *
 * Within a page's stale time, coming back to it shows the data already read
 * at once; after it, the last read still shows at once while the page is
 * read again in the background. An action that changes what a page shows
 * invalidates the router, which reads it again regardless.
 */

/**
 * A page that takes longer than this to load shows the loading indicator;
 * one that loads sooner never flashes it.
 */
export const PENDING_MS = 300;

/** Once shown, the loading indicator stays at least this long, so it never blinks. */
export const PENDING_MIN_MS = 200;

/** The catalog and an app's catalog page change only when the catalog is refreshed. */
export const CATALOG_STALE_MS = 30_000;

/** An install's page: short, since jobs change it. */
export const INSTALL_PAGE_STALE_MS = 10_000;
