import {
  CloudflareOAuthError,
  type FetchLike,
  missingManagerScopes,
  OAUTH_INVALID_RESPONSE,
  type RefreshedTokens,
  refreshGrant,
  revokeToken,
} from "@appflare/cf-api";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";
import {
  CloudflareConnectionError,
  CONNECTION_MESSAGES,
  needsReconnecting,
} from "./connection-errors";
import type { ConnectionView } from "./connection-view";
import { type GrantKey, importGrantKey, openValue, sealContext, sealValue } from "./grant-seal";
import {
  type GrantRenewal,
  type GrantRow,
  markNeedsReconnect,
  readGrant,
  recordProblem,
  saveRenewal,
} from "./grant-store.server";

/**
 * The manager's Cloudflare connection: the one place that knows where the
 * credential for Cloudflare API calls comes from. Everything that calls
 * Cloudflare as the manager builds its client from
 * {@link cloudflareConnection} (through `getCfClient`, the job steps and the
 * job units), so a job that runs for many minutes keeps working while access
 * tokens come and go.
 *
 * Two kinds:
 *
 * - `api_token`: the `CF_API_TOKEN` secret an admin pasted. Every manager
 *   set up before OAuth existed is one, with nothing to migrate: the kind
 *   is "API token" whenever no grant is stored.
 * - `oauth`: a grant stored in D1 (`cloudflare_grant`, sealed with the
 *   `CF_GRANT_KEY` secret, see grant-seal.ts). The manager renews its access
 *   token itself.
 *
 * Resolving an access token, in order: this isolate's memo; the stored
 * access token while more than {@link ACCESS_SAFETY_MARGIN_MS} of it is
 * left; a refresh. A credential provider reads D1 once, on its first call,
 * and afterwards only when the memo has run out, never once per API call.
 * A refresh is serialized across isolates, Workflow instances and units by
 * a lease in `settings` (db/settings-lock.ts); the holder reads the grant
 * again, refreshes, and stores the rotated refresh token and the new access
 * token before it lets go. Every write after a refresh is conditional on the
 * refresh token that was sent, so a holder whose refresh outlived its lease
 * neither overwrites a newer rotation nor leaves a working grant marked as
 * refused. A refresh token Cloudflare refuses (`invalid_grant`) marks the
 * grant as needing reconnecting, and nothing tries to refresh it again until
 * a new credential is stored; a request that got no answer, a 5xx or a 429
 * is retried a couple of times and then fails as temporary, leaving the
 * grant as it was. An access token the API refuses (401, a grant withdrawn in
 * the dashboard) is renewed once, and the request sent once more. The
 * connection never switches kinds by itself.
 *
 * Subrequests: a refresh is one request to Cloudflare's token endpoint (up
 * to three when it answers with a temporary error), made through the
 * caller's `fetch`, so the job steps and units count it where they count
 * their own requests; the jobs keep room for one per invocation
 * (../jobs/invocation-budget.ts). An access token lasts an hour, so a job
 * refreshes at most about once an hour.
 *
 * No token or key appears in a log line, an error, a job log or a setting.
 */

/** An access token is used only while it has more than this left. */
export const ACCESS_SAFETY_MARGIN_MS = 5 * 60_000;

/**
 * A grant whose key the running version does not have is taken to be
 * waiting for the redeploy that writing the key started, for this long
 * after the key was written; after that the key is lost (a rollback to a
 * version from before it, say).
 */
export const KEY_REDEPLOY_WINDOW_MS = 10 * 60_000;

const REFRESH_LOCK_KEY = "cf_grant_refresh_lock";
/** One refresh request gives up after this. */
const REFRESH_TIMEOUT_MS = 10_000;
/** Waits before the second and third refresh attempts after a temporary failure. */
const REFRESH_RETRY_DELAYS_MS = [500, 1_500] as const;
/**
 * The longest a lease holder refreshes: three attempts that each give up
 * after {@link REFRESH_TIMEOUT_MS}, and the waits between them (32 s).
 */
