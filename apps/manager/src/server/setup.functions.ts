import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
  getRequest,
  getRequestHeader,
  setCookie,
} from "@tanstack/react-start/server";
import { refreshCapabilitiesForNewToken } from "../capabilities/capabilities.server";
import { apiBaseOption } from "../cloudflare/api-base";
import { logCfRequest } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { selfUnits } from "../jobs/units/client";
import { recordSetupFinished } from "../telemetry/state.server";
import { syncAppAccessAfterUserChange } from "./access.server";
import { authSecretBound, currentAuth } from "./auth.server";
import { cfTokenInput, ownerInput } from "./schemas";
import {
  connectCloudflareStep,
  createOwnerStep,
  SETUP_CLAIM_COOKIE,
  SETUP_CLAIM_TTL_MS,
  SetupError,
} from "./setup.server";
import { type TokenFlowDeps, TokenStepError } from "./token.server";
import { authErrorMessage, hasAnyUser } from "./users.server";

/**
 * First-run setup server functions. These are the only
 * server functions that do not call `requireSession()`: they run before any
 * user exists, and each refuses once one does. Before the owner exists the
 * credential is an API token for the account this Worker runs in, then the
 * setup claim cookie that saving it issued (see `setup.server.ts`).
 */

export const getSetupStatus = createServerFn({ method: "GET" }).handler(async () => {
  return { needsSetup: !(await hasAnyUser(createDb(env.DB))) };
});

function tokenDeps(token: string): TokenFlowDeps {
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

/** The client address Cloudflare reports, for the rate limit; `local` in local dev. */
function clientAddress(): string {
  return getRequestHeader("cf-connecting-ip") ?? "local";
}

/** Re-throws refusals as plain errors with their user-facing message. */
async function userFacing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof SetupError ||
      error instanceof TokenStepError ||
      error instanceof CloudflareApiError
    ) {
      throw new Error(error.message);
    }
    throw error;
  }
}

export interface ConnectedCloudflare {
  accountId: string;
  accountName: string | null;
  workerName: string;
  /** Permission groups the save could not confirm. */
  missing: string[];
  setupTokenRemoved: boolean;
  /**
   * What the wizard shows next: the owner form, or a wait while the version
   * that received a new auth secret with the token rolls out (a manager
   * deployed without secrets).
   */
  next: "create-owner" | "redeploying";
}

/**
 * Step 1's one call: verifies the token for the account this Worker runs in,
 * stores it and gives this browser the setup claim, then reads the account's
 * capabilities for the last setup step (best effort; never fails the save). POST so
 * the token travels in the body, never in a logged URL.
 */
export const connectCloudflare = createServerFn({ method: "POST" })
  .validator(cfTokenInput)
  .handler(async ({ data }): Promise<ConnectedCloudflare> => {
    const request = getRequest();
    const connected = await userFacing(() =>
      connectCloudflareStep({
        token: tokenDeps(data.token),
        client: clientAddress(),
        now: new Date(),
        claimCookie: getCookie(SETUP_CLAIM_COOKIE),
        currentToken: env.CF_API_TOKEN,
        authSecretBound: authSecretBound(),
        selfBound: selfUnits(env) !== undefined,
      }),
    );
    setCookie(SETUP_CLAIM_COOKIE, connected.claim.value, {
      httpOnly: true,
      secure: new URL(request.url).protocol === "https:",
      sameSite: "strict",
      path: "/",
      maxAge: Math.floor(SETUP_CLAIM_TTL_MS / 1000),
    });
    await refreshCapabilitiesForNewToken(createDb(env.DB), {
      accountId: connected.accountId,
      token: data.token,
      onRequest: logCfRequest,
      version: env.APPFLARE_VERSION,
      ...apiBaseOption(env),
    });
    return {
      accountId: connected.accountId,
      accountName: connected.accountName,
      workerName: connected.workerName,
      missing: connected.missing,
      setupTokenRemoved: connected.setupTokenRemoved,
      // This request runs on the version from before the save: without the
      // auth secret here, the save just wrote one and a new version is rolling out.
      next: authSecretBound() ? "create-owner" : "redeploying",
    };
  });

/**
 * Records that setup finished for usage data: the first scheduled report
 * after this sends "setup completed". The notice itself is shown on the home
 * page, never inside setup. Best effort; it never fails setup.
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
 * Creates the owner through the admin plugin's `createUser` (public sign-up
 * is disabled, see auth/server.ts). Called without request headers, so Better
 * Auth treats it as a trusted server call. The browser signs in next.
 */
export const createOwner = createServerFn({ method: "POST" })
  .validator(ownerInput)
  .handler(async ({ data }) => {
    try {
      await createOwnerStep({
        d1: env.DB,
        claimCookie: getCookie(SETUP_CLAIM_COOKIE),
        now: new Date(),
        authReady: authSecretBound(),
        input: data,
        createUser: async (input) => {
          const { user } = await currentAuth().api.createUser({
            body: { ...input, role: "admin" },
          });
          return user;
        },
      });
    } catch (error) {
      if (error instanceof SetupError) throw new Error(error.message);
      throw new Error(authErrorMessage(error, "Could not create the owner account."));
    }
    deleteCookie(SETUP_CLAIM_COOKIE, { path: "/" });
    // Like every other new user. Nothing can be protected before the owner
    // exists, so this reads one settings row and is "off"; it never throws.
    await syncAppAccessAfterUserChange();
    await recordSetupForUsageData();
    return { ok: true as const };
  });
