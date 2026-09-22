import {
  CloudflareApiError,
  type CloudflareClient,
  createClient,
  type FetchLike,
  type RequestLog,
} from "@appflare/cf-api";
import { type TokenVerification, verifyCloudflareToken } from "../cloudflare/verify-token";
import { discoverWorkerName } from "../cloudflare/worker-name";
import { createDb } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";

/**
 * The Cloudflare token step: verify a pasted
 * token, store it on the manager's own Worker as `CF_API_TOKEN`, record what was
 * discovered in `settings`, and consume `SETUP_TOKEN`. Framework-free; the server
 * functions in `token.functions.ts` bind it to the request and guard it.
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
} as const;

export async function verifyTokenStep(deps: TokenFlowDeps) {
  const { account_id } = await readSettings(createDb(deps.db), [SETTING.accountId]);
  const { result } = await verifyCloudflareToken({
    ...verifyOptions(deps),
    knownAccountId: account_id ?? null,
  });
  return result;
}

export interface SaveTokenResult {
  ok: true;
  accountId: string;
  workerName: string;
  /** False when `SETUP_TOKEN` could not be deleted (it is inert once a user exists). */
  setupTokenRemoved: boolean;
}

/** First-time save from `/setup`. Refuses once a token is configured. */
export async function saveTokenStep(deps: TokenFlowDeps): Promise<SaveTokenResult> {
  return withTokenLock(deps.db, async () => {
    const db = createDb(deps.db);
    const current = await readSettings(db, [SETTING.cfTokenConfigured]);
    if (current.cf_token_configured === "1") {
      throw new TokenStepError(TOKEN_STEP_MESSAGES.alreadyConfigured);
    }
    const { verified, scripts } = await verifyOrThrow(deps, null);
    const discovery = discoverWorkerName(deps.host, scripts);
    if (!discovery.ok) throw new TokenStepError(discovery.error);
    const { workerName } = discovery;
    const client = clientFor(deps, verified.accountId);

    await client.workers.putSecret(workerName, {
      name: CF_API_TOKEN_SECRET,
      type: "secret_text",
      text: deps.token,
    });
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
    const setupTokenRemoved = await deleteSetupToken(client, workerName);
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
    fetch: deps.fetch,
    onRequest: deps.onRequest,
    baseUrl: deps.baseUrl,
  };
}

async function verifyOrThrow(deps: TokenFlowDeps, knownAccountId: string | null) {
  const { result, scripts } = await verifyCloudflareToken({
    ...verifyOptions(deps),
    knownAccountId,
  });
  if (!result.ok) throw new TokenStepError(result.error);
  if (!result.permissionsOk || scripts === null) {
    throw new TokenStepError(TOKEN_STEP_MESSAGES.needsScripts);
  }
  return { verified: result satisfies TokenVerification, scripts };
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

/** `SETUP_TOKEN` is single use. Already gone (404) counts as removed. */
async function deleteSetupToken(client: CloudflareClient, workerName: string): Promise<boolean> {
  try {
    await client.workers.deleteSecret(workerName, SETUP_TOKEN_SECRET);
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return true;
    // The token is stored and settings are written; failing now would strand the
    // wizard. SETUP_TOKEN no longer grants anything once a user exists.
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