export const REFRESH_WORST_CASE_MS =
  3 * REFRESH_TIMEOUT_MS + REFRESH_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
/** The lease outlives the holder's worst case with room for its D1 writes. */
const REFRESH_LOCK_TTL_MS = 60_000;
/**
 * How often a request waiting for another one's refresh looks again, and
 * how many times: 45 s in all, longer than the holder's worst case, after
 * which the wait ends as a temporary (retryable) failure.
 */
export const LOCK_POLL_MS = 500;
export const LOCK_POLLS = 90;
/**
 * After the API refused an access token (401), it is renewed once; another
 * refusal within this long is passed on as it is, so a token the API keeps
 * refusing never turns into a refresh per request.
 */
const REJECTION_RENEWAL_GAP_MS = 5 * 60_000;

/** Plain words stored with the grant, shown on Settings. */
export const GRANT_PROBLEMS = {
  revoked:
    "Cloudflare no longer accepts this connection: it was withdrawn in Cloudflare, it expired, or it was used somewhere else.",
  unreachable:
    "Cloudflare did not answer when Appflare renewed its access. Appflare tries again by itself.",
  refused: (code: string) => `Cloudflare refused to renew Appflare's access (${code}).`,
  keyLost: "This version of Appflare cannot read its saved connection to Cloudflare.",
} as const;

/** What the connection reads of the Worker's environment. */
export interface ConnectionEnv {
  /** Without the database there is no stored grant; only tests build such an env. */
  DB?: D1Database;
  CF_API_TOKEN?: string;
  /** The key the stored grant is sealed with (grant-seal.ts). */
  CF_GRANT_KEY?: string;
}

/** What one isolate keeps between requests. */
export interface ConnectionMemo {
  /** The last access token resolved, for the grant it belongs to. */
  access: { grantId: string; token: string; expiresAt: number } | null;
  /**
   * A renewal this isolate could not store (D1 failed twice), with the
   * sealed refresh token it replaces: stored before anything refreshes
   * again, so the newest refresh token is not lost while the isolate lives.
   */
  pending: { grantId: string; sent: string; renewal: GrantRenewal } | null;
  /**
   * The last access token the API refused, and when it was renewed for that:
   * no resolution hands it out again, and another refusal soon after is not
   * renewed again.
   */
  rejected: { grantId: string; token: string; at: number } | null;
  /**
   * Keys this isolate can use, by fingerprint: the Worker's own, and a key
   * this isolate wrote itself while its version did not have it yet.
   */
  keys: Map<string, CryptoKey>;
  /** The `CF_GRANT_KEY` value already imported, so it is hashed once. */
  envKey: { secret: string; key: GrantKey | null } | null;
}

export function createConnectionMemo(): ConnectionMemo {
  return { access: null, pending: null, rejected: null, keys: new Map(), envKey: null };
}

const isolateMemo = createConnectionMemo();

/** The memo every request of this isolate shares. */
export function isolateConnectionMemo(): ConnectionMemo {
  return isolateMemo;
}

export interface ConnectionDeps {
  /** For a refresh; pass the caller's counting fetch so the request is counted. */
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: another isolate's memo. */
  memo?: ConnectionMemo;
}

interface Ctx {
  env: ConnectionEnv;
  db: D1Database | null;
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  memo: ConnectionMemo;
}

function context(env: ConnectionEnv, deps: ConnectionDeps): Ctx {
  return {
    env,
    db: env.DB ?? null,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    memo: deps.memo ?? isolateMemo,
  };
}

/** What a resolution asks for. */
interface Ask {
  /** How long the token must last beyond the safety margin. */
  minValidityMs: number;
  /** An access token the API refused: never hand it out again. */
  reject: string | null;
  /** This request already holds the refresh lease (it must not wait for itself). */
  leased: boolean;
}

const PLAIN: Ask = { minValidityMs: 0, reject: null, leased: false };

/** The stored grant, or null (no database, no table, no grant). */
async function grantOf(ctx: Ctx): Promise<GrantRow | null> {
  return ctx.db === null ? null : readGrant(ctx.db);
}

