import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import type { AppManifestOptions } from "../catalog/app-manifest.server";
import { type CfClientEnv, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { install_access } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { renewInstallServiceTokens, resyncAppAccessUsersIfFailed } from "./install-access.server";
import { resyncInstallAccessIfFailed } from "./protect.server";
import { refreshProtectedRevisions } from "./revision-refresh.server";
import { checkProtectedAppsExist } from "./upkeep.server";

/**
 * The cron's upkeep of apps protected with Cloudflare Access, in three
 * parts, each one `SELF` unit with an invocation and a subrequest budget of
 * its own (one subrequest of the cron each); without the binding they run in
 * place. Worst cases, in Cloudflare and catalog fetches, against the Free
 * plan's 50 per invocation:
 *
 * 1. `refreshAccessRevisions`: newer catalog revisions of protected apps'
 *    releases, `PROTECTED_REVISION_CHECKS_PER_RUN` (7) installs at 6 fetches
 *    each: 42. A revision that changes public paths marks the app for part 3.
 * 2. `renewAccessTokens`: service tokens with less than 30 days left (or a
 *    secret that no longer reads), `RENEWALS_PER_RUN` (10) at one call each,
 *    then "Appflare users" after a failed update (an update, or a list of at
 *    most two pages and a create when it was deleted): 14.
 * 3. `resyncAccessApps`: first the check that protected apps' applications
 *    still exist: a list of at most two pages, `DELETION_CHECKS_PER_RUN` (8)
 *    reads, the users policy read and up to four calls to make it again: 15;
 *    then Access applications whose sync failed or is due,
 *    `ACCESS_RESYNCS_PER_RUN` (3) at most 9 calls each (the script list, the
 *    application read and write, the account subdomain, and the public paths'
 *    application: read, list of at most two pages, write, make again): 27.
 *    Together 42.
 *
 * Each part never throws: what it did, and what failed, comes back as log
 * lines, which the cron writes to its own log.
 */

export interface AccessUpkeepLine {
  level: "log" | "warn" | "error";
  message: string;
  /** The error, for a failure. */
  error?: string;
}

export interface AccessUpkeepReport {
  lines: AccessUpkeepLine[];
}

export interface AccessUpkeepEnv extends CfClientEnv {
  KV: KVNamespace;
  BETTER_AUTH_SECRET?: string;
  CATALOG_INDEX_URL?: string;
}

export interface AccessUpkeepDeps {
  fetch?: FetchLike;
  /** The Cloudflare client; built from the Worker's own token by default. */
  client?: () => Promise<CloudflareClient>;
  /** Over each catalog listing's trust, for the revision check (tests). */
  manifestOptions?: AppManifestOptions;
  now?: () => Date;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether there is anything to look after: an install with an Access record
 * (protected, or with a token made for it), or an "Appflare users" policy.
 * One or two D1 reads; when false the cron does not start the unit.
 */
export async function accessUpkeepNeeded(d1: D1Database): Promise<boolean> {
  const orm = createDb(d1);
  const [row] = await orm.select({ id: install_access.install_id }).from(install_access).limit(1);
  if (row !== undefined) return true;
  const s = await readSettings(orm, [SETTING.appAccessUsersPolicyId]);
  return Boolean(s.app_access_users_policy_id);
}

/** The three parts of the upkeep, by unit name. */
export const ACCESS_UPKEEP_PARTS = [
  "refreshAccessRevisions",
  "renewAccessTokens",
  "resyncAccessApps",
] as const;
export type AccessUpkeepPart = (typeof ACCESS_UPKEEP_PARTS)[number];

function clientOf(env: AccessUpkeepEnv, deps: AccessUpkeepDeps) {
  return (
    deps.client ?? (() => getCfClient(env, deps.fetch === undefined ? {} : { fetch: deps.fetch }))
  );
}

/** Part 1: newer catalog revisions of protected apps' releases. */
export async function refreshAccessRevisions(
  env: AccessUpkeepEnv,
  deps: AccessUpkeepDeps = {},
): Promise<AccessUpkeepReport> {
  const lines: AccessUpkeepLine[] = [];
  try {
    const checks = await refreshProtectedRevisions(
      env,
      deps.manifestOptions === undefined ? {} : { manifestOptions: deps.manifestOptions },
    );
    for (const r of checks) {
      if (r.outcome === "current") continue;
      const message = `access: catalog revision for install ${r.installId}: ${r.outcome}`;
      lines.push(
        r.outcome === "failed"
          ? { level: "error", message, ...(r.detail === undefined ? {} : { error: r.detail }) }
          : { level: "log", message },
      );
    }
  } catch (error) {
    lines.push({
      level: "error",
      message: "access: check for catalog revisions of protected apps failed",
      error: messageOf(error),
    });
  }
  return { lines };
}

/** Part 2: service tokens, then "Appflare users" after a failed update. */
export async function renewAccessTokens(
  env: AccessUpkeepEnv,
  deps: AccessUpkeepDeps = {},
): Promise<AccessUpkeepReport> {
  const lines: AccessUpkeepLine[] = [];
  const client = clientOf(env, deps);
  const now = deps.now === undefined ? {} : { now: deps.now };
  try {
    const renewals = await renewInstallServiceTokens({
      db: env.DB,
      authSecret: env.BETTER_AUTH_SECRET,
      client,
      ...now,
    });
    for (const r of renewals) {
      const message = `access: service token of install ${r.installId} ${r.status}`;
      if (r.status === "failed") {
        lines.push({
          level: "error",
          message,
          ...(r.detail === undefined ? {} : { error: r.detail }),
        });
      } else lines.push({ level: r.status === "missing" ? "warn" : "log", message });
    }
  } catch (error) {
    lines.push({
      level: "error",
      message: "access: renewal of protected apps' service tokens failed",
      error: messageOf(error),
    });
  }
  try {
    const users = await resyncAppAccessUsersIfFailed({ db: env.DB, client, ...now });
    if (users === "resynced") {
      lines.push({ level: "log", message: "access: users policy of protected apps synced again" });
    } else if (users === "recreated") {
      lines.push({
        level: "warn",
        message:
          "access: users policy of protected apps was deleted and made again; protect each app again to use it",
      });
    }
  } catch (error) {
    lines.push({
      level: "error",
      message: "access: users policy of protected apps could not be synced again",
      error: messageOf(error),
    });
  }
  return { lines };
}

/** Part 3: the check that protected apps' Access applications still exist, then the ones due a sync. */
export async function resyncAccessApps(
  env: AccessUpkeepEnv,
  deps: AccessUpkeepDeps = {},
): Promise<AccessUpkeepReport> {
  const lines: AccessUpkeepLine[] = [];
  const client = clientOf(env, deps);
  const now = deps.now === undefined ? {} : { now: deps.now };
  // First, and apart from the resyncs below: on an account with hundreds of
  // Access applications the resyncs can run out of this invocation's
  // subrequests, and noticing an application deleted in the dashboard (an app
  // left open) matters more than bringing one in step.
  try {
    const upkeep = await checkProtectedAppsExist({ db: env.DB, client, ...now });
    for (const id of upkeep.missing) {
      lines.push({
        level: "warn",
        message: `access: the Access application of install ${id} is gone; protect it again`,
      });
    }
    for (const id of upkeep.found) {
      lines.push({
        level: "log",
        message: `access: the Access application of install ${id} is there again`,
      });
    }
    if (upkeep.listError !== null) {
      lines.push({
        level: "error",
        message: "access: could not list Access applications",
        error: upkeep.listError,
      });
    }
    if (upkeep.usersPolicy === "recreated") {
      lines.push({
        level: "warn",
        message:
          "access: users policy of protected apps was deleted and made again; protect each app again to use it",
      });
    } else if (upkeep.usersPolicy === "failed") {
      lines.push({
        level: "error",
        message: "access: could not check the users policy of protected apps",
        ...(upkeep.usersPolicyError === null ? {} : { error: upkeep.usersPolicyError }),
      });
    }
  } catch (error) {
    // The Access lock was held (a change in progress), or D1 failed: next run.
    lines.push({
      level: "error",
      message: "access: check that protected apps' Access applications exist failed",
      error: messageOf(error),
    });
  }
  // Apart from the check above, so a failure there never skips it.
  try {
    for (const r of await resyncInstallAccessIfFailed({ db: env.DB, client, ...now })) {
      const message = `access: applications of install ${r.installId} brought in step again: ${r.outcome}`;
      lines.push(
        r.outcome === "failed"
          ? { level: "error", message, ...(r.detail === undefined ? {} : { error: r.detail }) }
          : { level: "log", message },
      );
    }
  } catch (error) {
    lines.push({
      level: "error",
      message: "access: resync of protected apps' Access applications failed",
      error: messageOf(error),
    });
  }
  return { lines };
}

/** Each part by its unit name, to run in place. */
export const ACCESS_UPKEEP_IN_PLACE: Record<
  AccessUpkeepPart,
  (env: AccessUpkeepEnv, deps?: AccessUpkeepDeps) => Promise<AccessUpkeepReport>
> = { refreshAccessRevisions, renewAccessTokens, resyncAccessApps };

/** Every part in place, in order (a manager without the `SELF` binding, and tests). */
export async function runAccessUpkeep(
  env: AccessUpkeepEnv,
  deps: AccessUpkeepDeps = {},
): Promise<AccessUpkeepReport> {
  const lines: AccessUpkeepLine[] = [];
  for (const part of [refreshAccessRevisions, renewAccessTokens, resyncAccessApps]) {
    lines.push(...(await part(env, deps)).lines);
  }
  return { lines };
}

/** Writes the upkeep's lines to the log of the invocation that ran it (the cron's). */
export function logAccessUpkeep(report: AccessUpkeepReport): void {
  for (const line of report.lines) {
    const data = line.error === undefined ? [] : [{ error: line.error }];
    if (line.level === "error") console.error(line.message, ...data);
    else if (line.level === "warn") console.warn(line.message, ...data);
    else console.log(line.message, ...data);
  }
}
