import type { D1TimeTravelRestore, RequestLog } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  appWorkers,
  artifactManifestSchema,
  type CatalogManifest,
  type CatalogSecret,
  type IndexApp,
  type IndexBuild,
} from "@appflare/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { readAccountPlan, writeAccountPlan } from "../account/plan.server";
import { cronTriggerCount } from "../catalog/cron-triggers";
import { installAppKey, unsignedTierRefusal } from "../catalog/sources";
import { createDb, type Database } from "../db/client";
import { installs, type JobStarter, jobs, resources, snapshots } from "../db/schema";
import { otherDoTagsDiffer, otherWorkersMatch, storedOtherWorkers } from "../jobs/entry-workers";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import { liveHyperdriveIds } from "../jobs/reconfigure/hyperdrive";
import type { RollbackJobParams } from "../jobs/rollback";
import { installerRunId } from "../jobs/self-deploying/phases";
import {
  activeSelfJob,
  NO_ACTIVE_SELF_UPDATE_SQL,
  refuseDuringSelfUpdate,
  selfUpdateBusyMessage,
} from "../jobs/self-update/guard";
import { StepLog } from "../jobs/step-log";
import type { UpdateJobParams } from "../jobs/update";
import {
  hyperdriveRollbackRefusal,
  lastDurableObjectTagOf,
  missingSecrets,
  parseBookmarks,
  parseSnapshotHyperdrive,
  updatePath,
  updateRefusal,
} from "../jobs/update/plan";
import { secretsToAskFor, withDerivedSecrets } from "./derived-secrets";
import { snapshotHasSameCode } from "./rollback-copy";

/**
 * Starting updates and rollbacks, restoring a database to a snapshot's
 * bookmark, and listing an install's snapshots. An update or rollback claims
 * the install the way an uninstall does: in one D1 batch the job row is
 * inserted only if the install is `installed` and no job of it is queued or
 * running, and the install becomes `updating` only if the job row was
 * inserted. Then the `JobWorkflow` instance is created.
 */

export class VersionActionError extends Error {
  override name = "VersionActionError";
}

export interface StartJobDeps<P> {
  db: D1Database;
  /** The Workflow binding, to settle a self-update whose instance died before refusing to start. */
  workflows?: WorkflowLookup;
  /** Creates the Workflow instance (`env.JOBS.create`). */
  createJob(id: string, params: P): Promise<{ id: string }>;
  now?: () => Date;
  newId?: () => string;
  /** Who starts the job; an admin unless the cron does (automatic updates). */
  startedBy?: JobStarter;
}

const BUSY =
  "Another job of this install is queued or running, or its state changed. Reload the page.";

export async function readInstall(db: D1Database, installId: string) {
  const [install] = await createDb(db)
    .select()
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) throw new VersionActionError("There is no such install.");
  return install;
}

/** Why no job may start on an install in `status`, or null when one may. */
export function statusRefusal(status: string): string | null {
  switch (status) {
    case "installed":
      return null;
    case "updating":
      return "An update, rollback or settings change of this install is running. Wait for it to finish.";
    case "uninstalled":
      return "This install is uninstalled.";
    case "failed":
      return "This install failed; uninstall it and install the app again.";
    default:
      return "A job of this install is running. Wait for it to finish.";
  }
}

/**
 * The claim batch: job row first, then `installed` -> `updating` only if it
 * was inserted; then the Workflow instance. Refused while any job of the
 * install is queued or running, or a self-update is.
 */
