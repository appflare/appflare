import { APPFLARE_OAUTH_CALLBACK_URL } from "@appflare/cf-api/oauth";

/**
 * Which OAuth client new Cloudflare connections use, and where Cloudflare
 * sends the browser back. Appflare's public client is the default; the
 * optional var `CF_OAUTH_CLIENT_ID` points a development manager at another
 * client. A stored grant always keeps the client id it was issued to,
 * whatever these say: a refresh token works only with its own client.
 *
 * The callback, first match:
 * 1. `CF_OAUTH_CALLBACK_URL`, when set;
 * 2. `<APPFLARE_INSTALLER_ORIGIN>/deploy/callback`, for a manager installed
 *    from the browser: the deploy page it came from (production, or the
 *    docs preview) has the callback page, and the client lists both. The
 *    var must be an origin only (`https:`, or `http:` on localhost for
 *    development), with no path, query, fragment or credentials;
 *    anything else is ignored;
 * 3. Appflare's production callback.
 * Cloudflare accepts only callbacks registered for the client, so none of
 * these can send a sign-in anywhere else. The value a sign-in starts with is
 * stored with it, and its code exchange uses that same value.
 */

/** Appflare's public OAuth client (a public identifier, not a secret). */
export const APPFLARE_OAUTH_CLIENT_ID = "b99863433175d812f9595af56dd1b71d";

/** The deploy page's callback, on the installer's origin. */
const CALLBACK_PATH = "/deploy/callback";

export interface OAuthClientConfig {
  clientId: string;
  callbackUrl: string;
}

export interface OAuthClientEnv {
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_CALLBACK_URL?: string;
  APPFLARE_INSTALLER_ORIGIN?: string;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * `value` as an origin (`https://host[:port]`), or null unless it is
 * exactly one: https (or http on localhost), and nothing after the host.
 */
export function strictOrigin(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure =
    url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
  if (!secure || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  // `https://host` and `https://host/` are the same origin; a path is not.
  if (url.pathname !== "/" || raw.replace(/\/$/, "") !== url.origin) return null;
  return url.origin;
}

export function oauthClientConfig(env: OAuthClientEnv): OAuthClientConfig {
  const clientId = env.CF_OAUTH_CLIENT_ID?.trim();
  const callbackUrl = env.CF_OAUTH_CALLBACK_URL?.trim();
  const installer = strictOrigin(env.APPFLARE_INSTALLER_ORIGIN);
  return {
    clientId: clientId ? clientId : APPFLARE_OAUTH_CLIENT_ID,
    callbackUrl: callbackUrl
      ? callbackUrl
      : installer !== null
        ? `${installer}${CALLBACK_PATH}`
        : APPFLARE_OAUTH_CALLBACK_URL,
  };
}
