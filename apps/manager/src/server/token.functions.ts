import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { refreshCapabilitiesForNewToken } from "../capabilities/capabilities.server";
import { apiBaseOption } from "../cloudflare/api-base";
import { logCfRequest } from "../cloudflare/client.server";
import type { VerifyTokenResult } from "../cloudflare/verify-token";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import { requireRole, requireSession } from "./auth.server";
import { cfTokenInput } from "./schemas";
import {
  type RotateTokenResult,
  rotateTokenStep,
  type SaveTokenResult,
  saveTokenStep,
  type TokenFlowDeps,
  TokenStepError,
  verifyTokenStep,
} from "./token.server";

/**
 * Cloudflare token server functions.
 * All are POST so the token travels in the body, never in a logged URL. Handlers
 * never log their input; errors carry fixed messages or `CloudflareApiError`
 * messages (method, path, status, Cloudflare's text), never the token.
 */

function deps(token: string): TokenFlowDeps {
  return {
    db: env.DB,
    token,
    host: new URL(getRequest().url).host,
    onRequest: logCfRequest,
    ...apiBaseOption(env),
  };
}

/** Re-throws step failures as plain errors with a user-facing message. */
async function userFacing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof TokenStepError || error instanceof CloudflareApiError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

/**
 * Admin only. Verifies a token and reports its account, type, expiry, and missing
 * capabilities; stores nothing. Used by the setup step and by rotation.
 */
export const verifyToken = createServerFn({ method: "POST" })
  .validator(cfTokenInput)
  .handler(async ({ data }): Promise<VerifyTokenResult> => {
    await requireRole("admin");
    return userFacing(() => verifyTokenStep(deps(data.token)));
  });

/**
 * Reads the account's capabilities (R2, Containers, Workers plan) with the
 * token just stored: this version of the manager may still hold the previous
 * one. Best effort; it never fails the save.
 */
async function checkCapabilities(accountId: string, token: string): Promise<void> {
  await refreshCapabilitiesForNewToken(createDb(env.DB), {
    accountId,
    token,
    onRequest: logCfRequest,
    ...apiBaseOption(env),
  });
}

/**
 * Admin only, setup: verify, store as `CF_API_TOKEN`, record settings, delete
 * `SETUP_TOKEN`, then read the account's capabilities.
 */
export const saveToken = createServerFn({ method: "POST" })
  .validator(cfTokenInput)
  .handler(async ({ data }): Promise<SaveTokenResult> => {
    await requireRole("admin");
    const saved = await userFacing(() => saveTokenStep(deps(data.token)));
    await checkCapabilities(saved.accountId, data.token);
    return saved;
  });

/**
 * Admin only, settings: verify and replace `CF_API_TOKEN` on the same Worker,
 * then read the account's capabilities with the new token.
 */
export const rotateToken = createServerFn({ method: "POST" })
  .validator(cfTokenInput)
  .handler(async ({ data }): Promise<RotateTokenResult> => {
    await requireRole("admin");
    const rotated = await userFacing(() => rotateTokenStep(deps(data.token)));
    await checkCapabilities(rotated.accountId, data.token);
    return rotated;
  });

export interface TokenStatus {
  configured: boolean;
  accountId: string | null;
  accountName: string | null;
  workerName: string | null;
  /** ISO 8601 */
  verifiedAt: string | null;
  /**
   * `CF_API_TOKEN` is bound in the running version. False between saving the
   * token and the manager's redeploy reaching this request.
   */
  hasSecret: boolean;
}

/** Any signed-in user (members read everything): what the settings card shows. */
export const getTokenStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<TokenStatus> => {
    await requireSession();
    const s = await readSettings(createDb(env.DB), [
      SETTING.cfTokenConfigured,
      SETTING.accountId,
      SETTING.accountName,
      SETTING.workerName,
      SETTING.cfTokenVerifiedAt,
    ]);
    return {
      configured: s.cf_token_configured === "1",
      accountId: s.account_id || null,
      accountName: s.account_name || null,
      workerName: s.worker_name || null,
      verifiedAt: s.cf_token_verified_at || null,
      hasSecret: typeof env.CF_API_TOKEN === "string" && env.CF_API_TOKEN.length > 0,
    };
  },
);
