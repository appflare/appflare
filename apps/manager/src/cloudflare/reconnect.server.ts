import {
  authorizationUrl,
  CloudflareApiError,
  CloudflareOAuthError,
  createClient,
  createOAuthState,
  createPkce,
  decodeOAuthState,
  encodeOAuthState,
  exchangeCode,
  type FetchLike,
  MANAGER_OAUTH_SCOPES,
  missingManagerScopes,
  type OAuthTokens,
  type RequestLog,
  revokeToken,
} from "@appflare/cf-api";
import { hasRole } from "../auth/roles";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import {
  type AttemptLimit,
  DEFAULT_ATTEMPT_LIMIT,
  takeAttempt,
} from "../server/attempt-limit.server";
import {
  type ConnectionMemo,
  cloudflareCredential,
  isolateConnectionMemo,
  revokeGrant,
} from "./connection.server";
import { withConnectionLock } from "./connection-lock.server";
import { GrantStoreError, type GrantStoreReason, storeGrant } from "./grant.server";
import { openValue, sealValue } from "./grant-seal";
import { readGrant } from "./grant-store.server";
import { type OAuthClientEnv, oauthClientConfig } from "./oauth-client";
import { type ReconnectOutcome, reconnectOutcomeHref } from "./reconnect-outcome";

/**
 * Reconnecting Cloudflare with "Sign in with Cloudflare" (OAuth), from the
 * connection settings. Framework-free; reconnect.functions.ts and the
 * `/api/cloudflare/oauth-return` route bind it to the request.
 *
 * 1. An administrator starts it ({@link startReconnect}): a PKCE pair and a
 *    `reconnect` state naming this manager's address are made, and the
 *    browser goes to Cloudflare. What the return needs stays here, in
 *    Better Auth's `verification` table: the state only as its SHA-256, the
 *    PKCE verifier sealed with a key derived from the state's random part
 *    (so the row alone cannot be used), who started it, and when it expires
 *    (10 minutes).
 * 2. Cloudflare sends the browser to Appflare's callback page on
 *    appflare.dev. That page shows this manager's address, asks the person
 *    to confirm it is theirs, and posts `code` and `state` (or `error` and
 *    `state`) here as a form.
 * 3. The return ({@link handleOAuthReturn}) takes the pending sign-in out
 *    (it works once), checks that whoever started it is still an
 *    administrator, exchanges the code with the verifier, checks every
 *    permission was granted, and stores the grant (`storeGrant`, which also
 *    checks the account and that this manager runs in it). A manager that
 *    connected with an API token before has that token deleted from its
 *    Worker afterwards, so no unused full-access credential stays bound.
 *    Then the browser goes back to the connection settings with the outcome.
 *
 * The return is a cross-site form post: the session cookie (SameSite=Lax)
 * does not come with it, and the callback page sends no referrer, so the
 * request has `Origin: null`. Neither is looked at; the pending sign-in an
 * administrator started is what authorizes it. Nothing here logs or returns
 * a code, a verifier, a state or a token.
 */

/** How long a started sign-in can come back. */
export const RECONNECT_TTL_MS = 10 * 60_000;
/** Where the callback page posts the result. */
export const OAUTH_RETURN_PATH = "/api/cloudflare/oauth-return";
/** Returns per client address in {@link RETURN_RATE_LIMIT}'s window, like setup's. */
export const RETURN_RATE_LIMIT: AttemptLimit = DEFAULT_ATTEMPT_LIMIT;
/** The longest form body read; a real one is well under 2 KiB. */
const MAX_RETURN_BODY = 8 * 1024;

const IDENTIFIER_PREFIX = "appflare-cloudflare-reconnect:";
const VERIFIER_KEY_INFO = "appflare-cloudflare-reconnect-verifier";
const CF_API_TOKEN_SECRET = "CF_API_TOKEN";
/** The OAuth error codes Cloudflare sends (`access_denied`, `invalid_scope`, ...). */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

/** A refused start; the message is shown as is. */
export class ReconnectError extends Error {
  override name = "ReconnectError";
}

