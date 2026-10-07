/**
 * Cloudflare OAuth for a public client: authorization code with PKCE (S256),
 * no client secret (`token_endpoint_auth_method: none`). Used by the deploy
 * page (in the browser), the hosted installer and the manager (in Workers),
 * so it relies on `fetch` and WebCrypto only.
 *
 * Endpoints: Cloudflare's "Integrate your OAuth client with Cloudflare" page,
 * https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
 * (the same values as https://dash.cloudflare.com/.well-known/openid-configuration).
 * Token and revocation requests follow RFC 6749 (4.1.3 and 6), RFC 7009
 * and RFC 7636, the way wrangler's own login sends them
 * (cloudflare/workers-sdk, `packages/workers-auth/src/token-exchange.ts`):
 * a form-encoded POST carrying `client_id` and no `Authorization` header.
 * Both headers sent are CORS-safelisted, so a browser sends no preflight.
 *
 * Credentials (authorization codes, PKCE verifiers, access and refresh
 * tokens) never appear in an error message, a log line or a thrown error.
 * Errors carry the OAuth `error` code, the HTTP status and the server's
 * description with every value this module sent removed from it.
 */

import { z } from "zod";
import type { FetchLike } from "./http";

export {
  MANAGER_OAUTH_API_SCOPES,
  MANAGER_OAUTH_SCOPE_BY_GROUP,
  MANAGER_OAUTH_SCOPES,
  MANAGER_OAUTH_SCOPES_BY_PROBE,
  type ManagerOAuthGroupKey,
  missingManagerScopes,
  OFFLINE_ACCESS_SCOPE,
  signInCanProbe,
} from "./oauth-scopes";

/** Where the user grants access (the browser goes here). */
export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth";
/** Code exchange and refresh. */
export const CLOUDFLARE_OAUTH_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
/** Token revocation (RFC 7009). */
export const CLOUDFLARE_OAUTH_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";

/**
 * Appflare's registered callback: the deploy page's callback route. Every
 * authorization (a browser install and a manager's reconnect) returns here;
 * the `state` says which. Development builds may use another registered
 * callback, so take this as the default, not the only value.
 */
export const APPFLARE_OAUTH_CALLBACK_URL = "https://appflare.dev/deploy/callback";

// --- base64url ---------------------------------------------------------------

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64url(bytes);
}

// --- PKCE --------------------------------------------------------------------

/** A PKCE pair: keep `verifier` private, send `challenge` in the authorization URL. */
export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 (4.1): 43 to 128 characters from the unreserved set. */
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * The S256 challenge for a verifier: base64url (no padding) of the SHA-256
 * of its ASCII bytes. Throws a `TypeError` (without the value) when the
 * verifier is not a valid RFC 7636 verifier.
 */
