import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import { ensureOwner, isOwner } from "../server/users.server";
import { readAuthSecretRotatedAt } from "./auth-secret.server";
import { DangerError, OWNER_ONLY } from "./errors";
import { type RemovalReview, readRemovalReview } from "./removal-plan.server";

/** Settings > Your account, danger zone. The actions themselves are form posts (routes.server.ts). */

export interface DangerZoneState {
  /** ISO 8601 time the auth secret was last rotated from Settings, or null. */
  authSecretRotatedAt: string | null;
}

/** Any signed-in user. */
export const getDangerZoneState = createServerFn({ method: "GET" }).handler(
  async (): Promise<DangerZoneState> => {
    await requireSession();
    return { authSecretRotatedAt: await readAuthSecretRotatedAt(env.DB) };
  },
);

/**
 * Owner only: what "Remove Appflare from this account" would delete and
 * keep, read from the account now, and the jobs that would block it.
 */
export const getRemovalReview = createServerFn({ method: "GET" }).handler(
  async (): Promise<RemovalReview> => {
    const session = await requireRole("admin");
    const orm = createDb(env.DB);
    await ensureOwner(orm);
    if (!(await isOwner(orm, session.user.id))) throw new Error(OWNER_ONLY);
    try {
      return await readRemovalReview(env.DB, await getCfClient(env), env.JOBS);
    } catch (error) {
      if (
        error instanceof DangerError ||
        error instanceof CfTokenNotConfiguredError ||
        error instanceof CloudflareApiError
      ) {
        throw new Error(error.message);
      }
      throw error;
    }
  },
);
