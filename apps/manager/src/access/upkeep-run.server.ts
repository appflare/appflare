import type { AccessApp, CloudflareClient, FetchLike } from "@appflare/cf-api";
import type { AppManifestOptions } from "../catalog/app-manifest.server";
import { type CfClientEnv, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { install_access } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { renewInstallServiceTokens, resyncAppAccessUsersIfFailed } from "./install-access.server";
import { PROTECT_MESSAGES, resyncInstallAccessIfFailed, takenByApp } from "./protect.server";
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
 *    still exist: a list of at most two pages, the account's script list
 *    and its Workers custom domains for the version previews and wildcard
 *    domains check, `DELETION_CHECKS_PER_RUN` (8) reads, the users policy
 *    read and up to four calls to make it again: 17; then Access
 *    applications whose sync failed or is due, against that same list of
 *    applications, `ACCESS_RESYNCS_PER_RUN` (3) at most 11 calls each (the
 *    script list, the Workers custom domains, the account subdomain, the
 *    application read and write, a list of at most two pages and a second
 *    write when an application made since names one of the app's
 *    addresses, and the public paths' application: read, write, make
 *    again): 33. Together 50. When the check could not list the
 *    applications it spends at most 7, and each resync lists them itself,
 *    two more calls each: 46.
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
  let apps: AccessApp[] | null = null;
  try {
    const upkeep = await checkProtectedAppsExist({ db: env.DB, client, ...now });
    apps = upkeep.apps;
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
    for (const { installId, uris } of upkeep.freed) {
      lines.push({
        level: "log",
        message: `access: install ${installId}: no other Access application names ${uris.join(", ")} any more; brought in step on the resync`,
      });
    }
    for (const id of upkeep.patterns) {
      lines.push({
        level: "log",
        message: `access: install ${id}: what its Access application names of its version previews, its wildcard domains or the hostnames Cloudflare's limit left out is out of step with the account's other applications and Workers; brought in step on the resync`,
      });
    }
    if (upkeep.workersError !== null) {
      lines.push({
        level: "error",
        message:
          "access: could not list Workers or their custom domains to check protected apps' version previews and wildcard domains",
        error: upkeep.workersError,
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
    const resyncs = await resyncInstallAccessIfFailed({
      db: env.DB,
      client,
      ...now,
      ...(apps === null ? {} : { apps }),
    });
    for (const r of resyncs) {
      if (r.outcome === "busy") {
        lines.push({
          level: "log",
          message: `access: another Access change is in progress; install ${r.installId} and the rest are brought in step on the next run`,
        });
        continue;
      }
      const message = `access: applications of install ${r.installId} brought in step again: ${r.outcome}`;
      lines.push(
        r.outcome === "failed"
          ? { level: "error", message, ...(r.detail === undefined ? {} : { error: r.detail }) }
          : { level: "log", message },
      );
      for (const { app, uris } of takenByApp(r.taken ?? [])) {
        lines.push({
          level: "warn",
          message: `access: install ${r.installId}: ${PROTECT_MESSAGES.taken(app, uris)}`,
        });
      }
      for (const warning of r.warnings ?? []) {
        lines.push({ level: "warn", message: `access: install ${r.installId}: ${warning}` });
      }
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