export async function pkceChallenge(verifier: string): Promise<string> {
  if (!PKCE_VERIFIER.test(verifier)) {
    throw new TypeError("A PKCE verifier must be 43 to 128 unreserved characters.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64url(new Uint8Array(digest));
}

/** A fresh PKCE pair: a verifier of 32 random bytes (43 characters) and its S256 challenge. */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomBase64url(32);
  return { verifier, challenge: await pkceChallenge(verifier) };
}

// --- Authorization URL -------------------------------------------------------

export interface AuthorizationUrlArgs {
  clientId: string;
  /** Must be one of the client's registered redirect URIs, exactly. */
  redirectUri: string;
  /** Scope ids; Appflare passes `MANAGER_OAUTH_SCOPES`. */
  scopes: readonly string[];
  /** An encoded state (see {@link encodeOAuthState}). */
  state: string;
  /** From {@link createPkce}. */
  codeChallenge: string;
}

/**
 * The URL that sends the user to Cloudflare to grant access. The code comes
 * back to `redirectUri` in the query string (the default response mode for
 * `response_type=code`). Spaces between scopes are sent as `%20`, as
 * wrangler does.
 */
export function authorizationUrl(args: AuthorizationUrlArgs): string {
  if (args.clientId.length === 0) throw new TypeError("An OAuth client id is required.");
  if (args.scopes.length === 0 || args.scopes.some((s) => s.length === 0 || /\s/.test(s))) {
    throw new TypeError("OAuth scopes must be a non-empty list of ids without spaces.");
  }
  const params: Array<[string, string]> = [
    ["response_type", "code"],
    ["client_id", args.clientId],
    ["redirect_uri", args.redirectUri],
    ["scope", args.scopes.join(" ")],
    ["state", args.state],
    ["code_challenge", args.codeChallenge],
    ["code_challenge_method", "S256"],
  ];
  const query = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${CLOUDFLARE_OAUTH_AUTHORIZE_URL}?${query}`;
}

// --- Errors ------------------------------------------------------------------

/** Which request failed. */
export type OAuthOperation = "exchange" | "refresh" | "revoke";

const OPERATION_WORDS: Record<OAuthOperation, string> = {
  exchange: "Exchanging the Cloudflare authorization code",
  refresh: "Refreshing Cloudflare access",
  revoke: "Revoking Cloudflare access",
};

/**
 * `code` when no response arrived (DNS, connection, aborted read): the request
 * may or may not have reached Cloudflare.
 */
export const OAUTH_NETWORK_ERROR = "network_error";
/** `code` when a response arrived but was neither a token response nor an OAuth error. */
export const OAUTH_INVALID_RESPONSE = "invalid_response";

export interface CloudflareOAuthErrorInit {
  operation: OAuthOperation;
  /** The OAuth `error` code, or {@link OAUTH_NETWORK_ERROR} / {@link OAUTH_INVALID_RESPONSE}. */
  code: string;
  /** HTTP status; null when no response arrived. */
  status: number | null;
  /** Already free of secrets. */
  description?: string;
}

/**
 * A failed OAuth request. Branch on the flags, not on the message:
 *
 * - `reconnectNeeded`: the grant is gone (`invalid_grant`: revoked, expired,
 *   or a refresh token that was already used). Retrying cannot help; the user
 *   has to authorize again.
 * - `retryable`: anything that is not a definitive answer from the server:
 *   no complete response (`network_error`, also when the body broke off
 *   after the headers), HTTP 5xx, 429 or 408, `temporarily_unavailable` or
 *   `server_error`, or a body that is not a usable OAuth error (a gateway or
 *   challenge page). Retry later; never treat it as a revoked grant.
 * - Neither: Cloudflare refused the request itself (`invalid_client`,
 *   `invalid_request`, `invalid_scope`, ...), which points at the client id,
 *   the redirect URI or the scopes rather than the user's grant.
 */
export class CloudflareOAuthError extends Error {
  readonly operation: OAuthOperation;
  readonly code: string;
  readonly status: number | null;
  readonly reconnectNeeded: boolean;
  readonly retryable: boolean;

  constructor(init: CloudflareOAuthErrorInit) {
    const head = `${OPERATION_WORDS[init.operation]} failed`;
    const where = init.status === null ? "no response" : `HTTP ${init.status}`;
    const detail = init.description ? `: ${init.description}` : "";
    super(`${head} (${where}, ${init.code})${detail}`);
    this.name = "CloudflareOAuthError";
    this.operation = init.operation;
    this.code = init.code;
    this.status = init.status;
    this.reconnectNeeded = init.code === "invalid_grant" && !isTransientStatus(init.status);
    this.retryable = !this.reconnectNeeded && isRetryable(init.code, init.status);
  }
}

function isTransientStatus(status: number | null): boolean {
  return status === null || status >= 500 || status === 429 || status === 408;
}

const TRANSIENT_OAUTH_CODES = new Set(["temporarily_unavailable", "server_error"]);

function isRetryable(code: string, status: number | null): boolean {
  // No complete response (also a body that broke off after the headers).
  if (code === OAUTH_NETWORK_ERROR) return true;
  if (isTransientStatus(status)) return true;
  if (TRANSIENT_OAUTH_CODES.has(code)) return true;
  // A 4xx (or 2xx) that carried a structured OAuth error is the server's answer.
  return code === OAUTH_INVALID_RESPONSE;
}

const MAX_DESCRIPTION = 300;
const REDACTED = "[redacted]";

/**
 * Each secret as it may come back: as sent in the form body
 * (`application/x-www-form-urlencoded`, where a space is `+`), percent-encoded
 * as in a URL, and as is. Longest first, so no form is cut in half by a
 * shorter one.
 */
function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(new URLSearchParams({ s: secret }).toString().slice("s=".length));
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function containsSecret(text: string, forms: readonly string[]): boolean {
  return forms.some((form) => text.includes(form));
}

/** Removes every form of every secret this module sent from `text` and bounds its length. */
function scrub(text: string, forms: readonly string[]): string {
  let out = text;
  for (const form of forms) out = out.split(form).join(REDACTED);
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_DESCRIPTION ? `${out.slice(0, MAX_DESCRIPTION)}...` : out;
}

/** RFC 6749 (5.2): `error` is one or more NQSCHAR (printable ASCII but `"` and `\`). */
const OAUTH_ERROR_CODE = /^[\x20\x21\x23-\x5B\x5D-\x7E]{1,100}$/;

// --- Token endpoint ----------------------------------------------------------

export interface OAuthRequestOptions {
  /** Injectable fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Clock in epoch milliseconds (defaults to `Date.now`). */
  now?: () => number;
}

/** A token endpoint answer. */
export interface OAuthTokens {
  accessToken: string;
  /**
   * When the access token expires, in epoch milliseconds: `expires_in`
   * counted from when the request was sent, so it errs early.
   */
  expiresAt: number;
  /**
   * The granted scopes from the response's `scope`. Null when the response
   * leaves it out, which RFC 6749 (5.1) defines as "the scopes requested".
   */
  scopes: string[] | null;
  /** The refresh token; null when none was issued (no `offline_access` granted). */
  refreshToken: string | null;
}

/** A refresh answer always has a refresh token: the rotated one, or the one sent. */
export interface RefreshedTokens extends OAuthTokens {
  refreshToken: string;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

type TokenResponse = z.infer<typeof tokenResponseSchema>;

/**
 * Any body with an `error` string is an OAuth error. `error_description` may
 * be anything (some servers send null); only a string is kept, so a revoked
 * grant is never mistaken for a malformed, retryable response.
 */
const oauthErrorSchema = z.object({
  error: z.string(),
  error_description: z.unknown().optional(),
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface PostArgs {
  operation: OAuthOperation;
  url: string;
  params: Record<string, string>;
  /** Every credential in `params`, to keep out of errors. */
  secrets: string[];
  fetch?: FetchLike;
}

/**
 * Sends the form and returns the status and parsed JSON of a 2xx response;
 * throws {@link CloudflareOAuthError} for everything else.
 */
async function postForm(args: PostArgs): Promise<{ status: number; json: unknown }> {
  const fetchImpl: FetchLike = args.fetch ?? ((input, init) => fetch(input, init));
  const body = new URLSearchParams(args.params).toString();
  const forms = secretForms(args.secrets);
  let status: number | null = null;
  let text: string;
  try {
    const res = await fetchImpl(args.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    status = res.status;
    text = await res.text();
  } catch (error) {
    // Only the error's own message, scrubbed: a fetch failure says nothing
    // about the grant, and its cause is not kept in case it holds the request.
    // `status` stays set when the body broke off after the headers; the code
    // alone makes it retryable.
    const message = error instanceof Error ? error.message : String(error);
    throw new CloudflareOAuthError({
      operation: args.operation,
      code: OAUTH_NETWORK_ERROR,
      status,
      description: scrub(message, forms),
    });
  }

  const json = text.length === 0 ? undefined : parseJson(text);
  const oauthError = oauthErrorSchema.safeParse(json);
  if (oauthError.success) {
    const { error, error_description } = oauthError.data;
    // `error` becomes `code` and part of the message, so it is checked like a
    // description: a value outside the RFC's character set, or one carrying
    // anything that was sent, is not taken as an error code.
    if (!OAUTH_ERROR_CODE.test(error) || containsSecret(error, forms)) {
      throw new CloudflareOAuthError({
        operation: args.operation,
        code: OAUTH_INVALID_RESPONSE,
        status,
        description: "the response's OAuth error code was not usable",
      });
    }
    // Also a 2xx carrying an OAuth error, which RFC 6749 does not allow but
    // wrangler guards against too.
    throw new CloudflareOAuthError({
      operation: args.operation,
      code: error,
      status,
      description:
        typeof error_description === "string" ? scrub(error_description, forms) : undefined,
    });
  }
  if (status === null || status < 200 || status >= 300) {
    // A gateway, rate-limit or challenge page: the body is not shown.
    throw new CloudflareOAuthError({
      operation: args.operation,
      code: OAUTH_INVALID_RESPONSE,
      status,
      description: "the response was not an OAuth error",
    });
  }
  return { status, json };
}

function toTokens(
  operation: OAuthOperation,
  status: number,
  json: unknown,
  sentAt: number,
): TokenResponse & { expiresAt: number } {
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    // Field names only: Zod's messages could echo a received value.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "body"))];
    throw new CloudflareOAuthError({
      operation,
      code: OAUTH_INVALID_RESPONSE,
      status,
      description: `the token response has no valid ${fields.join(", ")}`,
    });
  }
  return { ...parsed.data, expiresAt: sentAt + parsed.data.expires_in * 1000 };
}

function scopeList(scope: string | undefined): string[] | null {
  if (scope === undefined) return null;
  return scope.split(/\s+/).filter((s) => s.length > 0);
}

export interface ExchangeCodeArgs extends OAuthRequestOptions {
  clientId: string;
  /** The `code` the callback received. */
  code: string;
  /** The verifier whose challenge was in the authorization URL. */
  codeVerifier: string;
  /** The same redirect URI the authorization URL used. */
  redirectUri: string;
}

/**
 * Exchanges an authorization code for tokens (`grant_type=authorization_code`).
 * A code works once; any failure here means authorizing again.
 */
export async function exchangeCode(args: ExchangeCodeArgs): Promise<OAuthTokens> {
  const now = args.now ?? Date.now;
  const sentAt = now();
  const { status, json } = await postForm({
    operation: "exchange",
    url: CLOUDFLARE_OAUTH_TOKEN_URL,
    params: {
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: args.clientId,
      code_verifier: args.codeVerifier,
    },
    secrets: [args.code, args.codeVerifier],
    fetch: args.fetch,
  });
  const tokens = toTokens("exchange", status, json, sentAt);
  return {
    accessToken: tokens.access_token,
    expiresAt: tokens.expiresAt,
    scopes: scopeList(tokens.scope),
    refreshToken: tokens.refresh_token ?? null,
  };
}

export interface RefreshGrantArgs extends OAuthRequestOptions {
  /** The client the grant was issued to. */
  clientId: string;
  refreshToken: string;
}

/**
 * Gets a new access token for a grant (`grant_type=refresh_token`).
 *
 * Cloudflare rotates the refresh token on every refresh: store the returned
 * `refreshToken` before using the access token, because the one sent may stop
 * working. When a response leaves `refresh_token` out, the one sent stays
 * valid (RFC 6749, part 6) and is returned, as wrangler does.
 */
export async function refreshGrant(args: RefreshGrantArgs): Promise<RefreshedTokens> {
  const now = args.now ?? Date.now;
  const sentAt = now();
  const { status, json } = await postForm({
    operation: "refresh",
    url: CLOUDFLARE_OAUTH_TOKEN_URL,
    params: {
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
    },
    secrets: [args.refreshToken],
    fetch: args.fetch,
  });
  const tokens = toTokens("refresh", status, json, sentAt);
  return {
    accessToken: tokens.access_token,
    expiresAt: tokens.expiresAt,
    scopes: scopeList(tokens.scope),
    refreshToken: tokens.refresh_token ?? args.refreshToken,
  };
}

export interface RevokeTokenArgs {
  clientId: string;
  /** A refresh token (ends the grant) or an access token. */
  token: string;
  /** Defaults to `refresh_token`. */
  tokenTypeHint?: "refresh_token" | "access_token";
  fetch?: FetchLike;
}

/**
 * Revokes a token (RFC 7009). Revoking a refresh token ends the whole grant;
 * a later refresh with it fails with `invalid_grant`. RFC 7009 has the server
 * answer 200 for a token that is already invalid, so this resolves for those
 * too; it throws {@link CloudflareOAuthError} otherwise.
 */
export async function revokeToken(args: RevokeTokenArgs): Promise<void> {
  await postForm({
    operation: "revoke",
    url: CLOUDFLARE_OAUTH_REVOKE_URL,
    params: {
      token: args.token,
      token_type_hint: args.tokenTypeHint ?? "refresh_token",
      client_id: args.clientId,
    },
    secrets: [args.token],
    fetch: args.fetch,
  });
}

// --- State -------------------------------------------------------------------

/**
 * What an authorization is for, carried through Cloudflare in `state` as
 * base64url JSON:
 *
 * - `install`: started by the deploy page. Its callback page (same origin)
 *   checks `n` against the nonce it kept and exchanges the code itself.
 * - `reconnect`: started by a manager, which keeps the PKCE verifier and
 *   sends the whole tab to Cloudflare. The callback page shows `o`, the
 *   manager's origin, asks the visitor to confirm it is their own Appflare,
 *   and only then posts `code` and `state` (or `error` and `state`) as a form
 *   to `<o>/api/cloudflare/oauth-return`; the code is useless without the
 *   manager's verifier.
 */
export type OAuthState =
  | { v: 1; n: string; k: "install" }
  | { v: 1; n: string; k: "reconnect"; o: string };

/** The longest encoded state accepted, well above any valid one. */
const MAX_STATE_LENGTH = 1024;

/** At least 16 random bytes as base64url. */
const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);

/**
 * True for an origin a reconnect may return a code to: a bare origin (no path,
 * query, fragment, user or trailing slash) that is `https:`, or `http:` on
 * `localhost` or `127.0.0.1` for local development.
 */
export function isOAuthRelayOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

const stateSchema = z.discriminatedUnion("k", [
  z.strictObject({ v: z.literal(1), n: nonceSchema, k: z.literal("install") }),
  z.strictObject({
    v: z.literal(1),
    n: nonceSchema,
    k: z.literal("reconnect"),
    o: z.string().refine(isOAuthRelayOrigin),
  }),
]);

/** A new state with a fresh 32-byte nonce. `origin` is the manager's, for a reconnect. */
export function createOAuthState(kind: "install"): OAuthState;
export function createOAuthState(kind: "reconnect", origin: string): OAuthState;
export function createOAuthState(kind: "install" | "reconnect", origin?: string): OAuthState {
  const n = randomBase64url(32);
  const state: OAuthState =
    kind === "install" ? { v: 1, n, k: kind } : { v: 1, n, k: kind, o: origin ?? "" };
  if (!stateSchema.safeParse(state).success) {
    throw new TypeError("A reconnect needs an https origin, or http on localhost.");
  }
  return state;
}

/** The `state` parameter for a state. Throws a `TypeError` when the state is invalid. */
export function encodeOAuthState(state: OAuthState): string {
  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) throw new TypeError("Invalid OAuth state.");
  const s = parsed.data;
  const ordered =
    s.k === "install" ? { v: s.v, n: s.n, k: s.k } : { v: s.v, n: s.n, k: s.k, o: s.o };
  return toBase64url(new TextEncoder().encode(JSON.stringify(ordered)));
}

/**
 * The state a callback received, or null when it is not one Appflare made
 * (bad encoding, unknown version or kind, extra fields, a nonce too short,
 * a reconnect without an allowed origin). A null state means: start again.
 */
export function decodeOAuthState(value: string): OAuthState | null {
  if (value.length === 0 || value.length > MAX_STATE_LENGTH) return null;
  const bytes = fromBase64url(value);
  if (bytes === null) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const parsed = stateSchema.safeParse(parseJson(text));
  return parsed.success ? parsed.data : null;
}
