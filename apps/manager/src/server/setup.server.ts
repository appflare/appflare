import { createClient } from "@appflare/cf-api";
import { constantTimeEquals } from "../auth/constant-time";
import { createDb } from "../db/client";
import {
  deleteSettings,
  isCfTokenConfigured,
  readSettings,
  SETTING,
  writeSettings,
} from "../db/settings";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";
import { ensureSelfBinding, type SelfBindingOutcome } from "./self-binding.server";
import { type SaveTokenResult, saveTokenStep, type TokenFlowDeps } from "./token.server";
import { hasAnyUser, makeFirstUserOwner } from "./users.server";

/**
 * First-run setup, before any user exists. Framework-free;
 * `setup.functions.ts` binds it to the request.
 *
 * 1. Connect Cloudflare: anyone may paste an API token. It is accepted only
 *    when it verifies for the account this Worker runs in (the running
 *    version is looked up in the token's account) and can manage Workers.
 *    Whoever holds such a token already controls the account, so the first
 *    visitor to get this far may finish setup. The token is stored as
 *    `CF_API_TOKEN` and the browser receives a setup claim: a random value
 *    in an HttpOnly cookie whose SHA-256 is kept in `settings` for 30
 *    minutes. A manager deployed without secrets or without its `SELF`
 *    binding (the "Deploy to Cloudflare" button) also gets a random
 *    `BETTER_AUTH_SECRET` and `SELF` here, with the same token.
 * 2. Create the owner: only with a claim that matches and has not expired,
 *    only while no user exists, and only on a version that has the auth
 *    secret (Better Auth never starts without one). Every other browser keeps
 *    seeing step 1; once the owner exists, everyone is sent to sign in.
 *
 * Connecting verifies and saves in one call, rate limited per client address
 * (20 tries in 10 minutes), so the page is not a free oracle for testing
 * tokens. There is no separate verify call. Every refusal carries a fixed
 * message.
 */

export const SETUP_CLAIM_COOKIE = "appflare_setup_claim";
export const SETUP_CLAIM_TTL_MS = 30 * 60_000;

/** Connect calls per client address: each one is one try of a token. */
export const SETUP_RATE_LIMIT = { max: 20, windowMs: 10 * 60_000 } as const;

/**
 * Serializes "check the claim, save the token, issue a claim" across
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

function randomValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readClaim(d1: D1Database): Promise<StoredClaim | null> {
  const row = await readSettings(createDb(d1), [SETTING.setupClaim]);
  if (!row.setup_claim) return null;
  try {
    const parsed = JSON.parse(row.setup_claim) as Partial<StoredClaim>;
    if (typeof parsed.hash !== "string" || typeof parsed.expiresAt !== "number") return null;
    return { hash: parsed.hash, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
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

/** Minutes until another browser's unexpired claim runs out, or null when there is none. */
async function claimHeldElsewhere(
  d1: D1Database,
  cookie: string | undefined,
  now: Date,
): Promise<number | null> {
  const claim = await readClaim(d1);
  if (claim === null || claim.expiresAt <= now.getTime()) return null;
  if (await setupClaimMatches(d1, cookie, now)) return null;
  return Math.max(1, Math.ceil((claim.expiresAt - now.getTime()) / 60_000));
}

/**
 * Counts one attempt for `client` (hashed, so no address is stored) in a
 * fixed window, in Better Auth's `rate_limit` table under a key of Appflare's
 * own. False once the window's attempts are used up.
 */
export async function takeSetupAttempt(
  d1: D1Database,
  client: string,
  now: Date,
  limit: { max: number; windowMs: number } = SETUP_RATE_LIMIT,
): Promise<boolean> {
  const key = `appflare:setup-token:${await sha256Hex(client)}`;
  const t = now.getTime();
  const row = await d1
    .prepare(
      `INSERT INTO rate_limit (id, key, count, last_request) VALUES (?1, ?1, 1, ?2)
       ON CONFLICT(id) DO UPDATE SET
         count = CASE WHEN ?2 - last_request >= ?3 THEN 1 ELSE count + 1 END,
         last_request = CASE WHEN ?2 - last_request >= ?3 THEN ?2 ELSE last_request END
       RETURNING count`,
    )
    .bind(key, t, limit.windowMs)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit.max;
}

