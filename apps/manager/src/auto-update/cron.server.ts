import type { ArtifactManifest, CatalogManifest, IndexApp } from "@appflare/schema";
import { asc, eq, ne } from "drizzle-orm";
import { getAppManifest, getCatalogManifest } from "../catalog/app-manifest.server";
import { isManagerUpdateAvailable, readManagerLatest } from "../catalog/manager-releases.server";
import { type AppLookup, catalogLookup, type ListedApp } from "../catalog/merged.server";
import { installAppKey } from "../catalog/sources";
import { removalInProgress } from "../danger/removal-flag";
import { createDb } from "../db/client";
import { installs, type JobStarter } from "../db/schema";
import {
  AccessRequiredUpdateError,
  type StartUpdateResult,
  startUpdateCore,
  type UpdateNeeds,
  VersionActionError,
} from "../installs/versions.server";
import { jobCreator } from "../jobs/create-job.server";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import type { SelfUpdateJobParams } from "../jobs/self-update";
import { SelfUpdateError, startSelfUpdateCore } from "../jobs/self-update/start.server";
import type { UpdateJobParams } from "../jobs/update";
import { sandboxBinding } from "../sandbox/binding";
import { runningVersion } from "../server/build-version";
import { isDevBuild } from "../telemetry/state.server";
import {
  type AppSkipReason,
  AUTO_UPDATE_CHOICES,
  type AutoUpdateCandidate,
  type AutoUpdateChoice,
  MAX_APP_STARTS_PER_RUN,
  planAppUpdates,
  planSelfUpdate,
  type SelfUpdateSkipReason,
} from "./auto-update";
import { readAutoUpdateDefaults } from "./auto-update.server";

/**
 * The cron's automatic updates, run once per scheduled run from worker.ts
 * after the catalog index and the release feed are refreshed.
 *
 * 1. Appflare itself, when "Automatically update Appflare" is on and a newer
 *    release is known: a self-update, claimed only while no job at all is
 *    queued or running (the self-update's own guard). When it starts, nothing
 *    else starts this run: every other job waits for it anyway.
 * 2. Apps whose effective setting is on and whose catalog entry is newer
 *    (see `planAppUpdates`): at most 3 started and 10 tried per run, each through the same
 *    start path as the Update button, recorded as started by `schedule`. When
 *    the new version needs anything from an admin (a new secret, a
 *    confirmation), the start path says so instead of starting, and the
 *    update stays on the app's page for an admin; the version is remembered
 *    (`installs.auto_update_waiting`) and not tried again. A version whose
 *    update failed, or that a rollback moved the install off, is not tried again.
 *
 * Everything reads what the cron has already cached (index, release feed,
 * verified manifests in KV); only a manifest not cached yet is fetched, two
 * requests per new version. Nothing here throws for one install: each
 * outcome is returned for the log.
 */

export interface ScheduledUpdatesEnv {
  DB: D1Database;
  KV: KVNamespace;
  JOBS: WorkflowLookup & {
    create(options: { id: string; params: UpdateJobParams | SelfUpdateJobParams }): Promise<{
      id: string;
    }>;
  };
  APPFLARE_VERSION: string;
  CF_API_TOKEN?: string;
  SANDBOX?: unknown;
}

/** Test seams; production reads verified manifests through the KV cache. */
export interface ScheduledUpdatesDeps {
  loadManifest?(app: IndexApp): Promise<ArtifactManifest>;
  loadCatalog?(app: IndexApp): Promise<CatalogManifest>;
  now?: () => Date;
  newId?: () => string;
}

export type SelfUpdateOutcome =
  | { status: "started"; version: string; jobId: string }
  | { status: "skipped"; reason: SelfUpdateSkipReason }
  | { status: "left"; version: string; reason: string };

export type AppUpdateOutcome =
  | { installId: string; slug: string; status: "started"; version: string; jobId: string }
  | { installId: string; slug: string; status: "skipped"; reason: AppSkipReason }
  | { installId: string; slug: string; status: "left"; version: string; reason: string };

export interface ScheduledUpdatesOutcome {
  /** Null when nothing about automatic updates is on. */
  selfUpdate: SelfUpdateOutcome | null;
  /** Installs whose automatic update is on, except those already current. */
  apps: AppUpdateOutcome[];
  /** Why nothing was tried at all, if so. */
  idle: "off" | "no-token" | "removing" | null;
}