/** `settings.cf_token_configured`; false on a database not migrated yet, which has none. */
async function connectionConfigured(db: D1Database): Promise<boolean> {
  try {
    const row = await readSettings(createDb(db), [SETTING.cfTokenConfigured]);
    return row.cf_token_configured === "1";
  } catch (error) {
    const text = `${error instanceof Error ? error.message : ""} ${
      error instanceof Error && error.cause instanceof Error ? error.cause.message : ""
    }`;
    if (text.includes("no such table")) return false;
    throw error;
  }
}

/** Why there is no credential when no grant is stored and the running version has no token. */
async function noApiToken(ctx: Ctx): Promise<CloudflareConnectionError> {
  // A connection was set up (a token saved, or a grant switched for a token
  // just now): the version that has the token is still rolling out.
  if (ctx.db !== null && (await connectionConfigured(ctx.db))) {
    return new CloudflareConnectionError("redeploying", CONNECTION_MESSAGES.redeploying);
  }
  return new CloudflareConnectionError("not_configured", CONNECTION_MESSAGES.notConfigured);
}

/** `CF_API_TOKEN`; D1 is read only when it is missing, to say why. */
async function apiToken(ctx: Ctx): Promise<string> {
  const token = ctx.env.CF_API_TOKEN;
  if (token !== undefined && token.length > 0) return token;
  throw await noApiToken(ctx);
}

function reconnectError(): CloudflareConnectionError {
  return new CloudflareConnectionError("needs_reconnect", CONNECTION_MESSAGES.needsReconnect);
}

function temporaryError(): CloudflareConnectionError {
  return new CloudflareConnectionError("temporary", CONNECTION_MESSAGES.temporary);
}

function lasts(expiresAt: number | null, ctx: Ctx, minValidityMs: number): boolean {
  return expiresAt !== null && expiresAt - ctx.now() > ACCESS_SAFETY_MARGIN_MS + minValidityMs;
}

function memoHit(ctx: Ctx, grantId: string, ask: Ask): string | null {
  const access = ctx.memo.access;
  if (access === null || access.grantId !== grantId) return null;
  if (refusedToken(ctx, grantId, access.token, ask)) return null;
  return lasts(access.expiresAt, ctx, ask.minValidityMs) ? access.token : null;
}

/** The key with fingerprint `id`, when this isolate has it. */
async function heldKey(ctx: Ctx, id: string): Promise<CryptoKey | null> {
  const kept = ctx.memo.keys.get(id);
  if (kept !== undefined) return kept;
  const secret = ctx.env.CF_GRANT_KEY;
  if (secret === undefined || secret.length === 0) return null;
  if (ctx.memo.envKey?.secret !== secret) {
    ctx.memo.envKey = { secret, key: await importGrantKey(secret) };
  }
  const own = ctx.memo.envKey.key;
  if (own === null || own.id !== id) return null;
  ctx.memo.keys.set(own.id, own.key);
  return own.key;
}

/** Keeps a key this isolate wrote itself, for the requests it serves before its version has it. */
export function holdKey(memo: ConnectionMemo, key: GrantKey): void {
  memo.keys.set(key.id, key.key);
}

/** The grant's key is not here: a redeploy still rolling out, or a key that is gone. */
async function unreadableKey(ctx: Ctx, row: GrantRow): Promise<CloudflareConnectionError> {
  let writtenAt = row.connectedAt;
  if (ctx.db !== null) {
    const stored = (await readSettings(createDb(ctx.db), [SETTING.cfGrantKey])).cf_grant_key;
    const info = parseKeyInfo(stored);
    if (info !== null && info.id === row.keyId) writtenAt = Math.max(writtenAt, info.writtenAt);
  }
  return ctx.now() - writtenAt < KEY_REDEPLOY_WINDOW_MS
    ? new CloudflareConnectionError("redeploying", CONNECTION_MESSAGES.redeploying)
    : new CloudflareConnectionError("key_lost", CONNECTION_MESSAGES.keyLost);
}

