import { NonRetryableError } from "cloudflare:workflows";
import { type ArtifactManifest, artifactManifestSchema } from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources, snapshots } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { healthLabel, healthPathOfManifest } from "./install/health";
import { checkLiveHealthPhase, lookupSubdomainPhase, syncCronsPhase } from "./install/phases";
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
    const started = await run("start", 0, async ({ log, orm }) => {
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
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
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
        healthPath: healthPathOfManifest(snapshot.manifest_json),
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName } = started;

    // The API call is a step of its own, so the moment it returns the job
    // knows the snapshot's version serves traffic.
    await run("deploy snapshot version", 1, async ({ log, cf }) => {
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
    await run("record rollback", 0, async ({ orm }) => {
      await recordServing(orm, new Date(now()));
      return {};
    });

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
    // Recorded rather than fatal: the snapshot's version already serves.
    const health = await checkLiveHealthPhase(steps, step, url);

    await run("finish", 0, async ({ log, orm }) => {
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
