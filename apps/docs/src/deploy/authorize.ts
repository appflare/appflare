import {
  authorizationUrl,
  CloudflareOAuthError,
  createOAuthState,
  createPkce,
  decodeOAuthState,
  encodeOAuthState,
  exchangeCode,
  isOAuthRelayOrigin,
  MANAGER_OAUTH_API_SCOPES,
  MANAGER_OAUTH_SCOPES,
  missingManagerScopes,
  type OAuthState,
} from "@appflare/cf-api/oauth";
import type { CallbackParams } from "./arrival.ts";
import type { FetchLike } from "./installer-api.ts";
import type { DeployStorage, Grant, PendingAuthorization } from "./storage.ts";

/**
 * Signing in to Cloudflare from the deploy page: authorization code with
 * PKCE, a public client, the code exchanged in the browser. And the callback
 * page's other job: passing a manager's reconnect code back to the window
 * that opened it.
 */

/** Starts a sign-in: keeps the verifier and nonce in this tab and returns Cloudflare's consent URL. */
export async function startAuthorization(
  setup: { clientId: string; redirectUri: string },
  storage: Pick<DeployStorage, "authorization">,
  now: number,
): Promise<string> {
  const pkce = await createPkce();
  const state = createOAuthState("install");
  const pending: PendingAuthorization = {
    nonce: state.n,
    verifier: pkce.verifier,
    clientId: setup.clientId,
    redirectUri: setup.redirectUri,
    startedAt: now,
  };
  if (!storage.authorization.write(pending)) throw new StorageRefused();
  return authorizationUrl({
    clientId: setup.clientId,
    redirectUri: setup.redirectUri,
    scopes: MANAGER_OAUTH_SCOPES,
    state: encodeOAuthState(state),
    codeChallenge: pkce.challenge,
  });
}

/** This browser does not let the page keep anything for the sign-in. */
export class StorageRefused extends Error {
  override name = "StorageRefused";
  constructor() {
    super("This browser does not let the page keep the sign-in.");
  }
}

/** Where a manager receives the result of its Reconnect Cloudflare, as a form POST. */
export const OAUTH_RETURN_PATH = "/api/cloudflare/oauth-return";

/** The form fields posted back to a manager: the code, or Cloudflare's refusal, with the state. */
export type ReturnFields = { code: string; state: string } | { error: string; state: string };

/** Why a callback cannot go on. */
export type CallbackProblem =
  /** No state, or one Appflare did not make. */
  | "invalid-state"
  /** A deploy sign-in this tab did not start (another tab, or already used). */
  | "unknown-session"
  /** Neither a code nor an error. */
  | "missing-code";

export type CallbackDecision =
  | { kind: "exchange"; code: string; pending: PendingAuthorization }
  /** Consent was refused or failed at Cloudflare (OAuth `error`). */
  | { kind: "declined"; error: string }
  /**
   * A manager's reconnect: shown to the visitor, and posted to `origin` only
   * once they confirm it is their own Appflare.
   */
  | { kind: "confirm-return"; origin: string; fields: ReturnFields }
  | { kind: "problem"; problem: CallbackProblem };

/** RFC 6749 (4.1.2.1): `error` is printable ASCII without `"` and `\`. */
const OAUTH_ERROR = /^[\x20\x21\x23-\x5B\x5D-\x7E]{1,100}$/;

/**
 * What the callback page does with what it arrived with. Nothing goes back to
 * a manager without a valid reconnect state, and then only to that state's
 * own origin (https, or http on localhost), and only after the visitor
 * confirms it: anyone can start Appflare's genuine consent with their own
 * origin in the state, and would get the code otherwise.
 */
export function decideCallback(
  params: CallbackParams,
  pending: PendingAuthorization | null,
): CallbackDecision {
  const state: OAuthState | null = params.state === null ? null : decodeOAuthState(params.state);
  if (state === null || params.state === null) return { kind: "problem", problem: "invalid-state" };
  const error = params.error !== null && OAUTH_ERROR.test(params.error) ? params.error : null;

  if (state.k === "reconnect") {
    if (!isOAuthRelayOrigin(state.o)) return { kind: "problem", problem: "invalid-state" };
    if (error !== null) {
      return { kind: "confirm-return", origin: state.o, fields: { error, state: params.state } };
    }
    if (params.code === null) return { kind: "problem", problem: "missing-code" };
    return {
      kind: "confirm-return",
      origin: state.o,
      fields: { code: params.code, state: params.state },
    };
  }

  if (pending === null || pending.nonce !== state.n) {
    return { kind: "problem", problem: "unknown-session" };
  }
  if (error !== null) return { kind: "declined", error };
  if (params.code === null) return { kind: "problem", problem: "missing-code" };
  return { kind: "exchange", code: params.code, pending };
}

/** Why a code did not become a usable grant. */
export type ExchangeProblem =
  /** Cloudflare refused the code or did not answer (`retryable` says which). */
  | { kind: "refused"; retryable: boolean; code: string }
  /** No refresh token: the new Appflare could not stay connected. */
  | { kind: "no-refresh-token" }
  /** Some of the permissions Appflare asks for were not granted. */
  | { kind: "missing-scopes"; missing: string[] };

export type ExchangeResult = { ok: true; grant: Grant } | { ok: false; problem: ExchangeProblem };

/**
 * Exchanges the code at Cloudflare's token endpoint, from the browser, and
 * checks the grant covers everything Appflare needs.
 */
export async function exchangeForGrant(
  code: string,
  pending: PendingAuthorization,
  fetch?: FetchLike,
  now: () => number = Date.now,
): Promise<ExchangeResult> {
  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode({
      clientId: pending.clientId,
      code,
      codeVerifier: pending.verifier,
      redirectUri: pending.redirectUri,
      now,
      ...(fetch === undefined ? {} : { fetch }),
    });
  } catch (error) {
    if (error instanceof CloudflareOAuthError) {
      return {
        ok: false,
        problem: { kind: "refused", retryable: error.retryable, code: error.code },
      };
    }
    throw error;
  }
  if (tokens.refreshToken === null) return { ok: false, problem: { kind: "no-refresh-token" } };
  // No `scope` in the answer means the scopes asked for (RFC 6749, 5.1).
  const scopes = tokens.scopes ?? [...MANAGER_OAUTH_SCOPES];
  const missing = missingManagerScopes(scopes);
  if (missing.length > 0) return { ok: false, problem: { kind: "missing-scopes", missing } };
  return {
    ok: true,
    grant: {
      clientId: pending.clientId,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken,
      scopes,
    },
  };
}

/** Every permission Appflare asks for, for the "details" of a missing-permission message. */
export const REQUESTED_SCOPES = MANAGER_OAUTH_API_SCOPES;