/** `settings.cf_grant_key`: which key was last written to the Worker, and when. */
export function parseKeyInfo(value: string | undefined): { id: string; writtenAt: number } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { id?: unknown; writtenAt?: unknown };
    return typeof parsed.id === "string" && typeof parsed.writtenAt === "number"
      ? { id: parsed.id, writtenAt: parsed.writtenAt }
      : null;
  } catch {
    return null;
  }
}

async function keyFor(ctx: Ctx, row: GrantRow): Promise<CryptoKey> {
  const key = await heldKey(ctx, row.keyId);
  if (key === null) throw await unreadableKey(ctx, row);
  return key;
}

/**
 * Stores a renewal this isolate could not store before. Kept for later when
 * D1 fails again; dropped once stored, or once the grant moved on without it.
 * A newer one kept while this write was out stays kept.
 */
async function flushPending(ctx: Ctx): Promise<void> {
  const pending = ctx.memo.pending;
  if (pending === null || ctx.db === null) return;
  try {
    await saveRenewal(ctx.db, pending.grantId, pending.sent, pending.renewal);
    if (ctx.memo.pending === pending) ctx.memo.pending = null;
  } catch {
    // Still unreachable: kept, and tried again on the next resolution.
  }
}

/**
 * The renewal of `row` this isolate holds and has not stored: its refresh
 * token is the newest, and the one in D1 (`sent`) was already used. Null
 * when there is none, or when the grant moved on without it (then dropped).
 */
function pendingFor(ctx: Ctx, row: GrantRow): ConnectionMemo["pending"] {
  const pending = ctx.memo.pending;
  if (pending === null || pending.grantId !== row.id) return null;
  if (pending.sent !== row.refreshToken) {
    ctx.memo.pending = null;
    return null;
  }
  return pending;
}

/** An access token the API refused: never handed out again, from the memo or from D1. */
function refusedToken(ctx: Ctx, grantId: string, token: string, ask: Ask): boolean {
  if (token === ask.reject) return true;
  const rejected = ctx.memo.rejected;
  return rejected !== null && rejected.grantId === grantId && rejected.token === token;
}

interface Resolved {
  token: string;
  /** The grant it came from; null for the API token. */
  grantId: string | null;
}

/** An access token of `row` for `ask`. */
async function resolveGrant(ctx: Ctx, row: GrantRow, ask: Ask): Promise<Resolved> {
  await flushPending(ctx);
  if (row.status === "needs_reconnect") throw reconnectError();
  const hit = memoHit(ctx, row.id, ask);
  if (hit !== null) return { token: hit, grantId: row.id };
  const key = await keyFor(ctx, row);
  const stored = await storedAccess(ctx, row, key, ask);
  if (stored !== null) return { token: stored, grantId: row.id };
  if (ask.leased && ctx.db !== null) return renew(ctx, ctx.db, row, key, ask);
  return refreshLocked(ctx, row, key, ask);
}

/** The stored access token, when it lasts long enough and opens; remembered in the memo. */
async function storedAccess(
  ctx: Ctx,
  row: GrantRow,
  key: CryptoKey,
  ask: Ask,
): Promise<string | null> {
  if (row.accessToken === null || !lasts(row.accessExpiresAt, ctx, ask.minValidityMs)) return null;
  let token: string;
  try {
    token = await openValue(key, row.accessToken, sealContext(row.id, "access"));
  } catch {
    // Unreadable with the right key: renew it rather than fail.
    return null;
  }
  if (refusedToken(ctx, row.id, token, ask)) return null;
  ctx.memo.access = { grantId: row.id, token, expiresAt: row.accessExpiresAt ?? 0 };
  return token;
}

/**
 * What the grant looks like now, after another request may have changed it
 * (renewed it, replaced it, marked it, or switched to an API token): a
 * credential when that settles it, else null (still ours to renew). A
 * replaced grant is resolved with the same lease, never by waiting for it.
 */
