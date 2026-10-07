import { type CloudflareClient, createClient } from "@appflare/cf-api";
import { constantTimeEquals } from "../auth/constant-time";
import { cloudflareCredential } from "../cloudflare/connection.server";
import { type StoredGrant, type StoreGrantDeps, storeGrant } from "../cloudflare/grant.server";
import { readGrant } from "../cloudflare/grant-store.server";
import { AUTH_SECRET_NAME, generateAuthSecret } from "../danger/auth-secret.server";
import { createDb } from "../db/client";
import {
  deleteSettings,
  isCfTokenConfigured,
  readSettings,
  SETTING,
  writeSettings,
} from "../db/settings";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";
import { forgetHandedGrant } from "../handoff/handoff-state.server";
import { type AttemptLimit, DEFAULT_ATTEMPT_LIMIT, takeAttempt } from "./attempt-limit.server";
import { ensureSelfBinding, type SelfBindingOutcome } from "./self-binding.server";
import { type SaveTokenResult, saveTokenStep, type TokenFlowDeps } from "./token.server";
import { hasAnyUser, makeFirstUserOwner } from "./users.server";

/**
 * First-run setup, before any user exists. Framework-free;
 * `setup.functions.ts` and the handoff (../handoff/) bind it to the request.
 *
 * 1. Connect Cloudflare, one of two ways:
 *    - Anyone may paste an API token. It is accepted only when it verifies
 *      for the account this Worker runs in (the running version is looked
 *      up in the token's account) and can manage Workers. Whoever holds such
 *      a token already controls the account, so the first visitor to get
 *      this far may finish setup. The token is stored as `CF_API_TOKEN` and
 *      the browser receives a setup claim: a random value in an HttpOnly
 *      cookie whose SHA-256 is kept in `settings` for 30 minutes.
 *    - A manager installed from the browser receives a Cloudflare
 *      authorization (an OAuth grant) from the page that installed it,
 *      which proves itself with the handoff secret. The grant gets the same
 *      account check and is stored as the connection
 *      (cloudflare/grant.server.ts). That page receives an owner claim: a
 *      one-time code, kept only as its SHA-256 for 30 minutes, which
 *      `/setup` exchanges for the setup claim cookie.
 *    Either way, a manager deployed without secrets or without its `SELF`
 *    binding (the "Deploy to Cloudflare" button, the browser installer) also
 *    gets a random `BETTER_AUTH_SECRET` and `SELF` here, with the same
 *    credential. Both ways run {@link connectStep}: one lock, one check of
 *    other browsers' claims, the same writes.
 * 2. Create the owner: only with a setup claim that matches and has not
 *    expired, only while no user exists, and only on a version that has the
 *    auth secret (Better Auth never starts without one). Every other browser
 *    keeps seeing step 1; once the owner exists, everyone is sent to sign in.
 *
 * Connecting with a token verifies and saves in one call, rate limited per
 * client address (20 tries in 10 minutes), so the page is not a free oracle
 * for testing tokens. There is no separate verify call. Every refusal
 * carries a fixed message.
 */

export const SETUP_CLAIM_COOKIE = "appflare_setup_claim";
export const SETUP_CLAIM_TTL_MS = 30 * 60_000;
/** The owner claim lasts as long as the setup claim it is exchanged for. */
export const OWNER_CLAIM_TTL_MS = SETUP_CLAIM_TTL_MS;

/** Connect calls per client address: each one is one try of a token. */
export const SETUP_RATE_LIMIT: AttemptLimit = DEFAULT_ATTEMPT_LIMIT;

/**
 * `settings` row of the owner claim: JSON `{ hash, expiresAt }`, like the
 * setup claim's. Deleted when it is exchanged, replaced when another is
 * issued.
 */
const OWNER_CLAIM_KEY = "setup_owner_claim";

/**
 * Serializes "check the claim, save the credential, issue a claim" across
 * browsers. It spans up to a dozen Cloudflare calls, two of which deploy a
 * version, so its lease is long enough that a slow save is never overtaken.
 */
const CONNECT_LOCK_KEY = "setup_connect_lock";
const CONNECT_LOCK_TTL_MS = 5 * 60_000;
/** Serializes concurrent owner creation. */
const OWNER_LOCK_KEY = "setup_first_admin_lock";
const LOCK_TTL_MS = 60_000;

