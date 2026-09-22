import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { setupTokenMatches } from "../auth/setup-token";
import { createDb } from "../db/client";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";
import { currentAuth } from "./auth.server";
import { firstAdminInput, setupTokenInput } from "./schemas";
import { authErrorMessage, hasAnyUser } from "./users.server";

/**
 * Setup server functions. These are the only server
 * functions that do not call `requireSession()`: they run before any user exists,
 * and each one refuses to do anything once the first user does. Possession of
 * `SETUP_TOKEN` is the credential.
 */

/** Deliberately vague: never reveals whether the token was missing, wrong, or used. */
export const INVALID_SETUP_LINK = "This setup link is invalid or has expired.";
const SETUP_ALREADY_DONE = "Setup is already complete. Sign in instead.";

/** Serializes concurrent first-admin attempts; see `db/settings-lock.ts`. */
const FIRST_ADMIN_LOCK_KEY = "setup_first_admin_lock";

export const getSetupStatus = createServerFn({ method: "GET" }).handler(async () => {
  return { needsSetup: !(await hasAnyUser(createDb(env.DB))) };
});

/** POST so the token travels in the body, never in a logged URL. */
export const checkSetupToken = createServerFn({ method: "POST" })
  .validator(setupTokenInput)
  .handler(async ({ data }) => {
    if (await hasAnyUser(createDb(env.DB))) return { valid: false };
    return { valid: await setupTokenMatches(data.token, env.SETUP_TOKEN) };
  });

/**
 * Creates the first user with role `admin` through the admin plugin's
 * `createUser` (public sign-up is disabled, see auth/server.ts). Called without
 * request headers, so Better Auth treats it as a trusted server call.
 */
export const createFirstAdmin = createServerFn({ method: "POST" })
  .validator(firstAdminInput)
  .handler(async ({ data }) => {
    const db = createDb(env.DB);
    if (await hasAnyUser(db)) throw new Error(SETUP_ALREADY_DONE);
    if (!(await setupTokenMatches(data.token, env.SETUP_TOKEN))) {
      throw new Error(INVALID_SETUP_LINK);
    }
    const owner = crypto.randomUUID();
    if (!(await tryAcquireSettingsLock(env.DB, FIRST_ADMIN_LOCK_KEY, owner, 60_000))) {
      throw new Error("Setup is already in progress. Try again in a minute.");
    }
    try {
      if (await hasAnyUser(db)) throw new Error(SETUP_ALREADY_DONE);
      await currentAuth().api.createUser({
        body: { email: data.email, name: data.name, password: data.password, role: "admin" },
      });
    } catch (error) {
      if (error instanceof Error && error.message === SETUP_ALREADY_DONE) throw error;
      throw new Error(authErrorMessage(error, "Could not create the admin account."));
    } finally {
      await releaseSettingsLock(env.DB, FIRST_ADMIN_LOCK_KEY, owner);
    }
    // The Cloudflare token step follows after sign-in (token.functions.ts), which
    // also deletes SETUP_TOKEN from the Worker.
    return { ok: true as const };
  });