async function settled(
  ctx: Ctx,
  ours: GrantRow,
  current: GrantRow | null,
  ask: Ask,
): Promise<Resolved | null> {
  if (current === null) return { token: await apiToken(ctx), grantId: null };
  if (current.id !== ours.id) return resolveGrant(ctx, current, ask);
  if (current.status === "needs_reconnect") throw reconnectError();
  const key = await keyFor(ctx, current);
  const token = await storedAccess(ctx, current, key, ask);
  return token === null ? null : { token, grantId: current.id };
}

/** Takes the refresh lease (waiting for another holder), then renews unless someone else did. */
async function refreshLocked(ctx: Ctx, row: GrantRow, key: CryptoKey, ask: Ask): Promise<Resolved> {
  const db = ctx.db;
  if (db === null) throw reconnectError();
  const owner = crypto.randomUUID();
  for (let poll = 0; ; poll++) {
    if (await tryAcquireSettingsLock(db, REFRESH_LOCK_KEY, owner, REFRESH_LOCK_TTL_MS, ctx.now())) {
      break;
    }
    if (poll >= LOCK_POLLS) {
      throw new CloudflareConnectionError("temporary", CONNECTION_MESSAGES.busy);
    }
    await ctx.sleep(LOCK_POLL_MS);
    const current = await readGrant(db);
    // A grant replaced meanwhile gets its own resolution, which may wait for
    // the lease in turn; this one is not held yet.
    const done = await settled(ctx, row, current, { ...ask, leased: false });
    if (done !== null) return done;
  }
  try {
    const current = await readGrant(db);
    const done = await settled(ctx, row, current, { ...ask, leased: true });
    if (done !== null) return done;
    // `settled` returned null, so `current` is this grant, still connected.
    return await renew(ctx, db, current ?? row, key, ask);
  } finally {
    await releaseSettingsLock(db, REFRESH_LOCK_KEY, owner);
  }
}

/** One refresh request that gives up after {@link REFRESH_TIMEOUT_MS}. */
function timed(fetchImpl: FetchLike): FetchLike {
  return (input, init) =>
    fetchImpl(input, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });
}

/** A 2xx from the token endpoint whose body was not a usable token response. */
function brokenSuccess(error: CloudflareOAuthError): boolean {
  return (
    error.code === OAUTH_INVALID_RESPONSE &&
    error.status !== null &&
    error.status >= 200 &&
    error.status < 300
  );
}

/**
 * Refreshes `refreshToken`, trying twice more after a temporary failure
 * (no answer, 5xx, 429, a gateway page). A success whose body could not be
 * read may have rotated the token already, so that is tried once more only.
 * Throws the last `CloudflareOAuthError`.
 */
export async function refreshWithRetries(
  args: { clientId: string; refreshToken: string },
  deps: { fetch: FetchLike; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<RefreshedTokens> {
  let broken = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await refreshGrant({ ...args, fetch: timed(deps.fetch), now: deps.now });
    } catch (error) {
      const delay = REFRESH_RETRY_DELAYS_MS[attempt];
      if (!(error instanceof CloudflareOAuthError) || !error.retryable || delay === undefined) {
        throw error;
      }
      if (brokenSuccess(error) && ++broken > 1) throw error;
      await deps.sleep(delay);
    }
  }
}

/**
 * Refreshes the grant (holding the lease) and stores the result before the
 * lease is let go. Every write is conditional on the refresh token D1 holds
 * (`row.refreshToken`, sealed): see grant-store.server.ts. When this isolate
 * holds a renewal D1 would not store, its refresh token is the newest (the
 * one in D1 was already used), so that is the one sent; the result is
 * stored over what D1 holds, or kept in its place.
 */
