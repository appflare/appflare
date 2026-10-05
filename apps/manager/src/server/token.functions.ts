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
import { managerOrigin } from "../domains/manager-origin.server";
import { recordSetupFinished } from "../telemetry/state.server";
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
    runningVersionId: env.CF_VERSION_METADATA?.id ?? null,
    setupTokenBound: typeof env.SETUP_TOKEN === "string" && env.SETUP_TOKEN.length > 0,
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
    version: env.APPFLARE_VERSION,
    ...apiBaseOption(env),
  });
}

/**
 * Records that setup finished for usage data: the first scheduled report
 * after this sends "setup completed"; the home page shows the notice.
 * Best effort; it never fails the save (the report then starts without it).
 */
async function recordSetupForUsageData(): Promise<void> {
  try {
    await recordSetupFinished(env);
  } catch (error) {
    console.warn("could not record the end of setup for usage data", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Admin only, for a manager whose admin was created before its token: verify
 * and store as `CF_API_TOKEN` in one call, record settings, then read the
 * account's capabilities.
 */
export const saveToken = createServerFn({ method: "POST" })
  .validator(cfTokenInput)
  .handler(async ({ data }): Promise<SaveTokenResult> => {
    await requireRole("admin");
    const saved = await userFacing(() => saveTokenStep(deps(data.token)));
    await recordSetupForUsageData();
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
  /**
   * The address links to this manager use (`managerOrigin`): its custom
   * domain when it has one, else the address this page was loaded from.
   */
  managerOrigin?: string | null;
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
      managerOrigin: await managerOrigin(env, getRequest()),
    };
  },
);