export async function claim<P extends { jobId: string }>(
  deps: StartJobDeps<P>,
  input: {
    installId: string;
    kind: "update" | "rollback" | "reconfigure";
    inputJson: string;
    params: P;
    /** Runs once the job row is claimed, before the Workflow is created. */
    afterClaim?: (db: Database) => Promise<void>;
  },
): Promise<{ jobId: string }> {
  await refuseDuringSelfUpdate(deps.db, deps.workflows, (m) => new VersionActionError(m));
  const now = (deps.now ?? (() => new Date()))();
  const jobId = input.params.jobId;
  const [claimed] = await deps.db.batch([
    deps.db
      .prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by)
         SELECT ?1, ?2, ?3, 'queued', ?4, ?5
         WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status = 'installed')
           AND NOT EXISTS (
             SELECT 1 FROM jobs WHERE install_id = ?2 AND status IN ('queued', 'running')
           )
           AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
      )
      .bind(jobId, input.installId, input.kind, input.inputJson, deps.startedBy ?? "admin"),
    deps.db
      .prepare(
        `UPDATE installs SET status = 'updating', updated_at = ?3
         WHERE id = ?2 AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1)`,
      )
      .bind(jobId, input.installId, now.getTime()),
  ]);
  if (claimed?.meta.changes !== 1) {
    const selfUpdate = await activeSelfJob(deps.db);
    throw new VersionActionError(selfUpdate === null ? BUSY : selfUpdateBusyMessage(selfUpdate));
  }

  const db = createDb(deps.db);
  await input.afterClaim?.(db);
  let instanceId: string;
  try {
    instanceId = (await deps.createJob(jobId, input.params)).id;
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await db.batch([
      db
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: now })
        .where(eq(jobs.id, jobId)),
      db
        .update(installs)
        .set({ status: "installed", updated_at: now })
        .where(and(eq(installs.id, input.installId), eq(installs.status, "updating"))),
    ]);
    throw new VersionActionError(reason);
  }
  await db.update(jobs).set({ workflow_instance_id: instanceId }).where(eq(jobs.id, jobId));
  return { jobId };
}

export interface StartUpdateDeps extends StartJobDeps<UpdateJobParams> {
  /**
   * The app's entry in its catalog's index, by app key (`sources.ts`), or
   * null when it is not listed or its catalog is off.
   */
  loadApp(key: string): Promise<IndexApp | null>;
  /** The verified artifact manifest of that entry; throws `VersionActionError` when unavailable. */
  loadManifest(app: IndexApp): Promise<ArtifactManifest>;
  /**
   * The verified catalog manifest of a sandbox tier entry, which has no
   * artifact until the update builds it; throws `VersionActionError` when
   * unavailable.
   */
  loadCatalog?(app: IndexApp): Promise<CatalogManifest>;
  /** Whether this manager has its `SANDBOX` binding to the sandbox Worker. */
  sandboxConnected?: boolean;
}

export interface StartUpdateRequest {
  installId: string;
  /** Values of the secrets the new version introduces. */
  secrets?: Record<string, string>;
  /** The admin saw that this update cannot check the new version before it serves traffic. */
  confirmNoPreview?: boolean;
  /** For a sandbox tier app: the admin confirmed the cost of building the new version. */
  buildConfirmed?: boolean;
  /**
   * For a self-deploying app: a replacement for the app's own token, stored
   * on the sandbox Worker before its installer runs.
   */
  appToken?: string;
  /**
   * Whether the account is on Workers Paid, answered when the new version
   * adds cron triggers; undefined until asked.
   */
  paidConfirmed?: boolean;
  /** With `paidConfirmed`: also record Workers Paid as the account's plan in Settings. */
  rememberPaidPlan?: boolean;
}

/** What the admin must provide or confirm before the update can start. */
export interface UpdateNeeds {
  version: string;
  /** Secrets the new version introduces that the Worker does not have. */
  needsSecrets: CatalogSecret[];
  /** Why the new version cannot be checked before it serves traffic; null when it can. */
  skipsPreview: string | null;
  /**
   * A sandbox tier app: the build to confirm (container size, expected
   * minutes); a self-deploying app: the installer run to confirm; else null.
   */
  build: IndexBuild | null;
  /** The new version is deployed by the app's own installer (no preview, no rollback). */
  selfDeploying?: boolean;
  /**
   * The cron triggers the new version sets, when that is more than the
   * Worker has, the app does not need Workers Paid, and Settings does not
   * record the account as on Workers Paid (else null): the dialog notes the
   * free plan's limit and offers to confirm Workers Paid.
   */
  cronTriggers: number | null;
}

export type StartUpdateResult = { jobId: string } | UpdateNeeds;

/**
 * Starts an update to the catalog's current version; refused unless it is
 * newer. When the new version introduces secrets, cannot be checked on a
 * preview before it serves traffic, or adds cron triggers to an app that
 * does not need Workers Paid (the free plan allows 5 per account), the first
 * call returns what the admin must provide or confirm instead; the second call carries the values
 * (which go only into the Workflow params) and the confirmation.
 */
