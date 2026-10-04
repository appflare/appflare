import { CloudflareApiError, type CloudflareClient } from "@appflare/cf-api";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { createDb } from "../db/client";
import { install_access } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { recordedBypassAppId } from "./bypass.server";
import { anyProtectedInstall, ensureAppAccessUsersPolicy } from "./install-access.server";
import { withAccessLock } from "./toggle.server";

/**
 * The cron's check that what protects installed apps still exists in the
 * account, at most two Cloudflare reads a run and none while no install is
 * protected:
 *
 * - one listing of the account's Access applications: an install whose
 *   application, or the one keeping its public paths open, is gone (deleted
 *   in the dashboard) is marked `access_app_missing_at`, so its page offers
 *   to protect it again; one found again is unmarked. Protecting the install
 *   clears the mark too.
 * - one read of the "Appflare users" policy: when it is gone, it is made
 *   again, so every protected app then names an older policy than the one
 *   on record and its page offers to protect it again.
 *
 * Runs under the Access lock, so it never mistakes an application being
 * made for one that is gone. A refused or failed read is reported, never
 * thrown: the other check still runs.
 */

export interface AccessUpkeepResult {
  /** Nothing is protected, so nothing was read. */
  skipped: boolean;
  /** Installs newly found without their Access application. */
  missing: string[];
  /** Installs whose applications were found again. */
  found: string[];
  /** Why the listing failed; null when it did not. */
  listError: string | null;
  usersPolicy: "none" | "present" | "recreated" | "failed";
  /** Why reading or making the users policy failed; null when it did not. */
  usersPolicyError: string | null;
}

function isNotFound(error: unknown): boolean {
  return error instanceof CloudflareApiError && error.status === 404;
}

/** Only a 404 proves an application is gone; any other answer leaves it as it was. */
async function confirmedDeleted(client: CloudflareClient, appId: string): Promise<boolean> {
  try {
    await client.access.getApp(appId);
    return false;
  } catch (error) {
    return isNotFound(error);
  }
}

/**
 * At most this many applications are read one by one per run to confirm
 * they are gone (a 404 each), so the check stays within its unit's
 * subrequest budget; the rest wait for the next run.
 */
export const DELETION_CHECKS_PER_RUN = 8;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function checkProtectedAppsExist(deps: {
  db: D1Database;
  client: () => Promise<CloudflareClient>;
  now?: () => Date;
}): Promise<AccessUpkeepResult> {
  const result: AccessUpkeepResult = {
    skipped: true,
    missing: [],
    found: [],
    listError: null,
    usersPolicy: "none",
    usersPolicyError: null,
  };
  if (!(await anyProtectedInstall(deps.db))) return result;
  result.skipped = false;
  const client = await deps.client();
  const now = (deps.now ?? (() => new Date()))();
  const orm = createDb(deps.db);
  return withAccessLock(deps.db, async () => {
    let listed: Set<string> | null = null;
    try {
      listed = new Set((await client.access.listApps()).map((app) => app.id));
    } catch (error) {
      result.listError = messageOf(error);
    }
    if (listed !== null) {
      const rows = await orm
        .select({
          installId: install_access.install_id,
          appId: install_access.access_app_id,
          missingAt: install_access.access_app_missing_at,
        })
        .from(install_access)
        .where(isNotNull(install_access.access_app_id));
      let checks = 0;
      for (const row of rows) {
        if (row.appId === null) continue;
        const bypassId = await recordedBypassAppId(deps.db, row.installId);
        const unlisted = [row.appId, bypassId].filter(
          (id): id is string => id !== null && !listed.has(id),
        );
        // A listing can be short (a page the API did not report), so an
        // application counts as deleted only when Cloudflare answers 404 for it.
        let gone = false;
        if (row.missingAt === null) {
          for (const id of unlisted) {
            if (checks >= DELETION_CHECKS_PER_RUN) break;
            checks += 1;
            if (await confirmedDeleted(client, id)) {
              gone = true;
              break;
            }
          }
        } else {
          gone = unlisted.length > 0;
        }
        if (gone === (row.missingAt !== null)) continue;
        await orm
          .update(install_access)
          .set({ access_app_missing_at: gone ? now : null })
          .where(
            and(
              eq(install_access.install_id, row.installId),
              // Only the application that was listed, never one made meanwhile.
              eq(install_access.access_app_id, row.appId),
              gone
                ? isNull(install_access.access_app_missing_at)
                : isNotNull(install_access.access_app_missing_at),
            ),
          );
        (gone ? result.missing : result.found).push(row.installId);
      }
    }
    const s = await readSettings(orm, [SETTING.appAccessUsersPolicyId]);
    const policyId = s.app_access_users_policy_id || null;
    if (policyId !== null) {
      try {
        await client.access.getReusablePolicy(policyId);
        result.usersPolicy = "present";
      } catch (error) {
        if (isNotFound(error)) {
          try {
            await ensureAppAccessUsersPolicy({ db: deps.db, client, now: () => now });
            result.usersPolicy = "recreated";
          } catch (made) {
            result.usersPolicy = "failed";
            result.usersPolicyError = messageOf(made);
          }
        } else {
          result.usersPolicy = "failed";
          result.usersPolicyError = messageOf(error);
        }
      }
    }
    return result;
  });
}