export const SETUP_MESSAGES = {
  alreadyDone: "Setup is already complete. Sign in instead.",
  rateLimited: "Too many attempts from this network. Wait ten minutes, then try again.",
  inProgress: (minutes: number) =>
    `Setup is being finished in another browser. Continue there, or paste the token here again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
  connectFirst:
    "This browser has not connected Cloudflare, or it did so more than 30 minutes ago. Paste the API token again.",
  busy: "Setup is already in progress. Try again in a minute.",
  redeploying:
    "Appflare is still redeploying itself with its new secrets. Try again in a few seconds.",
} as const;

/** A refused setup call; its message is shown as is. */
export class SetupError extends Error {
  override name = "SetupError";
  constructor(
    message: string,
    /** Which refusal, for callers that answer with a status code. */
    readonly reason: "done" | "rate-limited" | "busy" | "in-progress" | "refused" = "refused",
    /** For `in-progress`: minutes until the other browser's claim runs out. */
    readonly minutes: number | null = null,
  ) {
    super(message);
  }
}

interface StoredClaim {
  hash: string;
  /** Epoch ms. */
  expiresAt: number;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, base64url (43 characters). */
function randomValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseClaim(value: string | undefined): StoredClaim | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredClaim>;
    if (typeof parsed.hash !== "string" || typeof parsed.expiresAt !== "number") return null;
    return { hash: parsed.hash, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

async function readClaim(d1: D1Database): Promise<StoredClaim | null> {
  const row = await readSettings(createDb(d1), [SETTING.setupClaim]);
  return parseClaim(row.setup_claim);
}

/** The owner claim's row as stored (its text, for a delete that only it may win), and parsed. */
async function readOwnerClaim(
  d1: D1Database,
): Promise<{ text: string; claim: StoredClaim | null } | null> {
  const row = await d1
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(OWNER_CLAIM_KEY)
    .first<{ value: string }>();
  return row === null ? null : { text: row.value, claim: parseClaim(row.value) };
}

function upsertSetting(d1: D1Database, key: string, value: string, now: Date) {
  return d1
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now.getTime());
}

/** Issues a new claim, replacing any other. Returns the cookie value (never stored). */
export async function issueSetupClaim(
  d1: D1Database,
  now: Date,
): Promise<{ value: string; expiresAt: Date }> {
  const value = randomValue();
  const expiresAt = new Date(now.getTime() + SETUP_CLAIM_TTL_MS);
  const claim: StoredClaim = { hash: await sha256Hex(value), expiresAt: expiresAt.getTime() };
  await writeSettings(createDb(d1), { [SETTING.setupClaim]: JSON.stringify(claim) }, now);
  return { value, expiresAt };
}

/** Whether `cookie` is the current claim and it has not expired. */
export async function setupClaimMatches(
  d1: D1Database,
  cookie: string | undefined,
  now: Date,
): Promise<boolean> {
  if (!cookie) return false;
  const claim = await readClaim(d1);
  if (claim === null || claim.expiresAt <= now.getTime()) return false;
  return constantTimeEquals(await sha256Hex(cookie), claim.hash);
}

/**
 * The statement that issues a new owner claim, replacing any other, and the
 * code (never stored) for the page that installed this manager. Returned as
 * a statement so the caller writes it with the rest of its batch.
 */
export async function ownerClaimStatement(
  d1: D1Database,
  now: Date,
): Promise<{ code: string; expiresAt: Date; statement: D1PreparedStatement }> {
  const code = randomValue();
  const expiresAt = new Date(now.getTime() + OWNER_CLAIM_TTL_MS);
  const claim: StoredClaim = { hash: await sha256Hex(code), expiresAt: expiresAt.getTime() };
  return {
    code,
    expiresAt,
    statement: upsertSetting(d1, OWNER_CLAIM_KEY, JSON.stringify(claim), now),
  };
}

/**
 * Exchanges an owner claim for the setup claim: once, before it expires,
 * and only while no user exists. The claim is deleted first, by a delete
 * only one caller can win, so two pages presenting the same code never both
 * get a setup claim. Null when the code is refused (the reason is not told).
 */
export async function redeemOwnerClaim(
  d1: D1Database,
  code: string,
  now: Date,
): Promise<{ value: string; expiresAt: Date } | null> {
  if (await hasAnyUser(createDb(d1))) return null;
  const stored = await readOwnerClaim(d1);
  if (stored === null || stored.claim === null) return null;
  if (stored.claim.expiresAt <= now.getTime()) return null;
  if (!(await constantTimeEquals(await sha256Hex(code), stored.claim.hash))) return null;
  const taken = await d1
    .prepare("DELETE FROM settings WHERE key = ?1 AND value = ?2")
    .bind(OWNER_CLAIM_KEY, stored.text)
    .run();
  if (taken.meta.changes !== 1) return null;
  return issueSetupClaim(d1, now);
}

/**
 * Minutes until a claim held elsewhere runs out, or null when there is none:
 * another browser's unexpired setup claim, or an owner claim not exchanged
 * yet (the page that installed this manager is about to come back with it).
 */
async function claimHeldElsewhere(
  d1: D1Database,
  cookie: string | undefined,
  now: Date,
): Promise<number | null> {
  const minutesLeft = (claim: StoredClaim) =>
    Math.max(1, Math.ceil((claim.expiresAt - now.getTime()) / 60_000));
  const held: number[] = [];
  const claim = await readClaim(d1);
  if (claim !== null && claim.expiresAt > now.getTime()) {
    if (!(await setupClaimMatches(d1, cookie, now))) held.push(minutesLeft(claim));
  }
  const owner = (await readOwnerClaim(d1))?.claim ?? null;
  if (owner !== null && owner.expiresAt > now.getTime()) held.push(minutesLeft(owner));
  return held.length === 0 ? null : Math.max(...held);
}

/**
 * Counts one attempt for `client` at the token step, through the attempt
 * limit every door before sign-in shares (attempt-limit.server.ts), under
 * the token step's own key. False once the window's attempts are used up.
 */
export function takeSetupAttempt(
  d1: D1Database,
  client: string,
  now: Date,
  limit: AttemptLimit = SETUP_RATE_LIMIT,
): Promise<boolean> {
  return takeAttempt(d1, "setup-token", client, now, limit);
}

/**
 * Writes a random `BETTER_AUTH_SECRET` on a Worker that runs without one.
 * Only the one API call sees the value: never logged, stored or returned.
 */
async function ensureAuthSecret(deps: {
  api: Pick<CloudflareClient, "workers">;
  workerName: string;
  bound: boolean;
  generate?: () => string;
}): Promise<void> {
  if (deps.bound) return;
  await deps.api.workers.putSecret(deps.workerName, {
    name: AUTH_SECRET_NAME,
    type: "secret_text",
    text: (deps.generate ?? generateAuthSecret)(),
  });
}

/** What both ways of connecting Cloudflare share. */
export interface ConnectStepDeps {
  db: D1Database;
  /**
   * Who is asking, for the rate limit: the client address
   * (`cf-connecting-ip`). Null when the caller counted the attempt itself.
   */
  client: string | null;
  now: Date;
  /** This browser's setup claim cookie, if any. */
  claimCookie: string | undefined;
  /** The running Worker has `BETTER_AUTH_SECRET`; without it, one is generated and stored. */
  authSecretBound: boolean;
  /** The running Worker has the `SELF` service binding; without it, it is added. */
  selfBound: boolean;
  /** Test seam for the generated auth secret. */
  generateAuthSecret?: () => string;
}

/** What storing a credential found out, with a client that uses it. */
interface SavedCredential {
  accountId: string;
  workerName: string;
  api: CloudflareClient;
}

interface ConnectSteps<S extends SavedCredential, R> {
  /** Runs holding the lock, before anything is stored. */
  before?: () => Promise<void>;
  /** Verifies the credential for the account this Worker runs in, and stores it. */
  save: () => Promise<S>;
  /** Runs holding the lock, after setup's writes: issues the claim. */
  finish: (saved: S) => Promise<R>;
}

/**
 * Step 1, either way: refused once a user exists and (with `client`) past
 * the rate limit; then, holding the connect lock and while no other browser
 * holds a claim, stores the credential, writes the auth secret and adds
 * `SELF` when the running Worker lacks them, and issues the claim.
 */
async function connectStep<S extends SavedCredential, R>(
  deps: ConnectStepDeps,
  steps: ConnectSteps<S, R>,
): Promise<{ saved: S; selfBinding: SelfBindingOutcome; finished: R }> {
  if (await hasAnyUser(createDb(deps.db))) {
    throw new SetupError(SETUP_MESSAGES.alreadyDone, "done");
  }
  if (deps.client !== null && !(await takeSetupAttempt(deps.db, deps.client, deps.now))) {
    throw new SetupError(SETUP_MESSAGES.rateLimited, "rate-limited");
  }
  const owner = crypto.randomUUID();
  if (!(await tryAcquireSettingsLock(deps.db, CONNECT_LOCK_KEY, owner, CONNECT_LOCK_TTL_MS))) {
    throw new SetupError(SETUP_MESSAGES.busy, "busy");
  }
  try {
    await steps.before?.();
    const minutes = await claimHeldElsewhere(deps.db, deps.claimCookie, deps.now);
    if (minutes !== null) {
      throw new SetupError(SETUP_MESSAGES.inProgress(minutes), "in-progress", minutes);
    }
    const saved = await steps.save();
    await ensureAuthSecret({
      api: saved.api,
      workerName: saved.workerName,
      bound: deps.authSecretBound,
      ...(deps.generateAuthSecret ? { generate: deps.generateAuthSecret } : {}),
    });
    // After the secrets: their writes deploy new versions, and the patch
    // builds on the latest one.
    const selfBinding = await ensureSelfBinding({
      api: saved.api,
      workerName: saved.workerName,
      bound: deps.selfBound,
    });
    return { saved, selfBinding, finished: await steps.finish(saved) };
  } finally {
    await releaseSettingsLock(deps.db, CONNECT_LOCK_KEY, owner);
  }
}

export interface SetupDeps {
  /** The token flow's dependencies (database, pasted token, host, running version). */
  token: TokenFlowDeps;
  /** Who is asking, for the rate limit: the client address (`cf-connecting-ip`). */
  client: string;
  now: Date;
}

export interface ConnectResult extends SaveTokenResult {
  claim: { value: string; expiresAt: Date };
  selfBinding: SelfBindingOutcome;
}

export interface ConnectDeps extends SetupDeps {
  claimCookie: string | undefined;
  /** The `CF_API_TOKEN` the running Worker holds, if any. */
  currentToken: string | undefined;
  /** The running Worker has `BETTER_AUTH_SECRET`; without it, one is generated and stored. */
  authSecretBound: boolean;
  /** The running Worker has the `SELF` service binding; without it, it is added. */
  selfBound: boolean;
  /** Test seam for the generated auth secret. */
  generateAuthSecret?: () => string;
}

/**
 * Step 1 with a pasted API token, "Continue": verifies the token for the
 * account this Worker runs in, stores it, and issues this browser's claim,
 * in one call. Refused while another browser holds an unexpired claim. When
 * a token is already stored (the browser that stored it went away) the
 * pasted one is verified again and replaces it only if it differs.
 */
export async function connectCloudflareStep(deps: ConnectDeps): Promise<ConnectResult> {
  const t = deps.token;
  const { saved, selfBinding, finished } = await connectStep(
    {
      db: t.db,
      client: deps.client,
      now: deps.now,
      claimCookie: deps.claimCookie,
      authSecretBound: deps.authSecretBound,
      selfBound: deps.selfBound,
      ...(deps.generateAuthSecret ? { generateAuthSecret: deps.generateAuthSecret } : {}),
    },
    {
      save: async () => {
        const result = await saveTokenStep(t, { beforeOwner: { currentToken: deps.currentToken } });
        const api = createClient({
          accountId: result.accountId,
          token: t.token,
          fetch: t.fetch,
          onRequest: t.onRequest,
          baseUrl: t.baseUrl,
        });
        return { ...result, api };
      },
      finish: async () => {
        // The pasted token is the connection now: an authorization the
        // browser installer handed over and a failed try kept is not needed.
        await forgetHandedGrant(t.db);
        return issueSetupClaim(t.db, deps.now);
      },
    },
  );
  const { api: _api, ...result } = saved;
  return { ...result, claim: finished, selfBinding };
}

export interface GrantConnectDeps extends ConnectStepDeps {
  /**
   * What `storeGrant` needs besides the database: the grant handed over,
   * the account it must manage, the request host, the running version.
   */
  grant: Omit<StoreGrantDeps, "db">;
  /** How the grant is stored; `storeGrant` unless the caller wraps it. */
  store?: (deps: StoreGrantDeps) => Promise<StoredGrant>;
}

export interface GrantConnection {
  accountId: string;
  accountName: string | null;
  workerName: string;
  /** A client that uses the stored grant. */
  api: CloudflareClient;
  /**
   * An earlier try stored the grant and failed after it (a Cloudflare call
   * of setup's own writes); this one used the stored grant, since the one
   * handed over again was spent by the first refresh.
   */
  resumed: boolean;
}

/**
 * Before the owner exists, a stored grant can only come from an earlier try
 * of {@link connectGrantStep}: an OAuth reconnect needs a signed-in admin.
 * It is used again when it is for the same account and works.
 */
async function grantToResume(
  deps: GrantConnectDeps,
): Promise<{ accountName: string | null; workerName: string } | null> {
  const row = await readGrant(deps.db);
  if (row === null || row.status !== "connected") return null;
  const s = await readSettings(createDb(deps.db), [
    SETTING.accountId,
    SETTING.accountName,
    SETTING.workerName,
  ]);
  if (s.account_id !== deps.grant.accountId || !s.worker_name) return null;
  return { accountName: s.account_name || null, workerName: s.worker_name };
}

/**
 * Step 1 with a Cloudflare authorization handed over by the page that
 * installed this manager: the same step as a pasted token, with the grant
 * stored as the connection (`storeGrant`: refreshed at once, checked
 * against the account and the running version, sealed). `finish` issues the
 * claim; `before` runs first, holding the lock.
 */
export async function connectGrantStep<R>(
  deps: GrantConnectDeps,
  steps: Omit<ConnectSteps<GrantConnection, R>, "save">,
): Promise<{ connection: GrantConnection; selfBinding: SelfBindingOutcome; finished: R }> {
  const g = deps.grant;
  const clientFor = (accountId: string) =>
    createClient({
      accountId,
      token: cloudflareCredential(
        { DB: deps.db, ...(g.grantKey === undefined ? {} : { CF_GRANT_KEY: g.grantKey }) },
        {
          ...(g.fetch === undefined ? {} : { fetch: g.fetch }),
          ...(g.now === undefined ? {} : { now: g.now }),
          ...(g.sleep === undefined ? {} : { sleep: g.sleep }),
          ...(g.memo === undefined ? {} : { memo: g.memo }),
        },
      ),
      fetch: g.fetch,
      onRequest: g.onRequest,
      baseUrl: g.baseUrl,
    });
  const { saved, selfBinding, finished } = await connectStep(deps, {
    ...steps,
    save: async (): Promise<GrantConnection> => {
      const earlier = await grantToResume(deps);
      if (earlier !== null) {
        return { accountId: g.accountId, ...earlier, api: clientFor(g.accountId), resumed: true };
      }
      const stored = await (deps.store ?? storeGrant)({ db: deps.db, ...g });
      return {
        accountId: stored.accountId,
        accountName: stored.accountName,
        workerName: stored.workerName,
        api: clientFor(stored.accountId),
        resumed: false,
      };
    },
  });
  return { connection: saved, selfBinding, finished };
}

export interface OwnerInput {
  email: string;
  name: string;
  password: string;
}

/**
 * Step 2: creates the owner with `createUser` (Better Auth's admin
 * `createUser`, role admin) and marks them the owner, then retires the claims.
 */
export async function createOwnerStep(deps: {
  d1: D1Database;
  claimCookie: string | undefined;
  now: Date;
  /**
   * The request runs on a version that has `BETTER_AUTH_SECRET`. Until the
   * version that connecting Cloudflare deployed is live, Better Auth cannot
   * start, so no user may be created.
   */
  authReady: boolean;
  input: OwnerInput;
  createUser: (input: OwnerInput) => Promise<{ id: string }>;
}): Promise<{ userId: string }> {
  const db = createDb(deps.d1);
  if (await hasAnyUser(db)) throw new SetupError(SETUP_MESSAGES.alreadyDone, "done");
  const claimed =
    (await isCfTokenConfigured(db)) &&
    (await setupClaimMatches(deps.d1, deps.claimCookie, deps.now));
  if (!claimed) throw new SetupError(SETUP_MESSAGES.connectFirst);
  if (!deps.authReady) throw new SetupError(SETUP_MESSAGES.redeploying);
  const owner = crypto.randomUUID();
  if (!(await tryAcquireSettingsLock(deps.d1, OWNER_LOCK_KEY, owner, LOCK_TTL_MS))) {
    throw new SetupError(SETUP_MESSAGES.busy, "busy");
  }
  try {
    if (await hasAnyUser(db)) throw new SetupError(SETUP_MESSAGES.alreadyDone, "done");
    const user = await deps.createUser(deps.input);
    await makeFirstUserOwner(db, user.id);
    await deleteSettings(db, [SETTING.setupClaim]);
    await deps.d1.prepare("DELETE FROM settings WHERE key = ?1").bind(OWNER_CLAIM_KEY).run();
    // A handoff left unfinished keeps no authorization once setup is done.
    await forgetHandedGrant(deps.d1);
    return { userId: user.id };
  } finally {
    await releaseSettingsLock(deps.d1, OWNER_LOCK_KEY, owner);
  }
}
