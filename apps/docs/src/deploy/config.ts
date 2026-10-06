import { APPFLARE_OAUTH_CALLBACK_URL } from "@appflare/cf-api/oauth";

/**
 * Where the deploy page lives and which Cloudflare OAuth client it signs in
 * with. The client is public (no secret), so its id is ordinary configuration.
 */

import { CALLBACK_PATH } from "./paths.ts";

export { CALLBACK_PATH, DEPLOY_PATH, isCallbackPath, isDeployPath } from "./paths.ts";

/** Appflare's public Cloudflare OAuth client. */
export const PUBLIC_OAUTH_CLIENT_ID = "b99863433175d812f9595af56dd1b71d";

/** The site's preview deploy, on the development account's workers.dev address. */
export const PREVIEW_ORIGIN = "https://appflare-docs.appflare-dev.workers.dev";

/**
 * The origins whose `/deploy/callback` the public client accepts as a
 * redirect URI (and whose requests its token endpoint answers across
 * origins). Cloudflare refuses any other, so a copy of the page served
 * elsewhere, a local server included, cannot finish signing in with it.
 */
export const REGISTERED_ORIGINS: readonly string[] = [
  new URL(APPFLARE_OAUTH_CALLBACK_URL).origin,
  PREVIEW_ORIGIN,
];

/** Build-time overrides, for development against another OAuth client. */
export interface OAuthOverrides {
  /** `VITE_APPFLARE_OAUTH_CLIENT_ID` */
  clientId?: string | undefined;
  /** `VITE_APPFLARE_OAUTH_CALLBACK_URL` */
  callbackUrl?: string | undefined;
}

export type OAuthSetup =
  | { ok: true; clientId: string; redirectUri: string }
  /**
   * `unregistered-origin`: the page runs at an address Cloudflare would not
   * send the browser back to. `callback-elsewhere`: the configured callback is
   * on another origin, where this tab's sign-in data does not exist.
   */
  | { ok: false; reason: "unregistered-origin" | "callback-elsewhere" };

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The client id and redirect URI for a page served at `origin`. The redirect
 * URI is always the callback on the page's own origin: the callback reads
 * what this tab kept in sessionStorage, which only the same origin can.
 */
export function oauthSetup(origin: string, overrides: OAuthOverrides = {}): OAuthSetup {
  const clientId = nonEmpty(overrides.clientId) ?? PUBLIC_OAUTH_CLIENT_ID;
  const callbackUrl = nonEmpty(overrides.callbackUrl);
  if (callbackUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(callbackUrl);
    } catch {
      return { ok: false, reason: "callback-elsewhere" };
    }
    if (url.origin !== origin || url.search !== "" || url.hash !== "") {
      return { ok: false, reason: "callback-elsewhere" };
    }
    return { ok: true, clientId, redirectUri: url.href };
  }
  if (!REGISTERED_ORIGINS.includes(origin)) return { ok: false, reason: "unregistered-origin" };
  return { ok: true, clientId, redirectUri: `${origin}${CALLBACK_PATH}` };
}

/** The setup for this build, read from Vite's build-time variables. */
export function buildOAuthSetup(origin: string): OAuthSetup {
  return oauthSetup(origin, {
    clientId: import.meta.env.VITE_APPFLARE_OAUTH_CLIENT_ID,
    callbackUrl: import.meta.env.VITE_APPFLARE_OAUTH_CALLBACK_URL,
  });
}