async function renew(
  ctx: Ctx,
  db: D1Database,
  row: GrantRow,
  key: CryptoKey,
  ask: Ask,
): Promise<Resolved> {
  const pending = pendingFor(ctx, row);
  let refreshToken: string;
  try {
    refreshToken = await openValue(
      key,
      pending === null ? row.refreshToken : pending.renewal.refreshToken,
      sealContext(row.id, "refresh"),
    );
  } catch {
    throw new CloudflareConnectionError("key_lost", CONNECTION_MESSAGES.keyLost);
  }
  const dropPending = () => {
    if (pending !== null && ctx.memo.pending === pending) ctx.memo.pending = null;
  };
  let tokens: RefreshedTokens;
  try {
    tokens = await refreshWithRetries({ clientId: row.clientId, refreshToken }, ctx);
  } catch (error) {
    if (!(error instanceof CloudflareOAuthError)) throw error;
    if (error.reconnectNeeded) {
      if (
        await markNeedsReconnect(db, row.id, row.refreshToken, GRANT_PROBLEMS.revoked, ctx.now())
      ) {
        if (ctx.memo.access?.grantId === row.id) ctx.memo.access = null;
        dropPending();
        console.error("cloudflare connection: the grant was refused; it needs reconnecting");
        throw reconnectError();
      }
      // Another request stored a rotation meanwhile: the token refused was
      // already replaced, and the grant is fine. Use what it stored (this
      // request holds the lease, so it never waits for it here).
      const done = await settled(ctx, row, await readGrant(db), { ...ask, leased: true });
      if (done !== null) return done;
      throw temporaryError();
    }
    if (error.retryable) {
      await recordProblem(db, row.id, GRANT_PROBLEMS.unreachable, ctx.now());
      console.warn("cloudflare connection: renewing access failed for now", { code: error.code });
      throw temporaryError();
    }
    await recordProblem(db, row.id, GRANT_PROBLEMS.refused(error.code), ctx.now());
    console.error("cloudflare connection: renewing access was refused", { code: error.code });
    throw new CloudflareConnectionError("refused", CONNECTION_MESSAGES.refused(error.code));
  }
  const renewal: GrantRenewal = {
    refreshToken: await sealValue(key, tokens.refreshToken, sealContext(row.id, "refresh")),
    accessToken: await sealValue(key, tokens.accessToken, sealContext(row.id, "access")),
    accessExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    at: ctx.now(),
  };
  ctx.memo.access = { grantId: row.id, token: tokens.accessToken, expiresAt: tokens.expiresAt };
  // The refresh token that was sent may no longer work: the new one must be
  // stored before anything else, so the write gets a second chance, and
  // after that this isolate keeps it to store before it refreshes again.
  let stored: boolean;
  try {
    stored = await saveRenewal(db, row.id, row.refreshToken, renewal);
  } catch {
    try {
      stored = await saveRenewal(db, row.id, row.refreshToken, renewal);
    } catch {
      // In place of any older one: this renewal's refresh token is the newest.
      ctx.memo.pending = { grantId: row.id, sent: row.refreshToken, renewal };
      console.error("cloudflare connection: could not store the renewed access; kept to retry");
      throw temporaryError();
    }
  }
  dropPending();
  if (!stored) {
    // Replaced, removed, or renewed by a request whose lease outlived ours:
    // the access token still serves this call.
    console.warn("cloudflare connection: the grant changed while it was renewed");
  }
  return { token: tokens.accessToken, grantId: row.id };
}

/** A credential source for the Cloudflare API client. */
export interface CloudflareConnection {
  /** For `createClient({ token })`: called before every request. */
  token: () => Promise<string>;
  /**
   * `inner`, except that a request the API refuses with 401 while carrying
   * this connection's OAuth access token (a grant withdrawn in the
   * dashboard, say) is sent once more with a renewed one. A grant
   * Cloudflare no longer accepts then ends in the reconnect error; nothing
   * loops. Requests with another token (an upload session's) pass through.
   */
  retrying(inner: FetchLike): FetchLike;
}

/**
 * The connection for one client: answers from this isolate's memo whenever
 * it can. `known.grant` is the stored grant (or null) when the caller has
 * just read it, which saves the first read.
 */
