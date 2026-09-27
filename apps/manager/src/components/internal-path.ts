/**
 * Which hrefs count as a page of this manager. A browser reads `//host` and
 * `/\host` (and a few more spellings) as another site, so "starts with one
 * slash" is not enough: a path is accepted only when its first segment is one
 * of the manager's own pages and every character after it is in a short
 * allow-list (no backslash, no percent escape, no second slash in a row).
 * Links in message strings (`message-links.ts`), which can carry text from a
 * build or an installer, and the router bridge (`router-anchor.tsx`) both
 * decide with this pattern. Client-safe and server-safe.
 */

/** One path segment after the first: letters, digits, `._~-`, and `:` (catalog app keys). */
const SEGMENT = "[A-Za-z0-9._~:-]+";

/** An element id after `#`. */
const HASH = "(?:#[A-Za-z0-9_-]+)?";

/** A query string: plain words, `=` and `&` only. */
const QUERY = "(?:\\?[A-Za-z0-9._~=&-]*)?";

/** The signed-in pages a message may link to. */
const MESSAGE_ROOTS = ["settings", "apps", "jobs", "catalog"] as const;

/** Every page the router may open in place, including home and the sign-in pages. */
const PAGE_ROOTS = [...MESSAGE_ROOTS, "login", "setup", "forgot-password", "reset-password"];

function pathPattern(roots: readonly string[], query: boolean, allowHome: boolean): RegExp {
  const rooted = `(?:${roots.join("|")})(?:/${SEGMENT})*`;
  const path = allowHome ? `(?:${rooted})?` : rooted;
  return new RegExp(`^/${path}${query ? QUERY : ""}${HASH}$`);
}

/** A link inside a message: a signed-in page, an optional section, no query. */
export const MESSAGE_LINK_PATH = pathPattern(MESSAGE_ROOTS, false, false);

/** A page of the manager the router opens in place. */
export const INTERNAL_PAGE_PATH = pathPattern(PAGE_ROOTS, true, true);

/** Whether `href` may be a link inside a message string. */
export function isMessageLinkPath(href: string): boolean {
  return MESSAGE_LINK_PATH.test(href);
}

/** Whether `href` is a page of this manager the router may open in place. */
export function isInternalPagePath(href: string): boolean {
  return INTERNAL_PAGE_PATH.test(href);
}
