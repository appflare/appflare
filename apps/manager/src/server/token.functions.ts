import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
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

/** Admin only, setup: verify, store as `CF_API_TOKEN`, record settings, delete `SETUP_TOKEN`. */
export const saveToken = createServerFn({ method: "POST" })
  .validator(cfTokenInput)
  .handler(async ({ data }): Promise<SaveTokenResult> => {
    await requireRole("admin");
    return userFacing(() => saveTokenStep(deps(data.token)));
  });

/** Admin only, settings: verify and replace `CF_API_TOKEN` on the same Worker. */
export const rotateToken = createServerFn({ method: "POST" })
  .validator(cfTokenInput)
  .handler(async ({ data }): Promise<RotateTokenResult> => {
    await requireRole("admin");
    return userFacing(() => rotateTokenStep(deps(data.token)));
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