export function cloudflareConnection(
  env: ConnectionEnv,
  deps: ConnectionDeps = {},
  known?: { grant: GrantRow | null },
): CloudflareConnection {
  const ctx = context(env, deps);
  /** Undefined until the first call; null for the API token. */
  let grantId: string | null | undefined =
    known === undefined ? undefined : (known.grant?.id ?? null);
  let first: GrantRow | null | undefined = known?.grant;
  /** The last OAuth access token handed out. */
  let lastOAuth: string | null = null;

  async function resolve(ask: Ask): Promise<string> {
    if (ctx.memo.pending !== null) await flushPending(ctx);
    if (grantId === null) return apiToken(ctx);
    if (grantId !== undefined) {
      const hit = memoHit(ctx, grantId, ask);
      if (hit !== null) {
        lastOAuth = hit;
        return hit;
      }
    }
    const row = first !== undefined ? first : await grantOf(ctx);
    first = undefined;
    if (row === null) {
      grantId = null;
      return apiToken(ctx);
    }
    const resolved = await resolveGrant(ctx, row, ask);
    grantId = resolved.grantId;
    lastOAuth = resolved.grantId === null ? null : resolved.token;
    return resolved.token;
  }

  return {
    token: () => resolve(PLAIN),
    retrying(inner) {
      return async (input, init) => {
        const response = await inner(input, init);
        const refused = lastOAuth;
        if (response.status !== 401 || refused === null || typeof grantId !== "string") {
          return response;
        }
        if (new Headers(init?.headers).get("Authorization") !== `Bearer ${refused}`) {
          return response;
        }
        const last = ctx.memo.rejected;
        if (
          last !== null &&
          last.grantId === grantId &&
          ctx.now() - last.at < REJECTION_RENEWAL_GAP_MS
        ) {
          return response;
        }
        ctx.memo.rejected = { grantId, token: refused, at: ctx.now() };
        if (ctx.memo.access?.token === refused) ctx.memo.access = null;
        await response.body?.cancel();
        // The cached token is refused: read the grant again and renew.
        first = undefined;
        grantId = undefined;
        const token = await resolve({ ...PLAIN, reject: refused });
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return inner(input, { ...init, headers });
      };
    },
  };
}

/** {@link cloudflareConnection}'s token alone, for a client that needs no 401 handling. */
export function cloudflareCredential(
  env: ConnectionEnv,
  deps: ConnectionDeps = {},
  known?: { grant: GrantRow | null },
): () => Promise<string> {
  return cloudflareConnection(env, deps, known).token;
}

/**
 * Why the connection cannot be used now, without calling Cloudflare; null
 * when it can (an access token may still have to be renewed). Jobs check it
 * before they start work, and the scheduled updates before they start jobs.
 */
export async function connectionProblem(
  env: ConnectionEnv,
  deps: ConnectionDeps = {},
): Promise<CloudflareConnectionError | null> {
  const ctx = context(env, deps);
  const row = await grantOf(ctx);
  if (row === null) return env.CF_API_TOKEN ? null : noApiToken(ctx);
  if (row.status === "needs_reconnect") return reconnectError();
  return (await heldKey(ctx, row.keyId)) === null ? unreadableKey(ctx, row) : null;
}

/**
 * For refusing to start a job up front: whether a connection is configured
 * at all (`hasToken`, the name the self-update has always used), and when it
 * is, why it cannot be used now, in the words to show.
 */
export async function connectionReadiness(
  env: ConnectionEnv,
): Promise<{ hasToken: boolean; connectionProblem: string | null }> {
  const problem = await connectionProblem(env);
  if (problem === null) return { hasToken: true, connectionProblem: null };
  if (problem.problem === "not_configured") return { hasToken: false, connectionProblem: null };
  return { hasToken: true, connectionProblem: problem.message };
}

/**
 * Whether only an administrator reconnecting Cloudflare brings the
 * connection back, for Home's "Needs attention". One D1 read; an API token
 * connection never does (Cloudflare does not say when a token is revoked
 * until it is used).
 */
export async function connectionNeedsReconnecting(env: ConnectionEnv): Promise<boolean> {
  const problem = await connectionProblem(env);
  return problem !== null && needsReconnecting(problem.problem);
}

