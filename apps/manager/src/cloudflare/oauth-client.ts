import { APPFLARE_OAUTH_CALLBACK_URL } from "@appflare/cf-api/oauth";

/**
 * Which OAuth client new Cloudflare connections use. Appflare's public
 * client is the default; the optional vars `CF_OAUTH_CLIENT_ID` and
 * `CF_OAUTH_CALLBACK_URL` point a development manager at another client and
 * its registered callback. A stored grant always keeps the client id it was
 * issued to, whatever these say: a refresh token works only with its own
 * client.
 */

/** Appflare's public OAuth client (a public identifier, not a secret). */
export const APPFLARE_OAUTH_CLIENT_ID = "b99863433175d812f9595af56dd1b71d";

export interface OAuthClientConfig {
  clientId: string;
  callbackUrl: string;
}

export function oauthClientConfig(env: {
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_CALLBACK_URL?: string;
}): OAuthClientConfig {
  const clientId = env.CF_OAUTH_CLIENT_ID?.trim();
  const callbackUrl = env.CF_OAUTH_CALLBACK_URL?.trim();
  return {
    clientId: clientId ? clientId : APPFLARE_OAUTH_CLIENT_ID,
    callbackUrl: callbackUrl ? callbackUrl : APPFLARE_OAUTH_CALLBACK_URL,
  };
}
