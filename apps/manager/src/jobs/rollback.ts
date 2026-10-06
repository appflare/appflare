import { NonRetryableError } from "cloudflare:workflows";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  boundToWorker,
  type CatalogEmailRouting,
  DEFAULT_HEALTH_MODE,
  secretKey,
} from "@appflare/schema";
import { and, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import { writeAcceptedBypass } from "../access/accepted-paths.server";
import { readAccessPlaceholderValues } from "../access/placeholder-values.server";
import { storedBypassPaths, storedCatalogAccess } from "../access/stored-access.server";
import { readAccountPlan } from "../account/plan.server";
import { effectiveAutoUpdate, settingOn } from "../auto-update/auto-update";
import { type StoredRelease, storedEffectiveManifest } from "../catalog/revisions.server";
import { appPlace } from "../components/app-links";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources, snapshots } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { emailRoutingChangeNote, emailRoutingOfManifest } from "../installs/email-routing";
import { type VarsRefreshReason, varsNeedRefresh } from "../installs/install-vars";
import { ADDRESS_KINDS, HYPERDRIVE_KINDS, QUEUE_CONSUMER_KIND } from "../installs/resource-kinds";
import {
  rollbackFinishMessage,
  rollbackStartMessage,
  snapshotHasSameCode,
} from "../installs/rollback-copy";
import { appBaseUrl, domainHostnames } from "../installs/workers-dev";
import {
  entryWorkers,
  mergedWorkerVersions,
  parseWorkerVersions,
  storedOtherWorkers,
  workerLabel,
} from "./entry-workers";
import { accessValuesRefreshPhase, publicPathsBackPhase, syncAccessPhase } from "./install/access";
import {
  deployOtherWorkerVersionPhase,
  otherWorkerRoutePhase,
  setOtherWorkerCronsPhase,
} from "./install/entry-worker-phases";
import { healthCheckOfManifest, healthColumns, healthLabel } from "./install/health";
import {
  checkLiveHealthPhase,
  lookupSubdomainPhase,
  resourceId,
  syncCronsPhase,
} from "./install/phases";
import {
  consumerPlans,
  consumerPlansOf,
  recordedQueues,
  syncQueueConsumersPhase,
} from "./install/queue-consumers";
import {
  putWorkflowsPhase,
  scheduledWorkflowsLeft,
  scheduledWorkflowsOf,
  unscheduleWorkflowPhase,
  type WorkflowTarget,
  workflowTargets,
} from "./install/workflows";
import {
  liveHyperdriveIds,
  reconcileHyperdriveRecords,
  versionHyperdriveBindings,
} from "./reconfigure/hyperdrive";
import { parseStoredVars } from "./reconfigure/plan";
import type { JobContext } from "./run-job";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError, type JobSteps } from "./steps";
import {
  describeValues,
  readAppAddress,
  settingsRefreshPhase,
  staleAddressValues,
} from "./update/address-settings";
import { changeEmailRoutingPhase, readEmailRouteRows } from "./update/email-routing";
import {
  accessUpdateRefusal,
  declaredLifecycleOf,
  hyperdriveRollbackRefusal,
  rollbackLifecycleWarnings,
} from "./update/plan";

/**
 * The `rollback` job: redeploys the Worker version a snapshot recorded, at
 * 100% of traffic, and puts the install's catalog state (version, manifest,
 * artifact) back to what it was when the snapshot was taken. D1 databases are
 * not touched: restoring data is a separate, explicit action on the install
 * page. Neither are the lifecycle rules an update put on an R2 bucket; the
 * log names those the version it returns to does not declare. Email Routing
 * follows the version once it serves, as after an update
 * (./update/email-routing.ts), and settings uploaded with another address
 * than the app has now are deployed again (./update/address-settings.ts).
 * The install is `updating` while the job runs and returns to
 * `installed` whatever happens.
 */