export interface SetupDeps {
  /** The token flow's dependencies (database, pasted token, host, running version). */
  token: TokenFlowDeps;
  /** Who is asking, for the rate limit: the client address (`cf-connecting-ip`). */
  client: string;
  now: Date;
}

async function beforeAnyUser(deps: SetupDeps): Promise<void> {
  if (await hasAnyUser(createDb(deps.token.db))) throw new SetupError(SETUP_MESSAGES.alreadyDone);
  if (!(await takeSetupAttempt(deps.token.db, deps.client, deps.now))) {
    throw new SetupError(SETUP_MESSAGES.rateLimited);
  }
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
 * Step 1, "Continue": verifies the token for the account this Worker runs
 * in, stores it, and issues this browser's claim, in one call. Refused while another browser holds an unexpired claim. When a
 * token is already stored (the browser that stored it went away) the pasted
 * one is verified again and replaces it only if it differs. A manager
 * deployed without secrets or without `SELF` (the "Deploy to Cloudflare"
 * button) gets a random `BETTER_AUTH_SECRET` and its `SELF` binding here,
 * with the pasted token.
 */
export async function connectCloudflareStep(deps: ConnectDeps): Promise<ConnectResult> {
  await beforeAnyUser(deps);
  const d1 = deps.token.db;
  const owner = crypto.randomUUID();
  if (!(await tryAcquireSettingsLock(d1, CONNECT_LOCK_KEY, owner, CONNECT_LOCK_TTL_MS))) {
    throw new SetupError(SETUP_MESSAGES.busy);
  }
  try {
    const minutes = await claimHeldElsewhere(d1, deps.claimCookie, deps.now);
    if (minutes !== null) throw new SetupError(SETUP_MESSAGES.inProgress(minutes));
    const saved = await saveTokenStep(deps.token, {
      beforeOwner: {
        currentToken: deps.currentToken,
        authSecretBound: deps.authSecretBound,
        ...(deps.generateAuthSecret ? { generateAuthSecret: deps.generateAuthSecret } : {}),
      },
    });
    // After the secrets: their writes deploy new versions, and the patch
    // builds on the latest one.
    const selfBinding = await ensureSelfBinding({
      api: createClient({
        accountId: saved.accountId,
        token: deps.token.token,
        fetch: deps.token.fetch,
        onRequest: deps.token.onRequest,
        baseUrl: deps.token.baseUrl,
      }),
      workerName: saved.workerName,
      bound: deps.selfBound,
    });
    const claim = await issueSetupClaim(d1, deps.now);
    return { ...saved, claim, selfBinding };
  } finally {
    await releaseSettingsLock(d1, CONNECT_LOCK_KEY, owner);
  }
}

export interface OwnerInput {
  email: string;
  name: string;
  password: string;
}

/**
 * Step 2: creates the owner with `createUser` (Better Auth's admin
 * `createUser`, role admin) and marks them the owner, then retires the claim.
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
  if (await hasAnyUser(db)) throw new SetupError(SETUP_MESSAGES.alreadyDone);
  const claimed =
    (await isCfTokenConfigured(db)) &&
    (await setupClaimMatches(deps.d1, deps.claimCookie, deps.now));
  if (!claimed) throw new SetupError(SETUP_MESSAGES.connectFirst);
  if (!deps.authReady) throw new SetupError(SETUP_MESSAGES.redeploying);
  const owner = crypto.randomUUID();
  if (!(await tryAcquireSettingsLock(deps.d1, OWNER_LOCK_KEY, owner, LOCK_TTL_MS))) {
    throw new SetupError(SETUP_MESSAGES.busy);
  }
  try {
    if (await hasAnyUser(db)) throw new SetupError(SETUP_MESSAGES.alreadyDone);
    const user = await deps.createUser(deps.input);
    await makeFirstUserOwner(db, user.id);
    await deleteSettings(db, [SETTING.setupClaim]);
    return { userId: user.id };
  } finally {
    await releaseSettingsLock(deps.d1, OWNER_LOCK_KEY, owner);
  }
}