export async function startUpdateCore(
  deps: StartUpdateDeps,
  request: StartUpdateRequest,
): Promise<StartUpdateResult> {
  const install = await readInstall(deps.db, request.installId);
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw new VersionActionError(refusal);
  // Only the install's own catalog: another catalog listing the same slug is another app.
  const app = await deps.loadApp(installAppKey(install));
  if (app === null) {
    throw new VersionActionError(
      `"${install.app_slug}" is not in its catalog, or its catalog is turned off in Settings, Catalogs.`,
    );
  }
  const unsigned = unsignedTierRefusal(install.catalog_id, app.tier);
  if (unsigned !== null) throw new VersionActionError(unsigned);
  const notNewer = updateRefusal({
    installedVersion: install.catalog_version,
    targetVersion: app.version,
    indexVersion: app.version,
  });
  if (notNewer !== null) {
    throw new VersionActionError(`There is no newer version to update to: ${notNewer}.`);
  }
  const installer = app.tier === "self-deploying" ? (app.build ?? null) : null;
  if (installer !== null || install.build_kind === "self-deploying") {
    return startSelfDeployingUpdate(deps, request, install, app, installer);
  }
  const sandbox = app.tier === "sandbox" ? (app.build ?? null) : null;
  let catalog: CatalogManifest;
  let skipPreview: string | null = null;
  /** Cron triggers of the new version; unknown for a sandbox build (and it needs Workers Paid anyway). */
  let newCrons: number | null = null;
  if (sandbox !== null) {
    if (deps.sandboxConnected !== true) {
      throw new VersionActionError(
        `${app.name} is built in this account's sandbox Worker, and Appflare is not connected to one. Connect sandbox builds in Settings first.`,
      );
    }
    if (deps.loadCatalog === undefined) {
      throw new VersionActionError(`Appflare cannot update ${app.tier} tier apps here.`);
    }
    catalog = await deps.loadCatalog(app);
    // Whether the built version can be checked on a preview is known only
    // once it is built. The installed version tells what to expect (a Worker
    // that implements a Durable Object has no preview), and the job refuses to
    // skip the check unless the admin confirmed it here.
    skipPreview = expectedSkipPreview(install.manifest_json, install.do_migration_tag);
  } else {
    const manifest = await deps.loadManifest(app);
    catalog = manifest.catalog;
    newCrons = appWorkers(manifest).reduce((n, w) => n + cronTriggerCount(w.worker.crons), 0);
    skipPreview = updatePath(
      manifest,
      install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json),
    ).skipPreview;
  }
  const recorded = await createDb(deps.db)
    .select({ kind: resources.kind, name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, install.id),
        inArray(resources.kind, ["secret", "cron"]),
        isNull(resources.deleted_at),
      ),
    );
  // A derived secret the Worker lacks asks for its source.
  const needed = secretsToAskFor(
    catalog.secrets,
    missingSecrets(
      catalog.secrets,
      recorded.filter((r) => r.kind === "secret").map((r) => r.name),
    ),
  );
  // The installed version's other Workers keep their cron triggers with them, not as rows.
  const recordedCrons =
    recorded.filter((r) => r.kind === "cron").length +
    storedOtherWorkers(install.manifest_json, install.worker_name).reduce(
      (n, w) => n + cronTriggerCount(w.manifest.worker.crons),
      0,
    );
  const accountPaid = (await readAccountPlan(createDb(deps.db))) === "paid";
  const cronTriggers =
    newCrons !== null && newCrons > recordedCrons && catalog.plan !== "paid" && !accountPaid
      ? newCrons
      : null;
  if (
    (needed.length > 0 && request.secrets === undefined) ||
    (skipPreview !== null && request.confirmNoPreview !== true) ||
    (sandbox !== null && request.buildConfirmed !== true) ||
    (cronTriggers !== null && request.paidConfirmed === undefined)
  ) {
    return {
      version: app.version,
      needsSecrets: needed,
      skipsPreview: skipPreview,
      build: sandbox,
      cronTriggers,
    };
  }
  const given = request.secrets ?? {};
  const unknown = Object.keys(given).filter((name) => !needed.some((s) => s.name === name));
  if (unknown.length > 0) {
    throw new VersionActionError(`This update does not take: ${unknown.join(", ")}.`);
  }
  const entered: Record<string, string> = {};
  for (const secret of needed) {
    const value = given[secret.name] ?? "";
    if (value.length === 0) {
      throw new VersionActionError(`${secret.label} (${secret.name}) is required.`);
    }
    entered[secret.name] = value;
  }
  const secrets = await withDerivedSecrets(catalog.secrets, entered);
  const rememberPaid =
    cronTriggers !== null && request.paidConfirmed === true && request.rememberPaidPlan === true;
  const jobId = (deps.newId ?? (() => ulid()))();
  return claim(deps, {
    installId: install.id,
    kind: "update",
    inputJson: JSON.stringify({
      installId: install.id,
      fromVersion: install.catalog_version,
      version: app.version,
      secrets: Object.keys(secrets),
      ...(sandbox === null ? {} : { sandboxBuild: true, buildConfirmed: true }),
    }),
    params: {
      kind: "update",
      jobId,
      installId: install.id,
      version: app.version,
      secrets,
      ...(sandbox === null
        ? {}
        : { buildConfirmed: true, confirmNoPreview: request.confirmNoPreview === true }),
      ...(cronTriggers === null ? {} : { paidConfirmed: request.paidConfirmed === true }),
    },
    // "Remember this for the account" beside a ticked Workers Paid
    // confirmation, recorded only once the job row exists: a refused start
    // changes nothing.
    ...(rememberPaid ? { afterClaim: (db) => writeAccountPlan(db, "paid") } : {}),
  });
}

