/**
 * Which hrefs count as a page of this manager. A browser reads `//host` and
 * `/\host` (and a few more spellings) as another site, so "starts with one
 * slash" is not enough: a path is accepted only when its first segment is one
 * of the manager's own pages and every character after it is in a short
 * allow-list (no backslash, no percent escape in the path, no second slash
 * in a row). Links in message strings (`message-links.ts`), which can carry
 * text from a build or an installer, the router bridge (`router-anchor.tsx`),
 * and the page signing in returns to (`return-to.ts`) all decide with these
 * patterns. Client-safe and server-safe.
 */

/**
 * One path segment after the first: letters, digits, `._~-`, and `:` (catalog
 * app keys). Never only dots: a browser resolves `.` and `..`, so
 * `/catalog/../login` would leave the page the pattern allowed.
 */
const SEGMENT = "(?!\\.+(?:[/?#]|$))[A-Za-z0-9._~:-]+";

/** An element id after `#`. */
const HASH = "(?:#[A-Za-z0-9_-]+)?";

/**
 * A query string: plain words, `=`, `&` and `+`, and percent escapes (the
 * router writes a value such as `owner/repo` as `owner%2Frepo`). A raw `/`,
 * `\` or `:` never appears; nothing after `?` can change which site or page
 * the path names.
 */
const QUERY = "(?:\\?(?:[A-Za-z0-9._~=&+-]|%[0-9A-Fa-f]{2})*)?";

/** The signed-in pages a message may link to. */
const MESSAGE_ROOTS = ["settings", "apps", "jobs", "catalog"] as const;

/**
 * Where signing in may return to: the signed-in pages, and the install links
 * (`/install/<slug>`, `/install?repo=`) that open an app or a repository.
 */
const RETURN_ROOTS = [...MESSAGE_ROOTS, "install"];

/** Every page the router may open in place, including home and the sign-in pages. */
const PAGE_ROOTS = [...RETURN_ROOTS, "login", "setup", "forgot-password", "reset-password"];

function pathPattern(roots: readonly string[], query: boolean, allowHome: boolean): RegExp {
  const rooted = `(?:${roots.join("|")})(?:/${SEGMENT})*`;
  const path = allowHome ? `(?:${rooted})?` : rooted;
  return new RegExp(`^/${path}${query ? QUERY : ""}${HASH}$`);
}

/** A link inside a message: a signed-in page, an optional section, no query. */
export const MESSAGE_LINK_PATH = pathPattern(MESSAGE_ROOTS, false, false);

/** A page of the manager the router opens in place. */
export const INTERNAL_PAGE_PATH = pathPattern(PAGE_ROOTS, true, true);

/**
 * A page to return to after signing in: home or a signed-in page, with a
 * query and a section, never a sign-in page (which would send the visitor
 * round in a circle).
 */
export const RETURN_PATH = pathPattern(RETURN_ROOTS, true, true);

/**
 * The one sign-in page a return path may name: setup's last step
 * (`/setup?checklist=true`, then more of the same query), where the setup
 * wizard resumes after it moved Appflare to a new address and the owner
 * signed in again there. It is a signed-in step, so it sends nobody round
 * in a circle.
 */
export const SETUP_RESUME_PATH = new RegExp(
  `^/setup\\?checklist=true(?:&(?:[A-Za-z0-9._~=&+-]|%[0-9A-Fa-f]{2})*)?${HASH}$`,
);

/** The longest return path kept; a longer one is dropped. */
export const MAX_RETURN_PATH_LENGTH = 1024;

/** Whether `href` may be a link inside a message string. */
export function isMessageLinkPath(href: string): boolean {
  return MESSAGE_LINK_PATH.test(href);
}

/** Whether `href` is a page of this manager the router may open in place. */
export function isInternalPagePath(href: string): boolean {
  return INTERNAL_PAGE_PATH.test(href);
}

/**
 * `value` when it is a page of this manager to return to after signing in
 * (`RETURN_PATH`, or setup's last step, `SETUP_RESUME_PATH`), else null.
 * The value comes from the address bar, so anything else (another site,
 * `//host`, `/\host`, a scheme, another sign-in page) is dropped, and the
 * caller goes home instead.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_RETURN_PATH_LENGTH) return null;
  return RETURN_PATH.test(value) || SETUP_RESUME_PATH.test(value) ? value : null;
}
