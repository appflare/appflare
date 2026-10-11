import { type AccessApp, CloudflareApiError, type CloudflareClient } from "@appflare/cf-api";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { install_access } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { recordedBypassAppId } from "./bypass.server";
import { anyProtectedInstall, ensureAppAccessUsersPolicy } from "./install-access.server";
import {
  accountWorkersOf,
  markAccessResyncDue,
  patternsOutOfStep,
  recordedWildcardBases,
  releaseFreedAddresses,
} from "./protect.server";
import { withAccessLock } from "./toggle.server";

/**
 * The cron's check that what protects installed apps still exists in the
 * account, at most two Cloudflare reads a run besides those below, and none
 * while no install is protected:
 *
 * - one listing of the account's Access applications: an install whose
 *   application, or the one keeping its public paths open, is gone (deleted
 *   in the dashboard) is marked `access_app_missing_at`, so its page offers
 *   to protect it again; one found again is unmarked. Protecting the install
 *   clears the mark too. Of an install whose applications are there, an
 *   address its application left to another application that no
 *   application names any more is freed, and the install marked due for
 *   the resync that covers it again (`releaseFreedAddresses`). So is an
 *   install whose application names its Workers' version previews or its
 *   wildcard domains where it should not, or leaves them out where it
 *   should, or left out past Cloudflare's limit a hostname another
 *   application now covers (`patternsOutOfStep`): at most one read of the
 *   account's script list and one of its Workers custom domains for that,
 *   and only for a pattern another application covers.
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
  /** Addresses left to another application that none names any more, by install. */
  freed: Array<{ installId: string; uris: string[] }>;
  /**
   * Installs marked due because what their applications name of their
   * version previews or wildcard domains is out of step, or because another
   * application covers a hostname left out past Cloudflare's limit.
   */
  patterns: string[];
  /** The account's applications as listed; null when the listing failed or was skipped. */
  apps: AccessApp[] | null;
  /** Why the listing failed; null when it did not. */
  listError: string | null;
  /**
   * Why the account's script list or Workers custom domains could not be
   * read for that check; null when they could.
   */
  workersError: string | null;
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
    freed: [],
    patterns: [],
    apps: null,
    listError: null,
    workersError: null,
    usersPolicy: "none",
    usersPolicyError: null,
  };
  if (!(await anyProtectedInstall(deps.db))) return result;
  result.skipped = false;
  const client = await deps.client();
  const now = (deps.now ?? (() => new Date()))();
  const orm = createDb(deps.db);
  return withAccessLock(deps.db, async () => {
    let apps: AccessApp[] | null = null;
    try {
      apps = await client.access.listApps();
    } catch (error) {
      result.listError = messageOf(error);
    }
    result.apps = apps;
    if (apps !== null) {
      const listed = new Set(apps.map((app) => app.id));
      const { account_subdomain: subdomain } = await readSettings(orm, [SETTING.accountSubdomain]);
      const account = accountWorkersOf(client);
      const wildcardBases = await recordedWildcardBases(deps.db);
      const rows = await orm
        .select({
          installId: install_access.install_id,
          appId: install_access.access_app_id,
          missingAt: install_access.access_app_missing_at,
          coverageJson: install_access.access_destinations_json,
          marked: sql<number>`${install_access.access_resync_due_at} IS NOT NULL OR ${install_access.access_sync_failed_at} IS NOT NULL`,
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
        if (gone !== (row.missingAt !== null)) {
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
        // A deleted application is not brought in step: protecting the app
        // again makes a new one.
        if (gone) continue;
        const own = {
          installId: row.installId,
          accessAppId: row.appId,
          bypassAppId: bypassId,
          coverageJson: row.coverageJson,
        };
        const freed = await releaseFreedAddresses({ db: deps.db, now: () => now }, own, apps);
        if (freed.length > 0) result.freed.push({ installId: row.installId, uris: freed });
        try {
          // One already marked is brought in step on the resync anyway.
          if (
            !row.marked &&
            freed.length === 0 &&
            (await patternsOutOfStep(
              own,
              {
                subdomain: subdomain || null,
                wildcardBases: wildcardBases.get(row.installId) ?? [],
              },
              apps,
              account,
            ))
          ) {
            await markAccessResyncDue(deps.db, own, now);
            result.patterns.push(row.installId);
          }
        } catch (error) {
          // A read of the account's Workers failed: the next run looks again.
          result.workersError ??= messageOf(error);
        }
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