/**
 * An update of a self-deploying app: its own installer deploys the new pin
 * over the installed one. The admin confirms the run's cost and gives values
 * for secrets the new version introduces; there is no preview check and no
 * snapshot.
 */
async function startSelfDeployingUpdate(
  deps: StartUpdateDeps,
  request: StartUpdateRequest,
  install: typeof installs.$inferSelect,
  app: IndexApp,
  installer: IndexBuild | null,
): Promise<StartUpdateResult> {
  if (installer === null || install.build_kind !== "self-deploying") {
    throw new VersionActionError(
      `${app.name} changed how it is installed (${install.build_kind === "self-deploying" ? "it no longer ships its own installer" : "it now ships its own installer"}). Uninstall it and install it again.`,
    );
  }
  if (deps.sandboxConnected !== true) {
    throw new VersionActionError(
      `${app.name} is deployed by its own installer in this account's sandbox Worker, and Appflare is not connected to one. Connect sandbox builds in Settings first.`,
    );
  }
  if (deps.loadCatalog === undefined) {
    throw new VersionActionError(`Appflare cannot update ${app.tier} tier apps here.`);
  }
  const catalog = await deps.loadCatalog(app);
  const recordedSecrets = await createDb(deps.db)
    .select({ name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, install.id),
        eq(resources.kind, "secret"),
        isNull(resources.deleted_at),
      ),
    );
  // A derived secret the Worker lacks asks for its source.
  const needed = secretsToAskFor(
    catalog.secrets,
    missingSecrets(
      catalog.secrets,
      recordedSecrets.map((r) => r.name),
    ),
  );
  if ((needed.length > 0 && request.secrets === undefined) || request.buildConfirmed !== true) {
    return {
      version: app.version,
      needsSecrets: needed,
      skipsPreview: null,
      build: installer,
      selfDeploying: true,
      // The app's own installer sets its cron triggers; Appflare never does.
      cronTriggers: null,
    };
  }
  const given = request.secrets ?? {};
  const unknown = Object.keys(given).filter((name) => !needed.some((s) => s.name === name));
  if (unknown.length > 0) {
    throw new VersionActionError(`This update does not take: ${unknown.join(", ")}.`);
  }
  const entered: Record<string, string> = {};
  for (const secret of needed) {
    const value = given[secret.name] ?? "";
    if (value.length === 0) {
      throw new VersionActionError(`${secret.label} (${secret.name}) is required.`);
    }
    entered[secret.name] = value;
  }
  const secrets = await withDerivedSecrets(catalog.secrets, entered);
  const appToken = request.appToken?.trim();
  const jobId = (deps.newId ?? (() => ulid()))();
  return claim(deps, {
    installId: install.id,
    kind: "update",
    inputJson: JSON.stringify({
      installId: install.id,
      fromVersion: install.catalog_version,
      version: app.version,
      secrets: Object.keys(secrets),
      selfDeploying: true,
      buildConfirmed: true,
      appTokenReplaced: appToken !== undefined && appToken.length > 0,
      sandboxRun: installerRunId("deploy", app.version),
    }),
    params: {
      kind: "update",
      jobId,
      installId: install.id,
      version: app.version,
      secrets,
      selfDeploying: true,
      buildConfirmed: true,
      ...(appToken === undefined || appToken.length === 0 ? {} : { appToken }),
    },
  });
}

