// First: on the deploy pages, before any schema of the site is built (see the module).
import "./zod-config.ts";
import { isCallbackPath } from "./paths.ts";

/**
 * What the browser arrived with, read once when the site's code first runs,
 * before the router or anything else looks at the address.
 *
 * The OAuth callback arrives as `/deploy/callback?code=…&state=…`. The code
 * and state are kept in this module's memory and taken out of the address
 * bar here, so they never reach the router, the history entry, a bookmark,
 * a referrer or the analytics. Imported by the root route, so it runs on
 * every page before the app starts.
 */

/** The query parameters Cloudflare's authorization server sends back. */
export interface CallbackParams {
  code: string | null;
  state: string | null;
  /** The OAuth error code when consent was refused or failed. */
  error: string | null;
}

/** The value of `name` when it appears exactly once, else null. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 && values[0] !== undefined && values[0] !== "" ? values[0] : null;
}

/** The callback's parameters from a query string. */
export function readCallbackParams(search: string): CallbackParams {
  const params = new URLSearchParams(search);
  return {
    code: single(params, "code"),
    state: single(params, "state"),
    error: single(params, "error"),
  };
}

/** The path the page was opened at, before any in-app navigation; null while prerendering. */
export const openedAt: string | null =
  typeof window === "undefined" ? null : window.location.pathname;

let arrived: CallbackParams | null = null;

if (typeof window !== "undefined" && isCallbackPath(window.location.pathname)) {
  const { pathname, search, hash } = window.location;
  arrived = readCallbackParams(search);
  if (search !== "" || hash !== "") window.history.replaceState(null, "", pathname);
}

/** The parameters the callback page arrived with; null on any other page. */
export function arrivedCallbackParams(): CallbackParams | null {
  return arrived;
}

/** Forgets them once they have been used. */
export function forgetCallbackParams(): void {
  arrived = null;
}
