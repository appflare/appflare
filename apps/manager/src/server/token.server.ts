import {
  CloudflareApiError,
  type CloudflareClient,
  createClient,
  type FetchLike,
  type RequestLog,
} from "@appflare/cf-api";
import { constantTimeEquals } from "../auth/constant-time";
import { type TokenVerification, verifyCloudflareToken } from "../cloudflare/verify-token";
import { discoverWorkerName } from "../cloudflare/worker-name";
import { AUTH_SECRET_NAME, generateAuthSecret } from "../danger/auth-secret.server";
import { createDb } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";

/**
 * The Cloudflare token step: verify a pasted
 * token, store it on the manager's own Worker as `CF_API_TOKEN`, and record what
 * was discovered in `settings`. Framework-free; the server functions in
 * `token.functions.ts` and `setup.functions.ts` bind it to the request and
 * guard it.
 *
 * Writing a secret deploys a new version of the manager itself. The request that
 * wrote it finishes on the old version (verified live), and nothing after the
 * write depends on the running code: only D1 writes and one more API call.
 */

export const CF_API_TOKEN_SECRET = "CF_API_TOKEN";
export const SETUP_TOKEN_SECRET = "SETUP_TOKEN";

/** Serializes concurrent saves and rotations. */
const TOKEN_LOCK_KEY = "cf_token_lock";
const TOKEN_LOCK_TTL_MS = 60_000;

export interface TokenFlowDeps {
  db: D1Database;
  /** The pasted token. Never logged, returned, or put in an error message. */
  token: string;
  /** The request host (`appflare.<subdomain>.workers.dev` when on workers.dev). */
  host: string;
  /** The Worker version serving this request (`CF_VERSION_METADATA.id`), when bound. */
  runningVersionId?: string | null;
  /**
   * `SETUP_TOKEN` is bound on the running Worker (a manager installed before
   * setup started with the API token). It no longer guards anything; the
   * first save removes it.
   */
  setupTokenBound?: boolean;
  fetch?: FetchLike;
  onRequest?: (log: RequestLog) => void;
  baseUrl?: string;
  now?: () => Date;
}

/** A user-facing failure of the token step. Messages never contain the token. */
export class TokenStepError extends Error {
  override name = "TokenStepError";
}

export const TOKEN_STEP_MESSAGES = {
  alreadyConfigured: "A Cloudflare token is already configured. Rotate it from Settings instead.",
  notConfigured: "No Cloudflare token is configured yet. Finish setup first.",
  busy: "Another token change is in progress. Try again in a minute.",
  needsScripts:
    "This token cannot list Workers scripts, so Appflare cannot store it on itself. Add the Workers Scripts: Edit permission.",
  otherAccountBeforeOwner:
    "Appflare already holds a token for another Cloudflare account. Paste a token for the account Appflare runs in.",
} as const;

/**
 * Verifies without storing. Once an account is recorded (rotation) the token
 * must be valid for it; before that (setup) the account is the one running
 * this Worker.
 */
export async function verifyTokenStep(deps: TokenFlowDeps) {
  const { account_id } = await readSettings(createDb(deps.db), [SETTING.accountId]);
  const { result } = await verifyCloudflareToken({
    ...verifyOptions(deps),
    knownAccountId: account_id ?? null,
  });
  return result;
}

/**
 * Setup's verification, before an owner exists: always matched against the
 * account running this Worker, never against a recorded account, since the
 * first visitor's token decides it.
 */
export async function verifySetupTokenStep(deps: TokenFlowDeps) {
  const { result } = await verifyCloudflareToken({ ...verifyOptions(deps), knownAccountId: null });
  return result;
}

export interface SaveTokenResult {
  ok: true;
  accountId: string;
  workerName: string;
  /** False when `SETUP_TOKEN` could not be deleted (it guards nothing any more). */
  setupTokenRemoved: boolean;
}

export interface SaveTokenOptions {
  /**
   * Before the owner exists, a token that was already stored may be pasted
   * again (the browser that stored it went away): it is re-verified against
   * the running account and rewritten only when it differs from
   * `currentToken`, the one the running Worker holds. Without this a stored
   * token refuses the save.
   */
  beforeOwner?: {
    currentToken: string | undefined;
    /**
     * The running Worker has `BETTER_AUTH_SECRET`. A manager deployed without
     * secrets (the "Deploy to Cloudflare" button) has none, so the first save
     * also writes a random one with the pasted token, before the owner can
     * be created.
     */
    authSecretBound?: boolean;
    /** Test seam for the generated auth secret. */
    generateAuthSecret?: () => string;
  };
}

