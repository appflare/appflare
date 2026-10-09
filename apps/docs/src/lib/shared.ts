/**
 * Site-wide constants and URL rules, shared by the routes, the build plugins in
 * vite.config.ts, and the tests. Nothing here imports the content, so the Vite
 * config can load it before the MDX pipeline exists.
 */

/**
 * The deployed site's address. Absolute URLs (OpenGraph, sitemap, llms.txt,
 * and the documentation links in the deploy repository's README) start here.
 * It is set once, in `@appflare/schema/links`, because the manager and the
 * installer link to the same site. A preview deploy on another address still
 * writes these URLs with the public address; its own pages link relatively.
 */
export { SITE_URL } from "@appflare/schema/links";

export const siteName = "Appflare";

/** The approved launch artwork, exported as a 1200x630 PNG for sharing the site. */
export const siteOgImagePath = "/og/appflare-launch.png";

export const siteDescription =
  "A self-hosted app manager for Cloudflare. Install, update, and remove Cloudflare-native apps in your own account.";

export const repository = {
  owner: "appflare",
  name: "appflare",
  branch: "main",
  /** Where the content files live inside the repository. */
  contentDir: "apps/docs/content/docs",
} as const;

export const repositoryUrl = `https://github.com/${repository.owner}/${repository.name}`;

/** Where the build writes the search index, which the search dialog downloads. */
export const searchIndexPath = "/api/search.json";

/** The GitHub page of one content file, given its path inside `content/docs`. */
export function sourceFileUrl(path: string): string {
  return `${repositoryUrl}/blob/${repository.branch}/${repository.contentDir}/${path}`;
}

/**
 * A page's URL. Pages are served as `<path>/index.html`, so their canonical URL
 * ends in a slash, as it did before the site moved to this stack; Workers static
 * assets redirects the form without one.
 */
export function pageUrl(slugs: readonly string[]): string {
  return slugs.length === 0 ? "/" : `/${slugs.join("/")}/`;
}

/** The URL of a page's Markdown source for agents: `/start/install.md`, `/index.md`. */
export function markdownUrl(slugs: readonly string[]): string {
  return `/${slugs.length === 0 ? "index" : slugs.join("/")}.md`;
}

/** The slugs of a page from its Markdown URL's path segments; the inverse of {@link markdownUrl}. */
export function slugsFromMarkdownPath(splat: string): string[] {
  const segments = splat.split("/").filter((segment) => segment.length > 0);
  const last = segments.pop();
  if (last === undefined) return [];
  const name = last.replace(/\.md$/, "");
  if (segments.length === 0 && name === "index") return [];
  return [...segments, name];
}

/** Where a page's OpenGraph image is written at build time. */
export function ogImagePath(slugs: readonly string[]): string {
  return `/og/${[...slugs, "image.png"].join("/")}`;
}

/** The slugs of a page from its OpenGraph image path's segments; the inverse of {@link ogImagePath}. */
export function slugsFromOgImagePath(splat: string): string[] | undefined {
  const segments = splat.split("/").filter((segment) => segment.length > 0);
  if (segments.pop() !== "image.png") return undefined;
  return segments;
}

/** The page slugs of a splat route parameter (`start/install/` becomes `["start", "install"]`). */
export function slugsFromSplat(splat: string | undefined): string[] {
  return (splat ?? "").split("/").filter((segment) => segment.length > 0);
}