/**
 * For a sandbox tier update: why its new version will likely have no preview
 * check, judged by the installed version, or null.
 */
function expectedSkipPreview(manifestJson: string | null, doTag: string | null): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson ?? "null");
  } catch {
    return null;
  }
  const manifest = artifactManifestSchema.safeParse(parsed);
  if (!manifest.success) return null;
  return updatePath(manifest.data, doTag ?? lastDurableObjectTagOf(manifestJson)).skipPreview;
}

/** Starts a rollback to a snapshot of this install. */
export async function startRollbackCore(
  deps: StartJobDeps<RollbackJobParams>,
  request: { installId: string; snapshotId: string },
): Promise<{ jobId: string }> {
  const install = await readInstall(deps.db, request.installId);
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw new VersionActionError(refusal);
  if (install.build_kind === "self-deploying") {
    throw new VersionActionError(
      "This app is deployed by its own installer, which changes it in place: Appflare takes no snapshot of it and cannot roll it back. Update it to a newer version, or restore its data with the app's own tools.",
    );
  }
  const [snapshot] = await createDb(deps.db)
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.id, request.snapshotId), eq(snapshots.install_id, install.id)))
    .limit(1);
  if (snapshot === undefined) {
    throw new VersionActionError("That snapshot does not belong to this install.");
  }
  // An app of several Workers may have other Workers on another version
  // while the primary one runs the snapshot's (an update that failed between
  // promotions): the rollback puts them back.
  if (
    snapshot.worker_version_id === install.current_version_id &&
    otherWorkersMatch(snapshot.worker_versions_json, install.worker_versions_json)
  ) {
    throw new VersionActionError("The Worker already runs the version this snapshot recorded.");
  }
  const currentDoTag = install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json);
  if (
    snapshot.do_migration_tag !== currentDoTag ||
    otherDoTagsDiffer(snapshot.manifest_json, install.manifest_json, install.worker_name)
  ) {
    throw new VersionActionError(
      "This update changed the app's Durable Object classes, and Cloudflare refuses to roll a Worker back across such a change.",
    );
  }
  // Every Hyperdrive configuration the version binds must still exist. A
  // snapshot taken before they were recorded is checked by the job, which
  // reads the version itself.
  const lost = hyperdriveRollbackRefusal(
    parseSnapshotHyperdrive(snapshot.hyperdrive_json) ?? {},
    await liveHyperdriveIds(createDb(deps.db), install.id),
  );
  if (lost !== null) throw new VersionActionError(lost);
  const jobId = (deps.newId ?? (() => ulid()))();
  return claim(deps, {
    installId: install.id,
    kind: "rollback",
    inputJson: JSON.stringify({
      installId: install.id,
      snapshotId: snapshot.id,
      workerVersionId: snapshot.worker_version_id,
      toVersion: snapshot.catalog_version,
    }),
    params: { kind: "rollback", jobId, installId: install.id, snapshotId: snapshot.id },
  });
}

export interface RestoreDatabaseDeps {
  db: D1Database;
  /** The Workflow binding, to settle a self-update whose instance died before refusing to start. */
  workflows?: WorkflowLookup;
  /** `d1.restore(databaseId, { bookmark })`, reporting each API call to `onRequest`. */
  restore(
    databaseId: string,
    bookmark: string,
    onRequest: (entry: RequestLog) => void,
  ): Promise<D1TimeTravelRestore>;
  now?: () => Date;
  newId?: () => string;
}

export interface RestoreDatabaseRequest {
  installId: string;
  snapshotId: string;
  databaseResourceId: string;
}

export interface RestoreDatabaseResult {
  jobId: string;
  databaseName: string;
  bookmark: string;
  /** Restoring to this bookmark undoes the restore. */
  previousBookmark: string | null;
}

/**
 * Restores one D1 database of the install to the Time Travel bookmark a
 * snapshot took, as an explicit admin action (a rollback never touches data).
 * It is recorded as a `rollback` job with `restore: true` in its input and log,
 * so the install's history shows it; the job has no Workflow instance because
 * the restore is a single API call made here. The result's `previous_bookmark`
 * is logged and returned, so the restore can itself be undone.
 */