/** What an update needs from an admin, as one clause for the log. */
export function describeNeeds(needs: UpdateNeeds): string {
  const parts: string[] = [];
  if (needs.needsSecrets.length > 0) {
    parts.push(`a value for ${needs.needsSecrets.map((s) => s.name).join(", ")}`);
  }
  if (needs.skipsPreview !== null) parts.push("a confirmation to update without a preview check");
  if (needs.build !== null) parts.push("approval of the build or installer run");
  if (needs.cronTriggers !== null) parts.push("a Workers Paid confirmation for its cron triggers");
  return parts.length === 0 ? "an admin's confirmation" : parts.join(", ");
}

function versionOf(inputJson: string | null): string | null {
  if (inputJson === null) return null;
  try {
    const value = (JSON.parse(inputJson) as { version?: unknown }).version;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** `installId version` of every failed update, and `version` of every failed self-update. */
async function failedTargets(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT kind, install_id, input_json FROM jobs
       WHERE status = 'failed' AND kind IN ('update', 'self_update')`,
    )
    .all<{ kind: string; install_id: string | null; input_json: string | null }>();
  const out = new Set<string>();
  for (const row of rows.results ?? []) {
    const version = versionOf(row.input_json);
    if (version === null) continue;
    out.add(row.kind === "self_update" ? version : `${row.install_id} ${version}`);
  }
  return out;
}

/**
 * `installId version` of every version a rollback moved an install off: the
 * version its snapshot's update had moved to. A database restore is recorded
 * as a rollback job too, and moves no install off anything.
 */
async function rolledBackTargets(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare(
      `SELECT j.install_id, s.target_catalog_version AS version
       FROM jobs j
       JOIN snapshots s ON json_valid(j.input_json)
         AND s.id = json_extract(j.input_json, '$.snapshotId')
       WHERE j.kind = 'rollback' AND j.install_id IS NOT NULL
         AND coalesce(json_extract(j.input_json, '$.restore'), 0) = 0
         AND s.target_catalog_version IS NOT NULL`,
    )
    .all<{ install_id: string; version: string }>();
  return new Set((rows.results ?? []).map((r) => `${r.install_id} ${r.version}`));
}

function choiceOf(value: string): AutoUpdateChoice {
  return (AUTO_UPDATE_CHOICES as readonly string[]).includes(value)
    ? (value as AutoUpdateChoice)
    : "inherit";
}

/** The install columns an update decision reads. */
const candidateColumns = {
  id: installs.id,
  slug: installs.app_slug,
  catalogId: installs.catalog_id,
  displayName: installs.display_name,
  workerName: installs.worker_name,
  status: installs.status,
  buildKind: installs.build_kind,
  origin: installs.origin,
  choice: installs.auto_update,
  version: installs.catalog_version,
  waiting: installs.auto_update_waiting,
};

/** Installs that are not uninstalled, oldest first, as update decisions read them. */
export function readCandidateRows(db: D1Database) {
  return createDb(db)
    .select(candidateColumns)
    .from(installs)
    .where(ne(installs.status, "uninstalled"))
    .orderBy(asc(installs.installed_at));
}
export type CandidateRow = Awaited<ReturnType<typeof readCandidateRows>>[number];

/** The app key a candidate row is listed under. */
export function candidateKey(row: Pick<CandidateRow, "slug" | "catalogId">): string {
  return installAppKey({ app_slug: row.slug, catalog_id: row.catalogId });
}

/**
 * What the cron and "Update all" decide on: each install with its catalog
 * entry and whether an update to that version failed or was rolled back.
 */
export async function updateCandidates(
  db: D1Database,
  rows: readonly CandidateRow[],
  listed: AppLookup,
): Promise<AutoUpdateCandidate[]> {
  const [failed, rolledBack] = await Promise.all([failedTargets(db), rolledBackTargets(db)]);
  return rows.map((r) => {
    // Only the install's own catalog: another catalog listing the same slug is another app.
    const app = listed.get(candidateKey(r))?.app;
    const key = app === undefined ? null : `${r.id} ${app.version}`;
    return {
      installId: r.id,
      status: r.status,
      buildKind: r.buildKind,
      origin: r.origin,
      choice: choiceOf(r.choice),
      version: r.version,
      latest: app === undefined ? null : { version: app.version, tier: app.tier },
      triedBefore:
        key === null
          ? null
          : failed.has(key)
            ? "failed"
            : rolledBack.has(key)
              ? "rolled-back"
              : null,
      waiting: r.waiting,
    };
  });
}

/**
 * Starts an install's update through the Update button's own start path,
 * with no secrets and no confirmations: an update that needs any comes back
 * as its needs instead of starting. Throws `VersionActionError` when the
 * start path refuses (a job of the install runs, the manifest cannot be read).
 */
export async function startUnattendedUpdate(
  env: ScheduledUpdatesEnv,
  deps: ScheduledUpdatesDeps,
  listed: AppLookup,
  installId: string,
  startedBy: JobStarter,
): Promise<StartUpdateResult> {
  // The listing `loadApp` found: its catalog's keys verify the new version.
  let found: ListedApp | undefined;
  const trustOf = (app: IndexApp) => {
    if (found?.app !== app) {
      throw new VersionActionError("The app's catalog listing was not loaded before its manifest.");
    }
    return found.trust;
  };
  return startUpdateCore(
    {
      db: env.DB,
      workflows: env.JOBS,
      createJob: jobCreator(env.JOBS),
      startedBy,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.newId === undefined ? {} : { newId: deps.newId }),
      async loadApp(key) {
        found = listed.get(key);
        return found?.app ?? null;
      },
      async loadManifest(app) {
        if (deps.loadManifest !== undefined) return deps.loadManifest(app);
        const read = await getAppManifest(env, app, trustOf(app));
        if (!read.ok) throw new VersionActionError(read.error);
        return read.manifest;
      },
      async loadCatalog(app) {
        if (deps.loadCatalog !== undefined) return deps.loadCatalog(app);
        const read = await getCatalogManifest(env, app, trustOf(app));
        if (!read.ok) throw new VersionActionError(read.error);
        return read.catalog;
      },
      sandboxConnected: sandboxBinding(env) !== undefined,
    },
    { installId },
  );
}

export async function runScheduledUpdates(
  env: ScheduledUpdatesEnv,
  deps: ScheduledUpdatesDeps = {},
): Promise<ScheduledUpdatesOutcome> {
  const orm = createDb(env.DB);
  // Nothing starts while Appflare is being removed from the account.
  if ((await removalInProgress(env.DB)) !== null) {
    return { selfUpdate: null, apps: [], idle: "removing" };
  }
  const defaults = await readAutoUpdateDefaults(orm);
  const rows = await readCandidateRows(env.DB);
  const anyApp = defaults.apps || rows.some((r) => r.choice === "on");
  const outcome: ScheduledUpdatesOutcome = { selfUpdate: null, apps: [], idle: null };
  if (!defaults.manager && !anyApp) return { ...outcome, idle: "off" };
  if (!env.CF_API_TOKEN) return { ...outcome, idle: "no-token" };
  // 1. Appflare itself.
  if (defaults.manager) {
    const [latest, failed] = await Promise.all([readManagerLatest(env.KV), failedTargets(env.DB)]);
    const decision = planSelfUpdate({
      enabled: true,
      devBuild: isDevBuild(runningVersion(env)),
      updateAvailable: isManagerUpdateAvailable(runningVersion(env), latest?.version),
      latestVersion: latest?.version ?? null,
      failedBefore: latest !== null && failed.has(latest.version),
    });
    if (decision.action === "skip") {
      outcome.selfUpdate = { status: "skipped", reason: decision.reason };
    } else {
      try {
        const { jobId } = await startSelfUpdateCore(
          {
            db: env.DB,
            latest,
            currentVersion: runningVersion(env),
            hasToken: true,
            workflows: env.JOBS,
            createJob: jobCreator(env.JOBS),
            startedBy: "schedule",
            ...(deps.now === undefined ? {} : { now: deps.now }),
            ...(deps.newId === undefined ? {} : { newId: deps.newId }),
          },
          { version: decision.version },
        );
        outcome.selfUpdate = { status: "started", version: decision.version, jobId };
        // Every other job waits for the self-update; nothing else starts now.
        return outcome;
      } catch (error) {
        if (!(error instanceof SelfUpdateError)) throw error;
        outcome.selfUpdate = { status: "left", version: decision.version, reason: error.message };
      }
    }
  }
  if (!anyApp) return outcome;

  // 2. Apps.
  // Every enabled catalog's cached index (refreshed just before by the cron).
  const listed = await catalogLookup(env, { refreshOnMiss: false });
  const slugOf = new Map(rows.map((r) => [r.id, r.slug]));
  const candidates = await updateCandidates(env.DB, rows, listed);
  let started = 0;
  for (const decision of planAppUpdates(candidates, defaults.apps)) {
    const slug = slugOf.get(decision.installId) ?? "";
    if (decision.action === "try" && started >= MAX_APP_STARTS_PER_RUN) {
      outcome.apps.push({
        installId: decision.installId,
        slug,
        status: "skipped",
        reason: "limit",
      });
      continue;
    }
    if (decision.action === "skip") {
      if (decision.reason !== "off" && decision.reason !== "up-to-date") {
        outcome.apps.push({
          installId: decision.installId,
          slug,
          status: "skipped",
          reason: decision.reason,
        });
      }
      continue;
    }
    try {
      // No secrets and no confirmations: an update that needs any comes back as needs.
      const result = await startUnattendedUpdate(env, deps, listed, decision.installId, "schedule");
      if ("jobId" in result) {
        started += 1;
        outcome.apps.push({
          installId: decision.installId,
          slug,
          status: "started",
          version: decision.version,
          jobId: result.jobId,
        });
      } else {
        // Left for an admin: not tried again until the catalog has a newer version.
        await orm
          .update(installs)
          .set({ auto_update_waiting: decision.version })
          .where(eq(installs.id, decision.installId));
        outcome.apps.push({
          installId: decision.installId,
          slug,
          status: "left",
          version: decision.version,
          reason: `it needs ${describeNeeds(result)}`,
        });
      }
    } catch (error) {
      if (!(error instanceof VersionActionError)) throw error;
      // Protection must be turned on first: an admin's step, as a value or a confirmation is.
      if (error instanceof AccessRequiredUpdateError) {
        await orm
          .update(installs)
          .set({ auto_update_waiting: decision.version })
          .where(eq(installs.id, decision.installId));
      }
      outcome.apps.push({
        installId: decision.installId,
        slug,
        status: "left",
        version: decision.version,
        reason: error.message,
      });
    }
  }
  return outcome;
}

/** One log line per thing worth saying; nothing when automatic updates are off. */
export function scheduledUpdatesLog(outcome: ScheduledUpdatesOutcome): string[] {
  const lines: string[] = [];
  if (outcome.idle === "no-token") {
    lines.push("automatic updates: skipped, the Cloudflare token is not configured");
  }
  if (outcome.idle === "removing") {
    lines.push("automatic updates: skipped, Appflare is being removed from this account");
  }
  const self = outcome.selfUpdate;
  if (self?.status === "started") {
    lines.push(
      `automatic updates: started updating Appflare to ${self.version} (job ${self.jobId})`,
    );
  } else if (self?.status === "left") {
    lines.push(`automatic updates: Appflare ${self.version} not started: ${self.reason}`);
  }
  for (const app of outcome.apps) {
    if (app.status === "started") {
      lines.push(
        `automatic updates: started updating ${app.slug} (${app.installId}) to ${app.version} (job ${app.jobId})`,
      );
    } else if (app.status === "left") {
      lines.push(
        `automatic updates: ${app.slug} (${app.installId}) ${app.version} left for an admin: ${app.reason}`,
      );
    } else if (app.reason in SKIP_NOTES) {
      lines.push(
        `automatic updates: ${app.slug} (${app.installId}) not tried: ${SKIP_NOTES[app.reason]}`,
      );
    }
  }
  return lines;
}

/** Skips worth a log line (the others are the normal state of an install). */
const SKIP_NOTES: Partial<Record<AppSkipReason, string>> = {
  "reinstall-needed": "its catalog entry changed how it is installed; it takes a reinstall",
  "failed-before": "an update to this version already failed",
  "rolled-back": "it was rolled back from this version",
  limit: "next run",
};
