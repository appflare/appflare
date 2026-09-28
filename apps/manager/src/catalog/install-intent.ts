import { githubRepositorySchema } from "@appflare/schema";
import { appKey, customCatalogIdSchema, OFFICIAL_CATALOG_ID } from "./sources";

/**
 * Install links: `/install/<slug>` opens an app's catalog page, and
 * `/install/github/<owner>/<repo>` opens the "Install from a repository"
 * dialog with the repository filled in. They arrive from other sites (an
 * Install button, a README badge), so both parts are untrusted: each is
 * checked against the rules a real slug or repository follows, and anything
 * else is refused before a catalog is read. Neither link installs or builds
 * anything; an admin still confirms on the page it opens. Client-safe.
 */

/** A catalog slug: lowercase letters, digits and dashes, starting with a letter or digit. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The app key an install link names, or null when it cannot be one: a plain
 * slug (any enabled catalog), or `<catalog>:<slug>` for one catalog.
 */
export function installLinkKey(raw: string): { key: string; plain: boolean } | null {
  const colon = raw.indexOf(":");
  if (colon === -1) return SLUG.test(raw) ? { key: raw, plain: true } : null;
  const catalogId = raw.slice(0, colon);
  const slug = raw.slice(colon + 1);
  if (!SLUG.test(slug)) return null;
  if (catalogId !== OFFICIAL_CATALOG_ID && !customCatalogIdSchema.safeParse(catalogId).success) {
    return null;
  }
  return { key: appKey(catalogId, slug), plain: false };
}

/**
 * `owner/repo` from an install link's two path parts, or null when they are
 * not a GitHub repository (the same rules the repository dialog applies). A
 * trailing `.git` is dropped.
 */
export function installLinkRepository(owner: string, repo: string): string | null {
  const name = repo.replace(/\.git$/i, "");
  const full = `${owner}/${name}`;
  return githubRepositorySchema.safeParse(full).success ? full : null;
}

/**
 * The catalog page's `?repository=owner/repo` (set by the repository install
 * link) when it is a GitHub repository, else null. The page checks it again
 * because anyone can type the address.
 */
export function prefilledRepository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const [owner, repo, ...rest] = value.split("/");
  if (owner === undefined || repo === undefined || rest.length > 0) return null;
  return installLinkRepository(owner, repo);
}

/** What `/install/<slug>` found. */
export type InstallLinkTarget =
  /** The app's page to open (its app key). */
  | { found: true; key: string }
  /** Not listed by any enabled catalog; `officialOff` when the official catalog is turned off. */
  | { found: false; officialOff: boolean };