export async function restoreDatabaseCore(
  deps: RestoreDatabaseDeps,
  request: RestoreDatabaseRequest,
): Promise<RestoreDatabaseResult> {
  await refuseDuringSelfUpdate(deps.db, deps.workflows, (m) => new VersionActionError(m));
  const orm = createDb(deps.db);
  const now = deps.now ?? (() => new Date());
  const install = await readInstall(deps.db, request.installId);
  const refusal = statusRefusal(install.status);
  if (refusal !== null) throw new VersionActionError(refusal);
  const [snapshot] = await orm
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.id, request.snapshotId), eq(snapshots.install_id, install.id)))
    .limit(1);
  if (snapshot === undefined) {
    throw new VersionActionError("That snapshot does not belong to this install.");
  }
  const [database] = await orm
    .select()
    .from(resources)
    .where(and(eq(resources.id, request.databaseResourceId), eq(resources.install_id, install.id)))
    .limit(1);
  if (
    database === undefined ||
    database.kind !== "d1" ||
    database.cf_id === null ||
    database.deleted_at !== null ||
    database.retained_at !== null
  ) {
    throw new VersionActionError("That is not a D1 database of this install.");
  }
  const databaseId = database.cf_id;
  const bookmark = parseBookmarks(snapshot.d1_bookmarks_json)[databaseId];
  if (bookmark === undefined) {
    throw new VersionActionError(`The snapshot has no bookmark for ${database.name}.`);
  }

  const jobId = (deps.newId ?? (() => ulid()))();
  const startedAt = now();
  const input = {
    restore: true,
    installId: install.id,
    snapshotId: snapshot.id,
    databaseResourceId: database.id,
    databaseId,
    databaseName: database.name,
    bookmark,
  };
  // The job row is the claim: no restore runs next to another job of the install.
  const claimed = await deps.db
    .prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at)
       SELECT ?1, ?2, 'rollback', 'running', ?3, ?4
       WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status = 'installed')
         AND NOT EXISTS (
           SELECT 1 FROM jobs WHERE install_id = ?2 AND status IN ('queued', 'running')
         )
         AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
    )
    .bind(jobId, install.id, JSON.stringify(input), startedAt.getTime())
    .run();
  if (claimed.meta.changes !== 1) {
    const selfUpdate = await activeSelfJob(deps.db);
    throw new VersionActionError(selfUpdate === null ? BUSY : selfUpdateBusyMessage(selfUpdate));
  }

  const log = new StepLog(() => now().getTime());
  log.info(
    `Restoring D1 database ${database.name} to the bookmark taken ${snapshot.taken_at.toISOString()} (${bookmark}).`,
    { restore: true, databaseId, bookmark },
  );
  // Written before the call, so the history names the bookmark even if this
  // request dies while Cloudflare restores.
  await log.flush(deps.db, jobId);
  let result: D1TimeTravelRestore;
  try {
    result = await deps.restore(databaseId, bookmark, log.onRequest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Restore failed: ${message}`, { restore: true });
    await log.flush(deps.db, jobId);
    await orm
      .update(jobs)
      .set({
        status: "failed",
        error: `restore D1 ${database.name}: ${message}`,
        finished_at: now(),
      })
      .where(eq(jobs.id, jobId));
    throw new VersionActionError(`Cloudflare did not restore ${database.name}: ${message}`);
  }
  const previousBookmark = result.previous_bookmark ?? null;
  log.info(
    previousBookmark === null
      ? `Restored ${database.name} to ${result.bookmark}.`
      : `Restored ${database.name} to ${result.bookmark}. To undo this, restore it to ${previousBookmark}.`,
    { restore: true, bookmark: result.bookmark, previous_bookmark: previousBookmark },
  );
  // The undo bookmark is written at once, before anything else can fail.
  await log.flush(deps.db, jobId);
  await orm
    .update(jobs)
    .set({ status: "succeeded", finished_at: now(), error: null })
    .where(eq(jobs.id, jobId));
  return { jobId, databaseName: database.name, bookmark: result.bookmark, previousBookmark };
}

export interface SnapshotView {
  id: string;
  /** ISO 8601 */
  takenAt: string;
  /** The Worker version that served before the update (what a rollback redeploys). */
  fromVersionId: string;
  /** The version the update uploaded; null when it failed before the upload. */
  toVersionId: string | null;
  fromCatalogVersion: string | null;
  toCatalogVersion: string | null;
  /** The update job that took it, and how it ended. */
  jobId: string;
  jobStatus: string | null;
  /** `update`, or `reconfigure` for a settings change (same catalog version). */
  jobKind: string | null;
  /** Whether the Worker runs this snapshot's version now (no rollback to offer). */
  isCurrent: boolean;
  /**
   * The snapshot holds the code installed now (a settings change of this
   * version): a rollback only puts back settings and secrets.
   */
  sameCode: boolean;
  /**
   * The update changed Durable Object classes (the snapshot's migration tag
   * differs from the Worker's): those changes stay after a rollback.
   */
  crossesDoMigration: boolean;
  /**
   * Why a rollback to this snapshot is refused because its version binds a
   * Hyperdrive configuration that has been deleted since; null when it can
   * reach its databases (or recorded none).
   */
  lostDatabase: string | null;
  /** D1 databases of the install this snapshot holds a bookmark for (bookmarks for admins only). */
  databases: Array<{
    resourceId: string;
    name: string;
    databaseId: string;
    bookmark: string | null;
  }>;
}

/** The install's snapshots, newest first. Bookmarks are left out unless `withBookmarks`. */
export async function listSnapshotsCore(
  db: D1Database,
  installId: string,
  opts: { withBookmarks: boolean } = { withBookmarks: true },
): Promise<SnapshotView[]> {
  const orm = createDb(db);
  const [install] = await orm
    .select({
      currentVersionId: installs.current_version_id,
      doMigrationTag: installs.do_migration_tag,
      manifestJson: installs.manifest_json,
      workerName: installs.worker_name,
      workerVersionsJson: installs.worker_versions_json,
      catalogVersion: installs.catalog_version,
      artifactDigest: installs.artifact_digest,
    })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) return [];
  const rows = await orm
    .select()
    .from(snapshots)
    .where(eq(snapshots.install_id, installId))
    .orderBy(desc(snapshots.taken_at), desc(snapshots.id));
  if (rows.length === 0) return [];
  const [jobRows, databases] = await Promise.all([
    orm
      .select({
        id: jobs.id,
        kind: jobs.kind,
        status: jobs.status,
        versionId: jobs.worker_version_id,
      })
      .from(jobs)
      .where(
        inArray(
          jobs.id,
          rows.map((r) => r.job_id),
        ),
      ),
    orm
      .select()
      .from(resources)
      .where(and(eq(resources.install_id, installId), eq(resources.kind, "d1"))),
  ]);
  const liveConfigs = await liveHyperdriveIds(orm, installId);
  const jobById = new Map(jobRows.map((j) => [j.id, j]));
  const currentDoTag = install.doMigrationTag ?? lastDurableObjectTagOf(install.manifestJson);
  const liveDatabases = databases.filter(
    (d) => d.cf_id !== null && d.deleted_at === null && d.retained_at === null,
  );
  return rows.map((row) => {
    const job = jobById.get(row.job_id);
    const bookmarks = parseBookmarks(row.d1_bookmarks_json);
    return {
      id: row.id,
      takenAt: row.taken_at.toISOString(),
      fromVersionId: row.worker_version_id,
      toVersionId: job?.versionId ?? null,
      fromCatalogVersion: row.catalog_version,
      toCatalogVersion: row.target_catalog_version,
      jobId: row.job_id,
      jobStatus: job?.status ?? null,
      jobKind: job?.kind ?? null,
      isCurrent:
        row.worker_version_id === install.currentVersionId &&
        otherWorkersMatch(row.worker_versions_json, install.workerVersionsJson),
      sameCode: snapshotHasSameCode(
        { catalogVersion: row.catalog_version, artifactDigest: row.artifact_digest },
        install,
      ),
      crossesDoMigration:
        row.do_migration_tag !== currentDoTag ||
        otherDoTagsDiffer(row.manifest_json, install.manifestJson, install.workerName),
      lostDatabase: hyperdriveRollbackRefusal(
        parseSnapshotHyperdrive(row.hyperdrive_json) ?? {},
        liveConfigs,
      ),
      databases: liveDatabases.flatMap((d) => {
        const bookmark = d.cf_id === null ? undefined : bookmarks[d.cf_id];
        return d.cf_id === null || bookmark === undefined
          ? []
          : [
              {
                resourceId: d.id,
                name: d.name,
                databaseId: d.cf_id,
                bookmark: opts.withBookmarks ? bookmark : null,
              },
            ];
      }),
    };
  });
}