export const rollbackJobParams = z.object({
  kind: z.literal("rollback"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  snapshotId: z.string().min(1),
});
export type RollbackJobParams = z.infer<typeof rollbackJobParams>;

function parseManifest(manifestJson: string | null): ArtifactManifest | null {
  if (manifestJson === null) return null;
  try {
    const parsed = artifactManifestSchema.safeParse(JSON.parse(manifestJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function cronsOf(manifestJson: string | null): string[] | null {
  return parseManifest(manifestJson)?.worker.crons ?? null;
}

/**
 * The settings the snapshot's version runs with, when the snapshot recorded
 * them: a rollback across a settings change must show the values that serve
 * again. Snapshots taken before settings were recorded leave them as they are.
 */
function settingsOf(snapshot: { config_json: string | null }): { config_json?: string } {
  return snapshot.config_json === null ? {} : { config_json: snapshot.config_json };
}

/** The versions the snapshot kept for the app's other Workers, merged into the install's record. */
function othersOf(snapshot: { worker_versions_json: string | null }): {
  worker_versions_json?: SQL;
} {
  const versions = parseWorkerVersions(snapshot.worker_versions_json);
  return Object.keys(versions).length === 0
    ? {}
    : { worker_versions_json: mergedWorkerVersions(versions) };
}

/** The names of a version's `secret_text` bindings, from `GET .../versions/{id}`. */
export function versionSecretNames(version: { resources?: Record<string, unknown> }): string[] {
  const bindings = version.resources?.bindings;
  if (!Array.isArray(bindings)) return [];
  const names = new Set<string>();
  for (const b of bindings) {
    if (typeof b !== "object" || b === null) continue;
    const { type, name } = b as { type?: unknown; name?: unknown };
    if (type === "secret_text" && typeof name === "string") names.add(name);
  }
  return [...names].sort();
}

/** The var bindings (`plain_text`, `json`) of a version, from `GET .../versions/{id}`. */
function versionVarBindings(version: { resources?: Record<string, unknown> }): unknown[] {
  const bindings = version.resources?.bindings;
  if (!Array.isArray(bindings)) return [];
  return bindings.filter((b: unknown) => {
    const type = typeof b === "object" && b !== null ? (b as { type?: unknown }).type : undefined;
    return type === "plain_text" || type === "json";
  });
}

/** One Worker's part in reconciling the install's secret records after a rollback. */
export interface SecretReading {
  primary: boolean;
  /** The `secret_text` names of the version it serves now; null when they could not be read. */
  names: readonly string[] | null;
  /** The catalog secrets that go to it, by key, with the name it reads each by. */
  secrets: ReadonlyArray<{ key: string; name: string }>;
}

/**
 * Makes the install's secret records name the secrets the versions serving
 * now have: a version carries its own secrets, so rolling back brings back
 * one removed since and drops one added since. Records go by key (`name`),
 * holding the name the Worker reads (`binding`). Each catalog secret is
 * checked against the Workers that get it (live when any of them has it); a
 * record no Worker's secrets declare is the primary Worker's, by its name.
 * Records of secrets only Workers whose version could not be read get are
 * left as they are. Records of secrets a version has are live again (created
 * when missing, under the key the catalog gives the secret); the others are
 * marked deleted.
 */
export async function reconcileSecretRecords(
  orm: Database,
  installId: string,
  readings: readonly SecretReading[],
  at: Date,
): Promise<{ restored: string[]; absent: string[] }> {
  const rows = await orm
    .select({
      id: resources.id,
      name: resources.name,
      binding: resources.binding,
      deletedAt: resources.deleted_at,
    })
    .from(resources)
    .where(and(eq(resources.install_id, installId), eq(resources.kind, "secret")));
  /** Whether each declared key is on a Worker that gets it; absent when none was read. */
  const live = new Map<string, boolean>();
  const nameOf = new Map<string, string>();
  for (const reading of readings) {
    for (const secret of reading.secrets) {
      nameOf.set(secret.key, secret.name);
      if (reading.names === null) continue;
      live.set(secret.key, (live.get(secret.key) ?? false) || reading.names.includes(secret.name));
    }
  }
  const primary = readings.find((r) => r.primary);
  const primaryNames = primary?.names ?? null;
  const verdict = (key: string, read: string): boolean | undefined => {
    if (nameOf.has(key)) return live.get(key);
    return primaryNames === null ? undefined : primaryNames.includes(read);
  };
  const restored: string[] = [];
  const absent: string[] = [];
  for (const row of rows) {
    const has = verdict(row.name, row.binding ?? row.name);
    if (has === true && row.deletedAt !== null) {
      await orm.update(resources).set({ deleted_at: null }).where(eq(resources.id, row.id));
      restored.push(row.name);
    } else if (has === false && row.deletedAt === null) {
      await orm.update(resources).set({ deleted_at: at }).where(eq(resources.id, row.id));
      absent.push(row.name);
    }
  }
  const recorded = new Set(rows.map((r) => r.name));
  const missing: Array<{ key: string; name: string }> = [...live]
    .filter(([key, has]) => has && !recorded.has(key))
    .map(([key]) => ({ key, name: nameOf.get(key) ?? key }));
  // A secret the primary Worker's version has that no catalog secret or record names.
  const known = new Set([
    ...(primary?.secrets ?? []).map((s) => s.name),
    ...rows.map((r) => r.binding ?? r.name),
  ]);
  for (const name of primaryNames ?? []) {
    if (!known.has(name) && !recorded.has(name)) missing.push({ key: name, name });
  }
  for (const { key, name } of missing) {
    await orm
      .insert(resources)
      .values({
        id: resourceId(installId, "secret", key),
        install_id: installId,
        kind: "secret",
        binding: name,
        name: key,
        cf_id: null,
        created_at: at,
      })
      .onConflictDoNothing();
    restored.push(key);
  }
  return { restored: restored.sort(), absent: absent.sort() };
}

/**
 * After a rollback, the cron must not move the app straight back to the
 * version the admin just left: its automatic updates are turned off when
 * they were on (by its own choice or the account default). True when this
 * changed the install's choice.
 */
export async function turnOffAutoUpdate(orm: Database, installId: string): Promise<boolean> {
  const [row] = await orm
    .select({ choice: installs.auto_update })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (row === undefined) return false;
  const defaults = await readSettings(orm, [SETTING.autoUpdateApps]);
  if (!effectiveAutoUpdate(row.choice, settingOn(defaults.auto_update_apps))) return false;
  await orm.update(installs).set({ auto_update: "off" }).where(eq(installs.id, installId));
  return true;
}

/** What a rollback does about Cloudflare Access, read when it starts. */
interface RollbackAccessPlan {
  /** Appflare protects the app now. */
  protected: boolean;
  /** The serving version's public paths that the snapshot's version keeps. */
  sharedPaths: string[];
  /** The snapshot's version drops some of the serving version's public paths. */
  dropsPaths: boolean;
  /**
   * The snapshot's version's settings use the Access placeholders and were
   * deployed with another protection than the app has now (or one not
   * recorded), so they are deployed again with the current values.
   */
  refreshValues: boolean;
}

/** An install's or a snapshot's record of its release, as the stored-release helpers read it. */
function storedRelease(row: {
  manifest_json: string | null;
  artifact_digest: string | null;
}): StoredRelease {
  return { manifestJson: row.manifest_json, artifactDigest: row.artifact_digest };
}

async function rollbackAccessPlan(
  orm: Database,
  installId: string,
  install: {
    manifest_json: string | null;
    artifact_digest: string | null;
    config_json: string | null;
    worker_name: string;
  },
  snapshot: {
    manifest_json: string | null;
    artifact_digest: string | null;
    config_json: string | null;
    access_aud: string | null;
  },
): Promise<RollbackAccessPlan> {
  const current = await readAccessPlaceholderValues(orm, installId);
  // Each version's entry as the newest revision recorded for its release says.
  const before = await storedBypassPaths(orm, storedRelease(install));
  const after =
    snapshot.manifest_json === null
      ? before
      : await storedBypassPaths(orm, storedRelease(snapshot));
  const sharedPaths = before.filter((p) => after.includes(p));
  const manifest = await storedEffectiveManifest(
    orm,
    storedRelease(snapshot.manifest_json === null ? install : snapshot),
  );
  const vars = parseStoredVars(snapshot.config_json ?? install.config_json);
  const usesAccess =
    manifest !== null &&
    entryWorkers(manifest, install.worker_name).some((w) =>
      varsNeedRefresh(w.manifest, vars, ["access"]),
    );
  return {
    protected: current !== null,
    sharedPaths,
    dropsPaths: sharedPaths.length < before.length,
    refreshValues: usesAccess && snapshot.access_aud !== (current?.aud ?? ""),
  };
}

/**
 * Once the snapshot's version serves again: the address values (`appUrl`,
 * `wildcardHostname`) its settings were filled in with that differ from the
 * app's address now, read back from each Worker's version in `checks` (one
 * step and one request per Worker) and compared with the vars the install's
 * settings render to now. Never throws: a version that cannot be read is
 * a warning, and counts as current.
 */
async function staleAddressPhase(
  steps: JobSteps,
  installId: string,
  workerName: string,
  subdomain: string,
  checks: ReadonlyArray<{ scriptName: string; versionId: string }>,
  /** Var bindings of versions read already, by version id. */
  known: Readonly<Record<string, unknown[]>>,
): Promise<VarsRefreshReason[]> {
  const reasons = new Set<VarsRefreshReason>();
  for (const check of checks) {
    const found = await steps
      .run(`check the address settings of version ${check.versionId}`, async ({ log, cf, orm }) => {
        const none = { stale: [] as VarsRefreshReason[] };
        const [install] = await orm
          .select({
            manifest_json: installs.manifest_json,
            artifact_digest: installs.artifact_digest,
            config_json: installs.config_json,
          })
          .from(installs)
          .where(eq(installs.id, installId))
          .limit(1);
        if (install === undefined) return none;
        // The install records the snapshot's version and settings by now.
        const manifest = await storedEffectiveManifest(orm, storedRelease(install));
        const worker =
          manifest === null
            ? undefined
            : entryWorkers(manifest, workerName).find((w) => w.scriptName === check.scriptName);
        const address = await readAppAddress(orm, installId, subdomain);
        if (manifest === null || worker === undefined || address === null) return none;
        let deployed: unknown[];
        try {
          deployed =
            known[check.versionId] ??
            versionVarBindings(await cf().versions.getVersion(check.scriptName, check.versionId));
        } catch (error) {
          log.warn(
            `Could not read the settings of version ${check.versionId} (${errorMessage(error)}); if the app's address changed since it was deployed, save the app's settings to fill in the current one.`,
          );
          return none;
        }
        const stale = staleAddressValues({
          manifest,
          worker,
          userVars: parseStoredVars(install.config_json),
          workerName,
          subdomain,
          accountId: steps.accountId(),
          access: await readAccessPlaceholderValues(orm, installId),
          address,
          deployed,
        });
        if (stale.length > 0) {
          log.info(
            `Version ${check.versionId} of "${check.scriptName}" was deployed with another ${describeValues(stale)} than the app has now (${address.appUrl}).`,
          );
        }
        return { stale };
      })
      .catch(() => ({ stale: [] as VarsRefreshReason[] }));
    for (const reason of found.stale) reasons.add(reason);
  }
  return [...reasons];
}

export async function runRollback(ctx: JobContext): Promise<void> {
  const parsed = rollbackJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid rollback job payload");
  const params = parsed.data;
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;
  let deployed = false;
  // Public paths the snapshot's version drops were taken off Access: a
  // failure before its deployment puts them back.
  let narrowed = false;
  // The app's other Workers whose return to the snapshot's version started,
  // and those taken off workers.dev for it: a failure before the primary
  // Worker's deployment puts them back, so the app runs one version again.
  const movedOthers: string[] = [];
  const deployedOthers: string[] = [];
  const takenOffWorkersDev: string[] = [];
  let startedOthers: Array<{
    scriptName: string;
    versionId: string;
    /** Absent in a job started before it was recorded. */
    versionIdNow?: string | null;
  }> = [];
  let fromVersionLabel: string | null = null;
  let knownSubdomainForUndo: string | undefined;

  /**
   * The install's record once the snapshot's version serves: that version and
   * the catalog state the snapshot kept. The Durable Object migration tag is
   * left alone: a rollback never reverses migrations.
   */
  async function recordServing(orm: Database, at: Date): Promise<void> {
    const [snapshot] = await orm
      .select()
      .from(snapshots)
      .where(eq(snapshots.id, params.snapshotId))
      .limit(1);
    if (snapshot === undefined) return;
    // A rollback is an admin's action that carries the version's public
    // paths: a protected app's are accepted (nothing for one not protected).
    if (snapshot.manifest_json !== null) {
      await writeAcceptedBypass(
        orm,
        params.installId,
        await storedBypassPaths(orm, storedRelease(snapshot)),
      );
    }
    await orm
      .update(installs)
      .set(
        snapshot.catalog_version !== null && snapshot.artifact_url !== null
          ? {
              current_version_id: snapshot.worker_version_id,
              catalog_version: snapshot.catalog_version,
              manifest_json: snapshot.manifest_json,
              artifact_url: snapshot.artifact_url,
              artifact_digest: snapshot.artifact_digest,
              pin_sha: snapshot.pin_sha,
              build_kind: snapshot.build_kind,
              sandbox_image: snapshot.sandbox_image,
              built_at: snapshot.built_at,
              origin: snapshot.origin,
              source_url: snapshot.source_url,
              source_ref: snapshot.source_ref,
              ...settingsOf(snapshot),
              ...othersOf(snapshot),
              updated_at: at,
            }
          : {
              current_version_id: snapshot.worker_version_id,
              ...settingsOf(snapshot),
              ...othersOf(snapshot),
              updated_at: at,
            },
      )
      .where(eq(installs.id, params.installId));
    await orm
      .update(jobs)
      .set({ worker_version_id: snapshot.worker_version_id })
      .where(eq(jobs.id, params.jobId));
  }

  try {
    const started = await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const [install] = await orm
        .select()
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      if (install === undefined) throw new JobError("the install no longer exists");
      if (install.status !== "updating") {
        throw new JobError(`the install is ${install.status}, not being rolled back`);
      }
      const [snapshot] = await orm
        .select()
        .from(snapshots)
        .where(and(eq(snapshots.id, params.snapshotId), eq(snapshots.install_id, params.installId)))
        .limit(1);
      if (snapshot === undefined) {
        throw new JobError("the snapshot does not belong to this install");
      }
      const recordedRows = await orm
        .select({
          id: resources.id,
          kind: resources.kind,
          name: resources.name,
          live_at: resources.live_at,
        })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            inArray(resources.kind, ["cron", ...ADDRESS_KINDS]),
            isNull(resources.deleted_at),
          ),
        );
      const crons = recordedRows.filter((r) => r.kind === "cron");
      // Queue consumers belong to the script: the snapshot's version gets the
      // consumers it had.
      const queueRows = await orm
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            inArray(resources.kind, ["queue", QUEUE_CONSUMER_KIND]),
            isNull(resources.deleted_at),
          ),
        );
      // Any Hyperdrive configuration, live or deleted: the version may bind one.
      const [hyperdriveRow] = await orm
        .select({ id: resources.id })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            inArray(resources.kind, [...HYPERDRIVE_KINDS]),
          ),
        )
        .limit(1);
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      // The snapshot's version as the newest revision recorded for its
      // release says; null when the snapshot kept no readable manifest.
      const snapshotEffective =
        snapshot.manifest_json === null
          ? null
          : await storedEffectiveManifest(orm, storedRelease(snapshot));
      const servingEmail = emailRoutingOfManifest(install.manifest_json);
      const emailTarget =
        snapshotEffective === null
          ? null
          : (snapshotEffective.catalog.install.emailRouting ?? null);
      // Email Routing follows the version once it serves again (below).
      if (snapshotEffective !== null) {
        const emailChange = emailRoutingChangeNote(
          servingEmail,
          emailTarget,
          snapshot.catalog_version ?? "the snapshot's version",
        );
        if (emailChange !== null) log.info(emailChange);
      }
      // Each Worker of the snapshot's version whose settings use the app's
      // address, with the version it serves again: once it does, its
      // settings are compared with the address the app has now.
      const snapshotVars = parseStoredVars(snapshot.config_json ?? install.config_json);
      const snapshotOtherVersions = parseWorkerVersions(snapshot.worker_versions_json);
      const addressChecks =
        snapshotEffective === null
          ? []
          : entryWorkers(snapshotEffective, install.worker_name).flatMap((w) => {
              if (!varsNeedRefresh(w.manifest, snapshotVars, ["appUrl", "wildcardHostname"])) {
                return [];
              }
              const versionId = w.primary
                ? snapshot.worker_version_id
                : snapshotOtherVersions[w.scriptName];
              return versionId === undefined ? [] : [{ scriptName: w.scriptName, versionId }];
            });
      // Lifecycle rules an update merged into a bucket stay: a rollback
      // removes no rule, and the log names those the old version lacks.
      const leaving = declaredLifecycleOf(install.manifest_json);
      if (Object.keys(leaving.rules).length > 0) {
        const bucketRows = await orm
          .select({ binding: resources.binding, name: resources.name })
          .from(resources)
          .where(
            and(
              eq(resources.install_id, params.installId),
              eq(resources.kind, "r2"),
              isNull(resources.deleted_at),
            ),
          );
        const warnings = rollbackLifecycleWarnings({
          from: leaving,
          to: declaredLifecycleOf(snapshot.manifest_json),
          buckets: Object.fromEntries(
            bucketRows.flatMap((r) => (r.binding === null ? [] : [[r.binding, r.name]])),
          ),
          toVersion: snapshot.catalog_version ?? "the snapshot's version",
        });
        for (const warning of warnings) log.warn(warning);
      }
      const sameCode = snapshotHasSameCode(
        { catalogVersion: snapshot.catalog_version, artifactDigest: snapshot.artifact_digest },
        { catalogVersion: install.catalog_version, artifactDigest: install.artifact_digest },
      );
      log.info(
        rollbackStartMessage({
          workerName: install.worker_name,
          fromVersion: install.catalog_version,
          toVersion: snapshot.catalog_version,
          versionId: snapshot.worker_version_id,
          sameCode,
        }),
      );
      // An app of several Workers: the versions the snapshot kept for its
      // other Workers, and what each has now and had then.
      const otherNow = storedOtherWorkers(install.manifest_json, install.worker_name);
      const otherThen = storedOtherWorkers(snapshot.manifest_json, install.worker_name);
      const otherVersions = parseWorkerVersions(snapshot.worker_versions_json);
      const servingVersions = parseWorkerVersions(install.worker_versions_json);
      // The Workflows the snapshot's version defines, under the names the
      // install recorded: each goes back to that version's class.
      const snapshotManifest = parseManifest(snapshot.manifest_json);
      const workflowRows = await orm
        .select({ binding: resources.binding, name: resources.name })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            eq(resources.kind, "workflow"),
            isNull(resources.deleted_at),
          ),
        );
      const workflowNames: Record<string, string> = Object.fromEntries(
        workflowRows.flatMap((r) => (r.binding === null ? [] : [[r.binding, r.name]])),
      );
      const workflows: WorkflowTarget[] =
        snapshotManifest === null
          ? []
          : workflowTargets(snapshotManifest, install.worker_name, workflowNames);
      // Which secrets each Worker of the snapshot's version gets, by key,
      // with the keys only the serving version declares added to the Worker
      // that has them, so a rollback can tell which records each restored
      // version's secrets settle.
      const secretsOf = (json: string | null) => {
        const parsed = parseManifest(json);
        return parsed === null
          ? []
          : entryWorkers(parsed, install.worker_name).map((w) => ({
              scriptName: w.scriptName,
              secrets: boundToWorker(w.manifest.catalog.secrets).map((s) => ({
                key: secretKey(s),
                name: s.name,
              })),
            }));
      };
      const secretsThen = secretsOf(snapshot.manifest_json);
      const declaredThen = new Set(secretsThen.flatMap((w) => w.secrets.map((s) => s.key)));
      const secretsByWorker = secretsThen.map((w) => ({
        ...w,
        secrets: [
          ...w.secrets,
          ...(
            secretsOf(install.manifest_json).find((n) => n.scriptName === w.scriptName)?.secrets ??
            []
          ).filter((s) => !declaredThen.has(s.key)),
        ],
      }));
      return {
        accountId: settings.account_id,
        // Absent in a step output recorded before it was read: not known to be paid.
        accountPaid: (await readAccountPlan(orm)) === "paid",
        workerName: install.worker_name,
        fromVersion: install.catalog_version,
        secretsByWorker,
        otherWorkers: Object.entries(otherVersions).map(([scriptName, versionId]) => {
          const then = otherThen.find((w) => w.scriptName === scriptName);
          const now = otherNow.find((w) => w.scriptName === scriptName);
          return {
            scriptName,
            versionId,
            // What it serves now, to return to if the rollback fails before
            // the primary Worker's; null when the install's record has none.
            versionIdNow: servingVersions[scriptName] ?? null,
            // Whether the snapshot's version and the serving one keep the
            // Worker on workers.dev; null when the snapshot's is not known.
            workersDev: then?.workersDev ?? null,
            workersDevNow: now?.workersDev ?? true,
            crons: then?.manifest.worker.crons ?? null,
            cronsNow: now?.manifest.worker.crons ?? [],
            consumers:
              then === undefined ? null : consumerPlans(then.manifest.worker.queueConsumers),
            consumersNow: consumerPlans(now?.manifest.worker.queueConsumers),
          };
        }),
        sameCode,
        // Unknown (null) when the snapshot kept no readable manifest: Email
        // Routing is then left as it is (absent in a step output recorded before).
        email: (snapshotEffective === null
          ? null
          : {
              target: emailTarget,
              serving: servingEmail !== null,
              // Routes on record (absent in a step output recorded before).
              routes: (await readEmailRouteRows(orm, params.installId)).some((r) => !r.deleted),
            }) as
          | {
              target: CatalogEmailRouting | null;
              serving: boolean;
              routes?: boolean;
            }
          | null
          | undefined,
        addressChecks: addressChecks as
          | Array<{ scriptName: string; versionId: string }>
          | undefined,
        workflows: workflows as WorkflowTarget[] | undefined,
        // The Workflows the serving version runs on a schedule (absent in a
        // step output recorded before schedules were followed).
        scheduledWorkflows: scheduledWorkflowsOf(
          install.manifest_json,
          install.worker_name,
          workflowNames,
        ) as WorkflowTarget[] | undefined,
        usesHyperdrive: hyperdriveRow !== undefined,
        versionId: snapshot.worker_version_id,
        toVersion: snapshot.catalog_version,
        recordedCrons: crons.map((c) => c.name),
        snapshotCrons: cronsOf(snapshot.manifest_json),
        queueRows: queueRows.map((r) => ({
          id: r.id,
          kind: r.kind,
          binding: r.binding,
          name: r.name,
          cfId: r.cf_id,
        })),
        currentConsumers: consumerPlansOf(install.manifest_json),
        snapshotConsumers:
          parseManifest(snapshot.manifest_json) === null
            ? null
            : consumerPlansOf(snapshot.manifest_json),
        healthPath: healthCheckOfManifest(snapshot.manifest_json).path,
        healthMode: healthCheckOfManifest(snapshot.manifest_json).mode,
        workersDev: install.workers_dev_enabled,
        servedDomain: install.served_domain,
        domains: domainHostnames(recordedRows),
        // Cloudflare Access (absent in a step output recorded before it was read).
        access: await (async () => {
          const plan = await rollbackAccessPlan(orm, params.installId, install, snapshot);
          // Checked when the rollback starts too: a version that must run
          // behind Cloudflare Access never serves an unprotected app.
          const refusal = accessUpdateRefusal({
            catalog: await storedCatalogAccess(orm, storedRelease(snapshot)),
            isProtected: plan.protected,
            action: "roll back",
          });
          if (refusal !== null) throw new JobError(refusal);
          return plan;
        })(),
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName } = started;
    // An app of several Workers may need more requests than one invocation
    // makes on Workers Free: its steps then spread over invocations.
    if ((started.otherWorkers ?? []).length > 0 && started.accountPaid !== true) {
      steps.spreadOverInvocations();
    }

    // A version that binds a Hyperdrive configuration deleted since would
    // serve without its database: refuse before anything changes. Read from
    // the version itself, which also covers snapshots taken before their
    // configurations were recorded. A job started before this check has no
    // `usesHyperdrive` and skips it.
    if (started.usesHyperdrive === true) {
      await run("check the version's database connections", async ({ log, cf, orm }) => {
        const bound = versionHyperdriveBindings(
          await cf().versions.getVersion(workerName, started.versionId),
        );
        const refusal = hyperdriveRollbackRefusal(
          params.installId,
          Object.fromEntries(bound.map((b) => [b.binding, b.id])),
          await liveHyperdriveIds(orm, params.installId),
        );
        if (refusal !== null) throw new JobError(refusal);
        log.info(
          bound.length === 0
            ? `Version ${started.versionId} binds no Hyperdrive configuration.`
            : `Every Hyperdrive configuration version ${started.versionId} binds still exists.`,
        );
        return {};
      });
    }

    // A protected app's public paths the snapshot's version does not have
    // stop being public before any of its Workers serves it, or the rollback
    // fails here with nothing moved.
    const access = started.access;
    if (access?.protected === true && access.dropsPaths) {
      // A failure here is recorded for the cron by the phase itself.
      await syncAccessPhase(steps, params.installId, { bypassPaths: access.sharedPaths });
      narrowed = true;
    }

    // The app's other Workers first, each back on the version the snapshot
    // kept; the primary Worker last. A snapshot taken before other Workers
    // were recorded has none.
    const otherWorkers = started.otherWorkers ?? [];
    startedOthers = otherWorkers;
    fromVersionLabel = started.fromVersion;
    // Looked up once, when first needed.
    const subdomainOf = async () => {
      knownSubdomainForUndo ??= await lookupSubdomainPhase(steps);
      return knownSubdomainForUndo;
    };
    // Every Worker back on its version in one invocation, the primary one
    // last, so no wait for a fresh one leaves them on different versions for
    // minutes: a deployment each, the route of one the snapshot's version
    // keeps off workers.dev, and the subdomain lookup.
    await steps.reserve("the rollback", 2 * otherWorkers.length + 2, async () => {
      for (const other of otherWorkers) {
        // A Worker the snapshot's version keeps off workers.dev goes off it
        // before that version serves; one it puts back on, after (below).
        // Absent in a job started before the flag existed.
        if (other.workersDev === false) {
          const subdomain = await subdomainOf();
          // Listed before the step: a step that fails may still have turned it off.
          if (other.workersDevNow) takenOffWorkersDev.push(other.scriptName);
          await otherWorkerRoutePhase(
            steps,
            params.installId,
            { primary: false, scriptName: other.scriptName, workersDev: false },
            subdomain,
          );
        }
        movedOthers.push(other.scriptName);
        await deployOtherWorkerVersionPhase(
          steps,
          { primary: false, scriptName: other.scriptName },
          other.versionId,
          started.toVersion ?? started.versionId,
        );
        deployedOthers.push(other.scriptName);
      }

      // The API call is a step of its own, so the moment it returns the job
      // knows the snapshot's version serves traffic.
      await run("deploy snapshot version", async ({ log, cf }) => {
        // Forced: without it Cloudflare blocks a rollback to a version whose
        // secrets differ from the current ones (an update may have added one),
        // and the admin already confirmed this rollback explicitly.
        await cf().versions.createDeployment(workerName, {
          versions: [{ version_id: started.versionId, percentage: 100 }],
          annotations: {
            "workers/message": `Appflare: roll back to ${started.toVersion ?? started.versionId}`,
          },
          force: true,
        });
        log.info(
          `Version ${started.versionId} now serves all traffic (deployment forced, so a secret changed since that version does not block the rollback).`,
        );
        return {};
      });
      deployed = true;
    });
    // The version brought its own secrets back; the records follow them so
    // the install page lists what the Worker has. A failed read only warns.
    // The same read names the Hyperdrive configurations the version binds.
    const secretNames = await run("read the version's secrets", async ({ log, cf }) => {
      try {
        const version = await cf().versions.getVersion(workerName, started.versionId);
        const names = versionSecretNames(version);
        log.info(
          names.length === 0
            ? `Version ${started.versionId} has no secrets.`
            : `Version ${started.versionId} has the secrets ${names.join(", ")}.`,
        );
        // Its vars too when its settings use the app's address, for the
        // check once the rollback is done (no second read of the version).
        const primaryChecked = (started.addressChecks ?? []).some(
          (c) => c.versionId === started.versionId,
        );
        return {
          names,
          hyperdrive: versionHyperdriveBindings(version),
          ...(primaryChecked ? { vars: versionVarBindings(version) } : {}),
        };
      } catch (error) {
        log.warn(
          `Could not read the secrets of version ${started.versionId} (${errorMessage(error)}); the install's list of secrets may not match the Worker until its next settings change.`,
        );
        return { names: null };
      }
    });
    // The other Workers' versions carry their own secrets too: one read each
    // Worker that gets a catalog secret the primary Worker does not (the
    // primary's version settles the ones they share). A step output recorded
    // before secrets were placed per Worker has none.
    const byWorker = started.secretsByWorker;
    const otherReadings: SecretReading[] = [];
    if (byWorker !== undefined) {
      const primaryKeys = new Set(
        (byWorker.find((w) => w.scriptName === workerName)?.secrets ?? []).map((s) => s.key),
      );
      for (const other of otherWorkers) {
        const secrets = (
          byWorker.find((w) => w.scriptName === other.scriptName)?.secrets ?? []
        ).filter((s) => !primaryKeys.has(s.key));
        if (secrets.length === 0) continue;
        const read = await run(
          `read the version's secrets${workerLabel({ primary: false, scriptName: other.scriptName })}`,
          async ({ log, cf }) => {
            try {
              const names = versionSecretNames(
                await cf().versions.getVersion(other.scriptName, other.versionId),
              );
              log.info(
                names.length === 0
                  ? `Version ${other.versionId} of "${other.scriptName}" has no secrets.`
                  : `Version ${other.versionId} of "${other.scriptName}" has the secrets ${names.join(", ")}.`,
              );
              return { names };
            } catch (error) {
              log.warn(
                `Could not read the secrets of version ${other.versionId} of "${other.scriptName}" (${errorMessage(error)}); its secrets stay listed as they were.`,
              );
              return { names: null };
            }
          },
        );
        otherReadings.push({ primary: false, names: read.names, secrets });
      }
    }
    await run("record rollback", async ({ log, orm }) => {
      const at = new Date(now());
      await recordServing(orm, at);
      const readings: SecretReading[] = [
        {
          primary: true,
          names: secretNames.names,
          secrets: byWorker?.find((w) => w.scriptName === workerName)?.secrets ?? [],
        },
        ...otherReadings,
        // The keys of Workers the rollback did not touch, so the primary's
        // secrets never settle their records.
        ...(byWorker ?? [])
          .filter(
            (w) =>
              w.scriptName !== workerName &&
              !otherWorkers.some((o) => o.scriptName === w.scriptName),
          )
          .map((w) => ({ primary: false, names: null, secrets: w.secrets })),
      ];
      if (readings.some((r) => r.names !== null)) {
        const changed = await reconcileSecretRecords(orm, params.installId, readings, at);
        if (changed.restored.length > 0) {
          log.info(`Secrets back with this version: ${changed.restored.join(", ")}.`);
        }
        if (changed.absent.length > 0) {
          log.info(`Secrets this version does not have: ${changed.absent.join(", ")}.`);
        }
      }
      // A step result recorded before the field existed has no bindings to follow.
      const hyperdrive = "hyperdrive" in secretNames ? secretNames.hyperdrive : undefined;
      if (hyperdrive !== undefined && hyperdrive.length > 0) {
        const outcome = await reconcileHyperdriveRecords(orm, params.installId, hyperdrive);
        if (outcome.rebound.length > 0) {
          log.info(
            `Database connections back with this version: ${outcome.rebound.join(", ")} use the Hyperdrive configurations it binds again.`,
          );
        }
        if (outcome.missing.length > 0) {
          log.warn(
            `This version binds a Hyperdrive configuration Appflare has no live record of for ${outcome.missing.join(", ")}; the app may not reach that database. Replace its connection string under ${appPlace(params.installId, "databases", "Databases in the app's settings")}.`,
          );
        }
      }
      if (await turnOffAutoUpdate(orm, params.installId)) {
        log.info(
          `Automatic updates of this app are now off, so the cron does not update it to ${started.fromVersion} again. Turn them back on under ${appPlace(params.installId, "automatic-updates", "Automatic updates on the app's page")} once a fixed version is out.`,
        );
      }
      return {};
    });

    // Its Workflows back on its classes and settings (absent in a step
    // output recorded before Workflows were followed); a refusal is a
    // warning, as after an update's promotion. A Workflow only a newer
    // version defines is not in the snapshot's version: it stays, still
    // pointing at a class the older script lacks, and the uninstall deletes
    // it by name like every Workflow the install recorded. Nothing of the
    // older version starts it, but a schedule the newer one gave it would,
    // each instance failing: that schedule is taken off.
    await putWorkflowsPhase(
      steps,
      params.installId,
      started.workflows ?? [],
      () => false,
      "serving",
    );
    for (const wf of scheduledWorkflowsLeft(
      started.scheduledWorkflows ?? [],
      started.workflows ?? [],
    )) {
      await unscheduleWorkflowPhase(
        steps,
        params.installId,
        wf,
        started.toVersion === null ? "the snapshot's version" : `version ${started.toVersion}`,
      );
    }

    // The public paths of the snapshot's version, now that its manifest is recorded.
    if (access?.protected === true) await syncAccessPhase(steps, params.installId);

    // Null for a job started before consumers were tracked, or a snapshot
    // without a manifest: nothing is known to sync.
    if (started.snapshotConsumers != null) {
      for (const other of otherWorkers) {
        if (other.consumers === null) continue;
        await syncQueueConsumersPhase(steps, {
          installId: params.installId,
          workerName: other.scriptName,
          wanted: other.consumers,
          previous: other.consumersNow,
          queues: recordedQueues(params.installId, started.queueRows),
          recorded: started.queueRows,
          removeUnwanted: false,
        });
      }
      await syncQueueConsumersPhase(steps, {
        installId: params.installId,
        workerName,
        wanted: started.snapshotConsumers,
        previous: started.currentConsumers,
        queues: recordedQueues(params.installId, started.queueRows),
        recorded: started.queueRows,
        keepKeys: otherWorkers.flatMap((o) => (o.consumers ?? []).map((c) => c.queueKey)),
      });
    }

    // Cron triggers after the queue consumers: a refusal at the account's
    // limit is only a warning, and nothing after it depends on them.
    if (started.snapshotCrons !== null) {
      await syncCronsPhase(
        steps,
        params.installId,
        workerName,
        started.recordedCrons,
        started.snapshotCrons,
      );
    }
    for (const other of otherWorkers) {
      if (other.crons === null) continue;
      await setOtherWorkerCronsPhase(
        steps,
        { primary: false, scriptName: other.scriptName },
        other.crons,
        other.cronsNow,
      );
    }

    for (const other of otherWorkers) {
      if (other.workersDev === true && other.workersDevNow === false) {
        await otherWorkerRoutePhase(
          steps,
          params.installId,
          { primary: false, scriptName: other.scriptName, workersDev: true },
          await subdomainOf(),
        );
      }
    }

    // Email Routing to what the snapshot's version receives, now that it
    // serves again: the routes it has that the newer one dropped come back,
    // those only the newer one had go (absent in a step output recorded
    // before it was read, and unknown for a snapshot without a manifest).
    // Never throws: a part it cannot do is a warning for the next job.
    const email = started.email;
    if (email != null && (email.target !== null || email.serving || email.routes === true)) {
      await changeEmailRoutingPhase(steps, {
        installId: params.installId,
        workerName,
        target: email.target,
      });
    }

    const subdomain = await subdomainOf();
    const url = `${appBaseUrl({ workerName, subdomain, workersDev: started.workersDev, domains: started.domains, served: started.servedDomain })}${started.healthPath}`;
    // Recorded rather than fatal: the snapshot's version already serves. A
    // job started before health modes existed has none recorded.
    const health = await checkLiveHealthPhase(
      steps,
      step,
      url,
      started.healthMode ?? DEFAULT_HEALTH_MODE,
      { installId: params.installId },
    );

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({
            status: "installed",
            ...healthColumns(health, new Date(health.checkedAt)),
            updated_at: at,
          })
          .where(and(eq(installs.id, params.installId), eq(installs.status, "updating"))),
        orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: at, error: null })
          .where(eq(jobs.id, params.jobId)),
      ]);
      log.info(
        rollbackFinishMessage({
          fromVersion: started.fromVersion,
          toVersion: started.toVersion,
          versionId: started.versionId,
          sameCode: started.sameCode,
          url,
          health: healthLabel(health),
        }),
      );
      return {};
    });
    // The snapshot's version was deployed with the address the app had then
    // (or another protection than it has now): its settings get the current
    // values again, in one settings change. Never throws.
    const stale = await staleAddressPhase(
      steps,
      params.installId,
      workerName,
      subdomain,
      started.addressChecks ?? [],
      "vars" in secretNames && secretNames.vars !== undefined
        ? { [started.versionId]: secretNames.vars }
        : {},
    );
    if (stale.length > 0) {
      const withAccess = access?.refreshValues === true;
      await settingsRefreshPhase(
        steps,
        env,
        params.installId,
        withAccess ? ["access", ...stale] : stale,
        `This version's settings were filled in with another ${describeValues(stale)} than the app has now${withAccess ? ", and with another Cloudflare Access protection" : ""}`,
      );
    } else if (access?.refreshValues === true) {
      await accessValuesRefreshPhase(steps, env, params.installId);
    }
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    const wasDeployed = deployed;
    // The primary Worker still serves the version the rollback started from:
    // the other Workers already moved go back to the versions they served,
    // most recent first, so the app runs one version again. A Worker that
    // cannot go back serves the snapshot's version, and the record says so.
    const returned: string[] = [];
    // Serving the snapshot's version still, by Worker name; null when its
    // deployment did not finish either, so which version serves is unknown.
    const stranded: Record<string, string | null> = {};
    const routesBack: string[] = [];
    if (!wasDeployed) {
      // In one invocation, as the rollback's own deployments were.
      await steps.reserve("the return to the serving versions", movedOthers.length, async () => {
        for (const name of [...movedOthers].reverse()) {
          const other = startedOthers.find((o) => o.scriptName === name);
          if (other === undefined) continue;
          try {
            const back = other.versionIdNow ?? null;
            if (back === null) throw new Error("the install's record has no version of it");
            await deployOtherWorkerVersionPhase(
              steps,
              { primary: false, scriptName: name },
              back,
              fromVersionLabel ?? back,
              true,
            );
            returned.push(name);
          } catch {
            stranded[name] = deployedOthers.includes(name) ? other.versionId : null;
          }
        }
      });
      // A Worker taken off workers.dev for the snapshot's version gets its
      // address back, since the version it serves wants it: every one whose
      // step to turn it off started, unless it is left on the snapshot's
      // version (or on a version not known).
      const subdomain = knownSubdomainForUndo;
      for (const name of takenOffWorkersDev) {
        if (name in stranded) continue;
        try {
          if (subdomain === undefined) throw new Error("the workers.dev subdomain is not known");
          await otherWorkerRoutePhase(
            steps,
            params.installId,
            { primary: false, scriptName: name, workersDev: true },
            subdomain,
          );
        } catch {
          routesBack.push(name);
        }
      }
    }
    // The current version serves without the public paths taken off for
    // the snapshot's: the cron makes them public again.
    if (!wasDeployed && narrowed) await publicPathsBackPhase(steps, params.installId);
    const strandedNames = Object.keys(stranded);
    await step.do("mark rollback failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      // The snapshot's version serves traffic: the record says so even if the
      // step that writes it is the one that failed.
      if (wasDeployed) await recordServing(orm, at);
      await orm
        .update(installs)
        .set({
          status: "installed",
          // Other Workers that could not go back serve the snapshot's version.
          ...(strandedNames.length === 0
            ? {}
            : { worker_versions_json: mergedWorkerVersions(stranded) }),
          updated_at: at,
        })
        .where(and(eq(installs.id, params.installId), eq(installs.status, "updating")));
      const log = new StepLog(now);
      log.error(
        wasDeployed
          ? `Rollback failed at "${failedAt}" after the snapshot's version was deployed; it serves all traffic and is recorded as the install's version.`
          : movedOthers.length === 0
            ? `Rollback failed at "${failedAt}". Nothing was deployed; the current version keeps serving all traffic.`
            : `Rollback failed at "${failedAt}" before the app's own Worker was rolled back; it keeps serving the current version.`,
      );
      if (returned.length > 0) {
        log.error(
          `The app's Workers ${returned.map((n) => `"${n}"`).join(", ")} are back on the versions they served before the rollback, as the app's own Worker still serves the current version.`,
          { returned },
        );
      }
      if (strandedNames.length > 0) {
        log.error(
          `The app's Workers ${strandedNames.map((n) => `"${n}"`).join(", ")} may still serve the snapshot's version while the app's own Worker serves the current one. Roll back to this snapshot again from ${appPlace(params.installId, "versions", "the app's versions")}.`,
          { stranded: strandedNames },
        );
      }
      if (routesBack.length > 0) {
        log.error(
          `Appflare could not turn the workers.dev URL of ${routesBack.map((n) => `"${n}"`).join(", ")} back on for the version it serves; roll back again, or change the address under ${appPlace(params.installId, "workers-dev", "workers.dev URL on the app's page")}.`,
          { routesBack },
        );
      }
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
