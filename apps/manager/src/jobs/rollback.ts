import { NonRetryableError } from "cloudflare:workflows";
import { type ArtifactManifest, artifactManifestSchema } from "@appflare/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources, snapshots } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { emailRoutingChangeWarning, emailRoutingOfManifest } from "../installs/email-routing";
import { QUEUE_CONSUMER_KIND } from "../installs/resource-kinds";
import { healthCheckOfManifest, healthLabel } from "./install/health";
import { checkLiveHealthPhase, lookupSubdomainPhase, syncCronsPhase } from "./install/phases";
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
              updated_at: at,
            }
          : { current_version_id: snapshot.worker_version_id, updated_at: at },
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
      const crons = await orm
        .select({ name: resources.name })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            eq(resources.kind, "cron"),
            isNull(resources.deleted_at),
          ),
        );
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
      log.info(
        `Rolling back Worker "${install.worker_name}" from ${install.catalog_version} to ${snapshot.catalog_version ?? "the snapshot's version"} (version ${snapshot.worker_version_id}). D1 databases are not changed.`,
      );
      return {
        accountId: settings.account_id,
        workerName: install.worker_name,
        fromVersion: install.catalog_version,
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
    await run("record rollback", async ({ orm }) => {
      await recordServing(orm, new Date(now()));
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
    const url = `https://${workerName}.${subdomain}.workers.dev${started.healthPath}`;
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
        `Rolled back from ${started.fromVersion} to ${started.toVersion ?? started.versionId} at ${url} (health: ${healthLabel(health)}).`,
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
