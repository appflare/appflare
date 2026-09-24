import type { IndexJson } from "@appflare/schema";

/**
 * Authors' GitHub avatars on an app's page. Like every other catalog image
 * they reach the browser only through the manager
 * (`/api/catalog/avatar/<handle>`), so a user's browser never contacts
 * GitHub: the manager fetches one fixed URL shape, and only for a handle the
 * cached index lists as an app author. Client-safe.
 */

export const CATALOG_AVATAR_PATH = "/api/catalog/avatar/";

/** Pixels on each side the manager asks GitHub for: twice the largest size the page shows. */
export const AVATAR_SIZE = 64;

/** The largest avatar the manager relays; GitHub's 64px avatars are a few kilobytes. */
export const MAX_AVATAR_BYTES = 256 * 1024;

/** A GitHub login: letters, digits and single dashes, at most 39 characters. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export function isGithubLogin(handle: string): boolean {
  return GITHUB_LOGIN.test(handle);
}

/** The manager path of an author's avatar, or null when the handle is not a GitHub login. */
export function avatarSrc(github: string | undefined): string | null {
  if (github === undefined || !isGithubLogin(github)) return null;
  return `${CATALOG_AVATAR_PATH}${github}`;
}

/**
 * The first URL the manager fetches for `handle`. GitHub answers with a
 * redirect to the account's avatar by numeric id; the shorter
 * `avatars.githubusercontent.com/<login>` form serves a default image for
 * organisations, so it is not used.
 */
export function avatarUpstreamUrl(handle: string): string {
  return `https://github.com/${handle}.png?size=${AVATAR_SIZE}`;
}

/**
 * The redirect target GitHub gives for an avatar, when it is one: an https
 * URL on `avatars.githubusercontent.com` with a `/u/<id>` path. Null for
 * anything else, which the manager then refuses to fetch.
 */
export function avatarRedirectTarget(location: string | null): string | null {
  if (location === null) return null;
  try {
    const url = new URL(location);
    const ok =
      url.protocol === "https:" &&
      url.host === "avatars.githubusercontent.com" &&
      /^\/u\/\d+$/.test(url.pathname);
    return ok ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Whether the index lists `handle` as the GitHub account of an app author.
 * GitHub logins are case-insensitive.
 */
export function indexListsAuthor(index: IndexJson, handle: string): boolean {
  const wanted = handle.toLowerCase();
  return index.apps.some((app) =>
    (app.authors ?? []).some((author) => author.github?.toLowerCase() === wanted),
  );
}

/** Image types GitHub serves avatars as; anything else is refused. */
export const AVATAR_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
