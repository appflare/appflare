import { NonRetryableError } from "cloudflare:workflows";
import { type ArtifactManifest, artifactManifestSchema } from "@appflare/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { effectiveAutoUpdate, settingOn } from "../auto-update/auto-update";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources, snapshots } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { emailRoutingChangeWarning, emailRoutingOfManifest } from "../installs/email-routing";
import {
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  QUEUE_CONSUMER_KIND,
} from "../installs/resource-kinds";
import {
  rollbackFinishMessage,
  rollbackStartMessage,
  snapshotHasSameCode,
} from "../installs/rollback-copy";
import { appBaseUrl, domainHostnames } from "../installs/workers-dev";
import { healthCheckOfManifest, healthLabel } from "./install/health";
import {
  checkLiveHealthPhase,
  lookupSubdomainPhase,
  resourceId,
  syncCronsPhase,
} from "./install/phases";
import {
  consumerPlansOf,
  recordedQueues,
  syncQueueConsumersPhase,
} from "./install/queue-consumers";
import type { JobContext } from "./run-job";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError } from "./steps";

/**
 * The `rollback` job: redeploys the Worker version a snapshot recorded, at
 * 100% of traffic, and puts the install's catalog state (version, manifest,
 * artifact) back to what it was when the snapshot was taken. D1 databases are
 * not touched: restoring data is a separate, explicit action on the install
 * page. The install is `updating` while the job runs and returns to
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

/**
 * Makes the install's secret records name the secrets the version serving
 * now has: a version carries its own secrets, so rolling back brings back
 * one removed since and drops one added since. Records of secrets the version
 * has are live again (created when missing); the others are marked deleted.
 */
export async function reconcileSecretRecords(
  orm: Database,
  installId: string,
  names: readonly string[],
  at: Date,
): Promise<{ restored: string[]; absent: string[] }> {
  const rows = await orm
    .select({ id: resources.id, name: resources.name, deletedAt: resources.deleted_at })
    .from(resources)
    .where(and(eq(resources.install_id, installId), eq(resources.kind, "secret")));
  const has = new Set(names);
  const restored: string[] = [];
  const absent: string[] = [];
  for (const row of rows) {
    if (has.has(row.name) && row.deletedAt !== null) {
      await orm.update(resources).set({ deleted_at: null }).where(eq(resources.id, row.id));
      restored.push(row.name);
    } else if (!has.has(row.name) && row.deletedAt === null) {
      await orm.update(resources).set({ deleted_at: at }).where(eq(resources.id, row.id));
      absent.push(row.name);
    }
  }
  const recorded = new Set(rows.map((r) => r.name));
  for (const name of names) {
    if (recorded.has(name)) continue;
    await orm
      .insert(resources)
      .values({
        id: resourceId(installId, "secret", name),
        install_id: installId,
        kind: "secret",
        binding: name,
        name,
        cf_id: null,
        created_at: at,
      })
      .onConflictDoNothing();
    restored.push(name);
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

export async function runRollback(ctx: JobContext): Promise<void> {
  const parsed = rollbackJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid rollback job payload");
  const params = parsed.data;
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;
  let deployed = false;

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
              updated_at: at,
            }
          : {
              current_version_id: snapshot.worker_version_id,
              ...settingsOf(snapshot),
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
            inArray(resources.kind, ["cron", CUSTOM_DOMAIN_KIND, CUSTOM_HOSTNAME_KIND]),
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
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      // TODO: apply `install.emailRouting` changes between versions (create and
      // delete routing rules, take over or give back the catch-all). The zone the
      // admin chose and the records of what the install set up exist only from the
      // install; until an update can reconcile them, the job warns in its log and
      // leaves Email Routing as the install set it up.
      const emailChange = emailRoutingChangeWarning(
        emailRoutingOfManifest(install.manifest_json),
        emailRoutingOfManifest(snapshot.manifest_json),
        snapshot.catalog_version ?? "the snapshot's version",
      );
      if (emailChange !== null) log.warn(emailChange);
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
      return {
        accountId: settings.account_id,
        workerName: install.worker_name,
        fromVersion: install.catalog_version,
        sameCode,
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
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName } = started;

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
    // The version brought its own secrets back; the records follow them so
    // the install page lists what the Worker has. A failed read only warns.
    const secretNames = await run("read the version's secrets", async ({ log, cf }) => {
      try {
        const names = versionSecretNames(
          await cf().versions.getVersion(workerName, started.versionId),
        );
        log.info(
          names.length === 0
            ? `Version ${started.versionId} has no secrets.`
            : `Version ${started.versionId} has the secrets ${names.join(", ")}.`,
        );
        return { names };
      } catch (error) {
        log.warn(
          `Could not read the secrets of version ${started.versionId} (${errorMessage(error)}); the install's list of secrets may not match the Worker until its next settings change.`,
        );
        return { names: null };
      }
    });
    await run("record rollback", async ({ log, orm }) => {
      const at = new Date(now());
      await recordServing(orm, at);
      if (secretNames.names !== null) {
        const changed = await reconcileSecretRecords(orm, params.installId, secretNames.names, at);
        if (changed.restored.length > 0) {
          log.info(`Secrets back with this version: ${changed.restored.join(", ")}.`);
        }
        if (changed.absent.length > 0) {
          log.info(`Secrets this version does not have: ${changed.absent.join(", ")}.`);
        }
      }
      if (await turnOffAutoUpdate(orm, params.installId)) {
        log.info(
          `Automatic updates of this app are now off, so the cron does not update it to ${started.fromVersion} again. Turn them back on on the app's page once a fixed version is out.`,
        );
      }
      return {};
    });

    // Null for a job started before consumers were tracked, or a snapshot
    // without a manifest: nothing is known to sync.
    if (started.snapshotConsumers != null) {
      await syncQueueConsumersPhase(steps, {
        installId: params.installId,
        workerName,
        wanted: started.snapshotConsumers,
        previous: started.currentConsumers,
        queues: recordedQueues(params.installId, started.queueRows),
        recorded: started.queueRows,
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

    const subdomain = await lookupSubdomainPhase(steps);
    const url = `${appBaseUrl({ workerName, subdomain, workersDev: started.workersDev, domains: started.domains, served: started.servedDomain })}${started.healthPath}`;
    // Recorded rather than fatal: the snapshot's version already serves. A
    // job started before health modes existed has none recorded.
    const health = await checkLiveHealthPhase(steps, step, url, started.healthMode ?? "default");

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({
            status: "installed",
            health_status: health.status,
            health_checked_at: new Date(health.checkedAt),
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
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    const wasDeployed = deployed;
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
        .set({ status: "installed", updated_at: at })
        .where(and(eq(installs.id, params.installId), eq(installs.status, "updating")));
      const log = new StepLog(now);
      log.error(
        wasDeployed
          ? `Rollback failed at "${failedAt}" after the snapshot's version was deployed; it serves all traffic and is recorded as the install's version.`
          : `Rollback failed at "${failedAt}". Nothing was deployed; the current version keeps serving all traffic.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