/** Throws what {@link connectionProblem} finds. */
export async function requireConnection(
  env: ConnectionEnv,
  deps: ConnectionDeps = {},
): Promise<void> {
  const problem = await connectionProblem(env, deps);
  if (problem !== null) throw problem;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/** The connection as Settings and Home show it. No Cloudflare call. */
export async function readConnectionState(
  env: ConnectionEnv & { DB: D1Database },
  deps: ConnectionDeps = {},
): Promise<ConnectionView> {
  const ctx = context(env, deps);
  const row = await grantOf(ctx);
  if (row === null) {
    const { cf_token_verified_at: verifiedAt } = await readSettings(createDb(env.DB), [
      SETTING.cfTokenVerifiedAt,
    ]);
    return {
      kind: "api_token",
      state: "connected",
      problem: null,
      problemAt: null,
      connectedSince: verifiedAt || null,
      ready: typeof env.CF_API_TOKEN === "string" && env.CF_API_TOKEN.length > 0,
      oauth: null,
    };
  }
  let state: ConnectionView["state"] = row.status;
  let problem = row.problem;
  let problemAt = iso(row.problemAt);
  let ready = row.status === "connected";
  if (ready && (await heldKey(ctx, row.keyId)) === null) {
    ready = false;
    if (needsReconnecting((await unreadableKey(ctx, row)).problem)) {
      state = "needs_reconnect";
      problem = GRANT_PROBLEMS.keyLost;
      problemAt = null;
    }
  }
  return {
    kind: "oauth",
    state,
    problem,
    problemAt,
    connectedSince: iso(row.connectedAt),
    ready,
    oauth: {
      clientId: row.clientId,
      scopes: row.scopes,
      missingScopes: missingManagerScopes(row.scopes),
      renewedAt: new Date(row.refreshedAt).toISOString(),
    },
  };
}

/** The refresh token of a grant about to be thrown away, to revoke it. */
export interface HeldGrant {
  clientId: string;
  refreshToken: string;
}

/** Opens the stored grant's refresh token; null when there is no grant or it cannot be read. */
export async function openStoredGrant(
  env: ConnectionEnv,
  deps: ConnectionDeps = {},
  row?: GrantRow | null,
): Promise<HeldGrant | null> {
  const ctx = context(env, deps);
  const grant = row === undefined ? await grantOf(ctx) : row;
  if (grant === null) return null;
  const key = await heldKey(ctx, grant.keyId);
  if (key === null) return null;
  // A renewal this isolate could not store holds the newest refresh token.
  const pending = pendingFor(ctx, grant);
  const sealed = pending === null ? grant.refreshToken : pending.renewal.refreshToken;
  try {
    return {
      clientId: grant.clientId,
      refreshToken: await openValue(key, sealed, sealContext(grant.id, "refresh")),
    };
  } catch {
    return null;
  }
}

/**
 * Revokes a grant at Cloudflare (which ends it), best effort: a failure is
 * logged, never thrown. True when Cloudflare confirmed.
 */
export async function revokeGrant(held: HeldGrant, deps: ConnectionDeps = {}): Promise<boolean> {
  try {
    await revokeToken({
      clientId: held.clientId,
      token: held.refreshToken,
      tokenTypeHint: "refresh_token",
      fetch: timed(deps.fetch ?? ((input, init) => fetch(input, init))),
    });
    return true;
  } catch (error) {
    console.error("cloudflare connection: could not revoke the previous authorization", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Before "Remove Appflare from this account" deletes the database: makes
 * sure this isolate's access token lasts `minValidityMs` (refreshing now if
 * not), since nothing can be refreshed once the database is gone, and
 * returns the grant to revoke at the end. Null for an API token, or when the
 * grant cannot be read; a failed refresh is logged and leaves the removal to
 * report what its calls then say.
 */
export async function holdGrantForRemoval(
  env: ConnectionEnv,
  minValidityMs: number,
  deps: ConnectionDeps = {},
): Promise<HeldGrant | null> {
  const ctx = context(env, deps);
  const row = await grantOf(ctx);
  if (row === null) return null;
  try {
    await resolveGrant(ctx, row, { ...PLAIN, minValidityMs });
  } catch (error) {
    console.error("removal: could not renew Cloudflare access first", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return openStoredGrant(env, deps);
}