/** First-time save from `/setup`. Refuses once a token is configured, except before the owner exists. */
export async function saveTokenStep(
  deps: TokenFlowDeps,
  options: SaveTokenOptions = {},
): Promise<SaveTokenResult> {
  return withTokenLock(deps.db, async () => {
    const db = createDb(deps.db);
    const current = await readSettings(db, [SETTING.cfTokenConfigured, SETTING.accountId]);
    const configured = current.cf_token_configured === "1";
    if (configured && options.beforeOwner === undefined) {
      throw new TokenStepError(TOKEN_STEP_MESSAGES.alreadyConfigured);
    }
    const { verified, scripts, workerName: found } = await verifyOrThrow(deps, null);
    if (configured && current.account_id && current.account_id !== verified.accountId) {
      throw new TokenStepError(TOKEN_STEP_MESSAGES.otherAccountBeforeOwner);
    }
    let workerName = found;
    if (workerName === null) {
      const discovery = discoverWorkerName(deps.host, scripts);
      if (!discovery.ok) throw new TokenStepError(discovery.error);
      workerName = discovery.workerName;
    }
    const client = clientFor(deps, verified.accountId);

    const before = options.beforeOwner;
    if (before !== undefined && before.authSecretBound === false) {
      // Only the one API call sees the value: never logged, stored or returned.
      await client.workers.putSecret(workerName, {
        name: AUTH_SECRET_NAME,
        type: "secret_text",
        text: (before.generateAuthSecret ?? generateAuthSecret)(),
      });
    }
    const unchanged =
      configured &&
      (await constantTimeEquals(deps.token, options.beforeOwner?.currentToken ?? null));
    if (!unchanged) {
      await client.workers.putSecret(workerName, {
        name: CF_API_TOKEN_SECRET,
        type: "secret_text",
        text: deps.token,
      });
    }
    const now = (deps.now ?? (() => new Date()))();
    await writeSettings(
      db,
      {
        [SETTING.accountId]: verified.accountId,
        [SETTING.accountName]: verified.accountName ?? "",
        [SETTING.workerName]: workerName,
        [SETTING.cfTokenConfigured]: "1",
        [SETTING.cfTokenVerifiedAt]: now.toISOString(),
      },
      now,
    );
    const setupTokenRemoved =
      deps.setupTokenBound === true ? await deleteSetupToken(client, workerName) : true;
    return { ok: true, accountId: verified.accountId, workerName, setupTokenRemoved };
  });
}

export interface RotateTokenResult {
  ok: true;
  accountId: string;
  workerName: string;
}

/** `/settings` rotation: same account, same Worker, new token. */
export async function rotateTokenStep(deps: TokenFlowDeps): Promise<RotateTokenResult> {
  return withTokenLock(deps.db, async () => {
    const db = createDb(deps.db);
    const current = await readSettings(db, [
      SETTING.cfTokenConfigured,
      SETTING.accountId,
      SETTING.workerName,
    ]);
    if (current.cf_token_configured !== "1" || !current.account_id) {
      throw new TokenStepError(TOKEN_STEP_MESSAGES.notConfigured);
    }
    const { verified, scripts } = await verifyOrThrow(deps, current.account_id);
    let workerName = current.worker_name;
    if (!workerName || !scripts.some((s) => s.id === workerName)) {
      const discovery = discoverWorkerName(deps.host, scripts);
      if (!discovery.ok) throw new TokenStepError(discovery.error);
      workerName = discovery.workerName;
    }

    await clientFor(deps, verified.accountId).workers.putSecret(workerName, {
      name: CF_API_TOKEN_SECRET,
      type: "secret_text",
      text: deps.token,
    });
    const now = (deps.now ?? (() => new Date()))();
    await writeSettings(
      db,
      {
        [SETTING.workerName]: workerName,
        [SETTING.cfTokenVerifiedAt]: now.toISOString(),
        ...(verified.accountName ? { [SETTING.accountName]: verified.accountName } : {}),
      },
      now,
    );
    return { ok: true, accountId: verified.accountId, workerName };
  });
}

function verifyOptions(deps: TokenFlowDeps) {
  return {
    token: deps.token,
    host: deps.host,
    runningVersionId: deps.runningVersionId ?? null,
    fetch: deps.fetch,
    onRequest: deps.onRequest,
    baseUrl: deps.baseUrl,
  };
}

async function verifyOrThrow(deps: TokenFlowDeps, knownAccountId: string | null) {
  const { result, scripts, workerName } = await verifyCloudflareToken({
    ...verifyOptions(deps),
    knownAccountId,
  });
  if (!result.ok) throw new TokenStepError(result.error);
  if (!result.permissionsOk || scripts === null) {
    throw new TokenStepError(TOKEN_STEP_MESSAGES.needsScripts);
  }
  return { verified: result satisfies TokenVerification, scripts, workerName };
}

function clientFor(deps: TokenFlowDeps, accountId: string): CloudflareClient {
  return createClient({
    accountId,
    token: deps.token,
    fetch: deps.fetch,
    onRequest: deps.onRequest,
    baseUrl: deps.baseUrl,
  });
}

/** `SETUP_TOKEN` guards nothing any more. Already gone (404) counts as removed. */
async function deleteSetupToken(client: CloudflareClient, workerName: string): Promise<boolean> {
  try {
    await client.workers.deleteSecret(workerName, SETUP_TOKEN_SECRET);
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return true;
    // The token is stored and settings are written; failing now would strand the
    // wizard. SETUP_TOKEN no longer grants anything.
    console.error("setup: could not delete SETUP_TOKEN", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function withTokenLock<T>(db: D1Database, run: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID();
  if (!(await tryAcquireSettingsLock(db, TOKEN_LOCK_KEY, owner, TOKEN_LOCK_TTL_MS))) {
    throw new TokenStepError(TOKEN_STEP_MESSAGES.busy);
  }
  try {
    return await run();
  } finally {
    await releaseSettingsLock(db, TOKEN_LOCK_KEY, owner);
  }
}