export const RECONNECT_MESSAGES = {
  notConfigured:
    "Appflare is not connected to a Cloudflare account yet. Finish setup first, then reconnect here.",
  badOrigin:
    "Appflare can only return from Cloudflare to an https address. Open Appflare at its https address and start again.",
} as const;

// --- Small helpers -----------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The `verification` identifier of a pending sign-in: its state's SHA-256. */
async function identifierFor(encodedState: string): Promise<string> {
  return `${IDENTIFIER_PREFIX}${await sha256Hex(encodedState)}`;
}

/**
 * The key the verifier is sealed with, derived (HKDF-SHA-256) from the
 * state's random part. Only the state carries it, and only its hash is
 * stored, so a copy of the database cannot open the verifier.
 */
async function verifierKey(nonce: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(nonce),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(VERIFIER_KEY_INFO),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** What a pending sign-in keeps, as the `verification` row's value. */
interface PendingValue {
  v: 1;
  userId: string;
  clientId: string;
  redirectUri: string;
  /** Sealed with {@link verifierKey}. */
  verifier: string;
}

function parsePending(value: string): PendingValue | null {
  try {
    const parsed = JSON.parse(value) as Partial<PendingValue>;
    if (
      parsed.v !== 1 ||
      typeof parsed.userId !== "string" ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.redirectUri !== "string" ||
      typeof parsed.verifier !== "string"
    ) {
      return null;
    }
    return parsed as PendingValue;
  } catch {
    return null;
  }
}

// --- Start -------------------------------------------------------------------

export interface StartReconnectDeps {
  db: D1Database;
  /** The administrator starting it (checked by the caller). */
  userId: string;
  /** This manager's origin as the browser uses it, where the sign-in comes back. */
  origin: string;
  /** The Worker's optional development client and callback (`oauthClientConfig`). */
  config: OAuthClientEnv;
  now?: () => number;
}

export interface StartedReconnect {
  /** Cloudflare's authorization page; the browser goes there. */
  url: string;
  /** The address appflare.dev will ask the person to confirm. */
  origin: string;
}

/**
 * Starts a sign-in for an administrator: the client is the stored grant's
 * own when there is one (a refresh token works only with its client), else
 * the configured one; every manager permission is asked for.
 */
export async function startReconnect(deps: StartReconnectDeps): Promise<StartedReconnect> {
  const now = (deps.now ?? Date.now)();
  const settings = await readSettings(createDb(deps.db), [
    SETTING.cfTokenConfigured,
    SETTING.accountId,
  ]);
  if (settings.cf_token_configured !== "1" || !settings.account_id) {
    throw new ReconnectError(RECONNECT_MESSAGES.notConfigured);
  }
  let state: ReturnType<typeof createOAuthState>;
  try {
    state = createOAuthState("reconnect", deps.origin);
  } catch {
    throw new ReconnectError(RECONNECT_MESSAGES.badOrigin);
  }
  const config = oauthClientConfig(deps.config);
  const grant = await readGrant(deps.db);
  const clientId = grant?.clientId ?? config.clientId;
  const encoded = encodeOAuthState(state);
  const pkce = await createPkce();
  const identifier = await identifierFor(encoded);
  const value: PendingValue = {
    v: 1,
    userId: deps.userId,
    clientId,
    redirectUri: config.callbackUrl,
    verifier: await sealValue(await verifierKey(state.n), pkce.verifier, identifier),
  };
  await deps.db.batch([
    // Sign-ins nobody finished: nothing can use them any more.
    deps.db
      .prepare("DELETE FROM verification WHERE identifier LIKE ?1 AND expires_at <= ?2")
      .bind(`${IDENTIFIER_PREFIX}%`, now),
    deps.db
      .prepare(
        `INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
      )
      .bind(crypto.randomUUID(), identifier, JSON.stringify(value), now + RECONNECT_TTL_MS, now),
  ]);
  return {
    url: authorizationUrl({
      clientId,
      redirectUri: config.callbackUrl,
      scopes: MANAGER_OAUTH_SCOPES,
      state: encoded,
      codeChallenge: pkce.challenge,
    }),
    origin: deps.origin,
  };
}

// --- Return ------------------------------------------------------------------

export interface OAuthReturnEnv {
  DB: D1Database;
  CF_API_TOKEN?: string;
  CF_GRANT_KEY?: string;
}

export interface OAuthReturnDeps {
  /** The Worker version serving this request (`CF_VERSION_METADATA.id`), when bound. */
  runningVersionId: string | null;
  /** Work after the response: reading the account's capabilities with the new connection. */
  afterConnected?: () => Promise<void>;
  waitUntil?: (promise: Promise<unknown>) => void;
  fetch?: FetchLike;
  onRequest?: (log: RequestLog) => void;
  baseUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seams. */
  memo?: ConnectionMemo;
  generateKey?: () => string;
}

function outcomeResponse(outcome: ReconnectOutcome): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: reconnectOutcomeHref(outcome),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Counts one return for `client` through the attempt limit every door
 * before sign-in shares (server/attempt-limit.server.ts), under this
 * return's own key. False once the window is used up.
 */
export function takeReturnAttempt(
  db: D1Database,
  client: string,
  now: number,
  limit: AttemptLimit = RETURN_RATE_LIMIT,
): Promise<boolean> {
  return takeAttempt(db, "cloudflare-oauth-return", client, now, limit);
}

/**
 * The body as text, read through its stream and given up as soon as it
 * passes `max` bytes, whatever `Content-Length` says (null then). Read as
 * bytes: a form is ASCII (URL-encoded), and workerd warns about `.text()`
 * on one.
 */
async function readBounded(request: Request, max: number): Promise<string | null> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The form's fields; null when it is not a form this route reads (a field given twice, say). */
async function readForm(
  request: Request,
): Promise<{ code: string | null; state: string; error: string | null } | Response> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    return plain(415, "Appflare expects the form appflare.dev sends.");
  }
  const body = await readBounded(request, MAX_RETURN_BODY);
  if (body === null) return plain(413, "This form is too large.");
  const form = new URLSearchParams(body);
  const one = (name: string): string | null | undefined => {
    const all = form.getAll(name);
    if (all.length > 1) return undefined;
    return all[0] ?? null;
  };
  const code = one("code");
  const state = one("state");
  const error = one("error");
  if (code === undefined || state === undefined || error === undefined || !state) {
    return plain(400, "This form is not one Appflare can read.");
  }
  return { code: code || null, state, error: error || null };
}

/** Takes the pending sign-in for `encodedState` out (single use); null when none. */
async function takePending(
  db: D1Database,
  encodedState: string,
): Promise<{ value: PendingValue | null; expiresAt: number } | null> {
  const row = await db
    .prepare("DELETE FROM verification WHERE identifier = ?1 RETURNING value, expires_at")
    .bind(await identifierFor(encodedState))
    .first<{ value: string; expires_at: number }>();
  if (row === null) return null;
  return { value: parsePending(row.value), expiresAt: Number(row.expires_at) };
}

/** Whether `userId` is still an administrator who is not banned. */
async function stillAdmin(db: D1Database, userId: string, now: number): Promise<boolean> {
  const row = await db
    .prepare('SELECT role, banned, ban_expires FROM "user" WHERE id = ?1')
    .bind(userId)
    .first<{ role: string | null; banned: number | null; ban_expires: number | null }>();
  if (row === null || !hasRole(row.role, "admin")) return false;
  const banned = row.banned === 1 && (row.ban_expires === null || row.ban_expires > now);
  return !banned;
}

function grantOutcome(reason: GrantStoreReason): ReconnectOutcome {
  switch (reason) {
    case "other_account":
      return "wrong-account";
    case "missing_scopes":
      return "missing-permissions";
    case "unreachable":
      return "unreachable";
    case "busy":
      return "busy";
    case "refused":
    case "rejected":
    case "unverifiable":
      return "failed";
  }
}

function exchangeOutcome(error: CloudflareOAuthError): ReconnectOutcome {
  // A code works once and briefly: refused means used or too old.
  if (error.code === "invalid_grant") return "expired";
  return error.retryable ? "unreachable" : "failed";
}

/** Revokes what an exchange issued and Appflare will not keep; best effort. */
async function discard(tokens: OAuthTokens, clientId: string, fetchImpl: FetchLike): Promise<void> {
  if (tokens.refreshToken !== null) {
    await revokeGrant({ clientId, refreshToken: tokens.refreshToken }, { fetch: fetchImpl });
    return;
  }
  try {
    await revokeToken({
      clientId,
      token: tokens.accessToken,
      tokenTypeHint: "access_token",
      fetch: fetchImpl,
    });
  } catch {
    // Best effort: an access token ends within the hour anyway.
  }
}

/**
 * `POST /api/cloudflare/oauth-return`: finishes a sign-in an administrator
 * started, and sends the browser to the connection settings with how it
 * ended (303). A request that is not that form gets a short plain refusal.
 */
export async function handleOAuthReturn(
  request: Request,
  env: OAuthReturnEnv,
  deps: OAuthReturnDeps,
): Promise<Response> {
  const now = deps.now ?? Date.now;
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  if (request.method !== "POST") return plain(405, "Method not allowed.");

  const client = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await takeReturnAttempt(env.DB, client, now()))) return outcomeResponse("too-many");

  const form = await readForm(request);
  if (form instanceof Response) return form;

  const state = decodeOAuthState(form.state);
  if (state === null || state.k !== "reconnect") return outcomeResponse("expired");
  const pending = await takePending(env.DB, form.state);
  if (pending === null || pending.value === null || pending.expiresAt <= now()) {
    return outcomeResponse("expired");
  }
  const started = pending.value;
  if (!(await stillAdmin(env.DB, started.userId, now()))) return outcomeResponse("not-allowed");

  if (form.error !== null) {
    // Only an OAuth error code is repeated in the log, nothing else the form carried.
    const code = OAUTH_ERROR_CODE.test(form.error) ? form.error : "unrecognized";
    console.log(`cloudflare reconnect: the sign-in ended at Cloudflare (${code})`);
    return outcomeResponse(form.error === "access_denied" ? "declined" : "cloudflare-error");
  }
  if (form.code === null) return outcomeResponse("cloudflare-error");

  let verifier: string;
  try {
    verifier = await openValue(
      await verifierKey(state.n),
      started.verifier,
      await identifierFor(form.state),
    );
  } catch {
    return outcomeResponse("expired");
  }

  let tokens: OAuthTokens;
  try {
    tokens = await exchangeCode({
      clientId: started.clientId,
      code: form.code,
      codeVerifier: verifier,
      redirectUri: started.redirectUri,
      fetch: fetchImpl,
      now,
    });
  } catch (error) {
    if (!(error instanceof CloudflareOAuthError)) throw error;
    console.warn("cloudflare reconnect: the code exchange failed", { code: error.code });
    return outcomeResponse(exchangeOutcome(error));
  }

  // Every permission, and a refresh token (`offline_access`): without one
  // Appflare would lose access within the hour.
  const scopes = tokens.scopes ?? [...MANAGER_OAUTH_SCOPES];
  if (tokens.refreshToken === null || missingManagerScopes(scopes).length > 0) {
    await discard(tokens, started.clientId, fetchImpl);
    console.warn("cloudflare reconnect: Cloudflare granted fewer permissions than Appflare needs");
    return outcomeResponse("missing-permissions");
  }

  const { account_id: accountId } = await readSettings(createDb(env.DB), [SETTING.accountId]);
  if (!accountId) {
    await discard(tokens, started.clientId, fetchImpl);
    return outcomeResponse("failed");
  }

  const memo = deps.memo ?? isolateConnectionMemo();
  let stored: Awaited<ReturnType<typeof storeGrant>>;
  try {
    stored = await storeGrant({
      db: env.DB,
      ...(env.CF_GRANT_KEY === undefined ? {} : { grantKey: env.CF_GRANT_KEY }),
      grant: { refreshToken: tokens.refreshToken, clientId: started.clientId, scopes },
      accountId,
      host: new URL(request.url).host,
      runningVersionId: deps.runningVersionId,
      fetch: fetchImpl,
      memo,
      ...(deps.onRequest === undefined ? {} : { onRequest: deps.onRequest }),
      ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.generateKey === undefined ? {} : { generateKey: deps.generateKey }),
    });
  } catch (error) {
    if (error instanceof GrantStoreError) {
      // Refused before the renewal (the grant is still live) or after it
      // (storeGrant revoked the renewed one, which ends the grant): revoking
      // again is harmless, so it is always done.
      await discard(tokens, started.clientId, fetchImpl);
      console.warn(`cloudflare reconnect: the authorization was refused (${error.reason})`);
      return outcomeResponse(grantOutcome(error.reason));
    }
    console.error("cloudflare reconnect: storing the authorization failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    await discard(tokens, started.clientId, fetchImpl);
    return outcomeResponse("failed");
  }
  console.log(
    `cloudflare reconnect: connected with Cloudflare sign-in (before: ${stored.previous ?? "nothing"})`,
  );

  let outcome: ReconnectOutcome = "connected";
  const tokenBound = typeof env.CF_API_TOKEN === "string" && env.CF_API_TOKEN.length > 0;
  if (stored.previous === "api_token" || tokenBound) {
    const removal = await removeApiToken(env, stored, memo, fetchImpl, deps);
    if (removal === "kept") outcome = "connected-token-kept";
    if (removal === "replaced") outcome = "changed-meanwhile";
  } else if ((await readGrant(env.DB)) === null) {
    // An API token saved since the grant was stored took its place.
    outcome = "changed-meanwhile";
  }
  if (outcome === "changed-meanwhile") {
    console.warn("cloudflare reconnect: an API token replaced the new authorization meanwhile");
    return outcomeResponse(outcome);
  }
  if (deps.afterConnected !== undefined) {
    const after = deps.afterConnected().catch((error: unknown) => {
      console.error("cloudflare reconnect: checking the account afterwards failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (deps.waitUntil !== undefined) deps.waitUntil(after);
    else await after;
  }
  return outcomeResponse(outcome);
}

/**
 * Deletes `CF_API_TOKEN` from the manager's Worker now that a grant is the
 * connection, with the grant's access token, holding the connection lock so
 * a token saved meanwhile (which would replace the grant) is never deleted.
 * `removed` (already gone counts), `kept` when it could not be deleted, or
 * `replaced` when a token saved since took the grant's place: that token is
 * the connection now and stays.
 */
async function removeApiToken(
  env: OAuthReturnEnv,
  stored: { accountId: string; workerName: string },
  memo: ConnectionMemo,
  fetchImpl: FetchLike,
  deps: OAuthReturnDeps,
): Promise<"removed" | "kept" | "replaced"> {
  try {
    return await withConnectionLock(
      env.DB,
      () => new Error("another change to the connection holds the lock"),
      async (): Promise<"removed" | "replaced"> => {
        if ((await readGrant(env.DB)) === null) return "replaced";
        const api = createClient({
          accountId: stored.accountId,
          token: cloudflareCredential(
            { DB: env.DB, CF_GRANT_KEY: env.CF_GRANT_KEY },
            { fetch: fetchImpl, memo, ...(deps.now === undefined ? {} : { now: deps.now }) },
          ),
          fetch: fetchImpl,
          ...(deps.onRequest === undefined ? {} : { onRequest: deps.onRequest }),
          ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
        });
        try {
          await api.workers.deleteSecret(stored.workerName, CF_API_TOKEN_SECRET);
        } catch (error) {
          if (error instanceof CloudflareApiError && error.status === 404) return "removed";
          throw error;
        }
        return "removed";
      },
    );
  } catch (error) {
    console.error("cloudflare reconnect: could not remove the previous API token", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "kept";
  }
}
