import { NonRetryableError } from "cloudflare:workflows";
import type { ScriptMetadata, VersionMetadata } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  appHealthPath,
  artifactManifestSchema,
  tooManyModulesMessage,
} from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { readCachedCatalogApp } from "../catalog/index.server";
import { createDb } from "../db/client";
import { installs, jobs, resources, snapshots } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { hyphenateUuid } from "./install";
import { fetchArtifactFile } from "./install/artifact";
import { ARTIFACT_FETCH_COST } from "./install/budget";
import { healthLabel } from "./install/health";
import { buildScriptMetadata, resolveVars, uploadModule } from "./install/metadata";
import {
  type ArtifactRef,
  applyD1MigrationsPhase,
  checkLiveHealthPhase,
  checkWorkflowNamePhase,
  d1Targets,
  loadVerifiedManifest,
  lookupSubdomainPhase,
  probeUntilHealthy,
  provisionResourcePhase,
  type ResourceRecord,
  recordResource,
  syncCronsPhase,
  uploadAssetsPhase,
  verifyManifestPhase,
} from "./install/phases";
import { RESOURCE_LABEL } from "./install/resources";
import type { JobContext } from "./run-job";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError, type StepTools } from "./steps";
import {
  activeVersionId,
  canarySkipReason,
  diffBindings,
  FULL_DEPLOY_REASON,
  lastDurableObjectTagOf,
  missingSecrets,
  previewUrl,
  type RecordedResource,
  secretBindings,
  snapshotRow,
  updatePath,
  updateRefusal,
} from "./update/plan";

/**
 * The `update` job: moves an installed app to the catalog's current version
 * without downtime and with a way back.
 *
 * 1. Verify the new artifact manifest (signature, schema, slug, version, and
 *    the digest of the cached index entry).
 * 2. Snapshot: the version serving traffic and a D1 Time Travel bookmark per
 *    database, recorded with the install's catalog state.
 * 3. Create resources for bindings new in this version (never delete any).
 * 4. Upload static assets.
 * 5. Upload the new Worker version (one multipart request) with every
 *    non-secret binding sent explicitly, secrets the version introduces, and
 *    `keep_bindings: ["secret_text"]`, which carries the existing secrets
 *    over and nothing else.
 * 6. Canary: GET the version's preview URL at the app's health path; a 5xx,
 *    no answer, or a JSON `version` other than the target fails the job
 *    before anything serves the new version.
 * 7. Apply new D1 migration files, before promotion (as wrangler does).
 * 8. Promote the version to 100% of traffic.
 * 9. Health check on the Worker's own URL. The version already serves, so
 *    the result is recorded on the install and never fails the job.
 *
 * A version that brings Durable Object migrations takes another path from
 * step 5 on: Cloudflare applies those only on a full script upload, which
 * serves the new code at once. So the new D1 files are applied first, then
 * the whole script is deployed with the migrations (no preview check is
 * possible), then the health check runs.
 *
 * The install is `updating` while the job runs and returns to `installed`
 * whatever happens. On failure the job records `<step>: <message>`; the
 * install's recorded version changes only once the new version serves.
 */

export const updateJobParams = z.object({
  kind: z.literal("update"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  /** The catalog version the admin chose; it must still be the index's current version. */
  version: z.string().min(1),
  /**
   * Values of the secrets this version introduces. Secret VALUES live only
   * here (Workflows stores params encrypted at rest); `jobs.input_json` keeps
   * their names.
   */
  secrets: z.record(z.string(), z.string()).default({}),
});
export type UpdateJobParams = z.infer<typeof updateJobParams>;

/** The canary retries 1042 and route propagation for a shorter time: the Worker's route is already live. */
export const CANARY_MAX_ATTEMPTS = 6;

function parseVars(json: string | null): Record<string, string> {
  if (json === null) return {};
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function runUpdate(ctx: JobContext): Promise<void> {
  const parsed = updateJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid update job payload");
  const params = parsed.data;
  const { step, env, deps } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now, baseFetch } = steps;
  /** Set once the new version exists / serves traffic, for the failure report. */
  let uploadedVersionId: string | null = null;
  let promoted = false;
  /** The install's record once the new version serves; written again if the job fails later. */
  let servingRecord: Partial<typeof installs.$inferInsert> | null = null;
  /** D1 databases that got new migration files (named when a failure leaves them ahead of the code). */
  const migrated: string[] = [];

  try {
    const started = await run("start", 1, async ({ log, orm }) => {
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
        throw new JobError(`the install is ${install.status}, not updating`);
      }
      if (env.KV === undefined) throw new JobError("the catalog cache is not available");
      const app = await readCachedCatalogApp(env.KV, install.app_slug);
      const refusal = updateRefusal({
        installedVersion: install.catalog_version,
        targetVersion: params.version,
        indexVersion: app?.version,
      });
      if (refusal !== null || app === null) {
        throw new JobError(refusal ?? "the app is no longer in the catalog");
      }
      const rows = await orm
        .select()
        .from(resources)
        .where(
          and(
            eq(resources.install_id, params.installId),
            isNull(resources.deleted_at),
            isNull(resources.retained_at),
          ),
        );
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Updating ${install.app_slug} from ${install.catalog_version} to ${params.version} on Worker "${install.worker_name}".`,
      );
      const recorded: RecordedResource[] = rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        binding: r.binding,
        name: r.name,
        cfId: r.cf_id,
      }));
      return {
        accountId: settings.account_id,
        slug: install.app_slug,
        workerName: install.worker_name,
        fromVersion: install.catalog_version,
        recordedVersionId: install.current_version_id,
        // Installs made before the tag was recorded applied every migration
        // of the manifest they were installed from.
        appliedDoTag: install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json),
        userVars: parseVars(install.config_json),
        artifacts: app.artifacts,
        digest: app.digest,
        resources: recorded,
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName } = started;
    const ref: ArtifactRef = {
      slug: started.slug,
      version: params.version,
      artifacts: started.artifacts,
      digest: started.digest,
    };

    // 1. The new artifact manifest.
    await verifyManifestPhase(steps, env.KV, ref, deps.signingKeys);
    steps.current = "load artifact manifest";
    const manifestText = await loadVerifiedManifest(env.KV, baseFetch, ref);
    const manifest: ArtifactManifest = artifactManifestSchema.parse(JSON.parse(manifestText));
    const diff = diffBindings(workerName, manifest.worker.bindings, started.resources);
    const path = updatePath(manifest, started.appliedDoTag);
    const fullDeploy = path.fullDeploy;
    const newSecrets = missingSecrets(
      manifest.catalog.secrets,
      started.resources.filter((r) => r.kind === "secret").map((r) => r.name),
    );
    const secretValues: Record<string, string> = {};
    for (const secret of newSecrets) {
      const value = params.secrets[secret.name];
      if (value !== undefined && value.length > 0) secretValues[secret.name] = value;
    }
    const moduleCost = manifest.worker.modules.length * ARTIFACT_FETCH_COST + 2;
    const healthPath = appHealthPath(manifest.catalog.install);

    await run("plan update", 0, async ({ log }) => {
      const problems = [...diff.problems];
      for (const secret of newSecrets) {
        if (secretValues[secret.name] === undefined) {
          problems.push(
            `No value was provided for ${secret.label} (${secret.name}), which this version introduces.`,
          );
        }
      }
      // The upload fetches every module in one invocation; refuse before
      // the snapshot rather than failing mid-upload.
      const tooMany = tooManyModulesMessage(manifest.worker.modules.length, "This version");
      if (tooMany !== null) problems.push(tooMany);
      if (problems.length > 0) throw new JobError(problems.join(" "));
      for (const res of diff.toCreate) {
        log.info(`New binding ${res.binding}: creating ${RESOURCE_LABEL[res.kind]} "${res.name}".`);
      }
      for (const row of diff.leftInPlace) {
        log.info(
          `Binding ${row.binding} is not in this version; its ${row.kind} "${row.name}" is left in place.`,
        );
      }
      for (const secret of newSecrets) {
        log.info(`New secret ${secret.name}: set with the new version.`);
      }
      if (fullDeploy !== null) {
        log.warn(
          `Durable Object migrations up to "${fullDeploy.new_tag}" are pending, so this update deploys the whole Worker at once instead of checking a preview first.`,
        );
      }
      log.info(
        `Plan: ${diff.existing.length} resource(s) kept, ${diff.toCreate.length} to create, ${diff.leftInPlace.length} left in place.`,
      );
      return {};
    });

    // 2. Snapshot, before anything changes.
    const deployed = await run("read current deployment", 1, async ({ log, cf }) => {
      const versionId = activeVersionId(await cf().versions.listDeployments(workerName));
      if (versionId === null) {
        throw new JobError(
          "no single version serves all of the Worker's traffic (a gradual deployment is in progress); finish or undo it in the Cloudflare dashboard first",
        );
      }
      if (started.recordedVersionId !== null && versionId !== started.recordedVersionId) {
        log.warn(
          `Cloudflare serves version ${versionId}, not ${started.recordedVersionId} as Appflare recorded; the snapshot keeps the one serving.`,
        );
      }
      log.info(`Version ${versionId} serves all traffic.`);
      return { versionId };
    });
    const bookmarks: Array<{ databaseId: string; bookmark: string }> = [];
    for (const db of started.resources) {
      if (db.kind !== "d1" || db.cfId === null) continue;
      const databaseId = db.cfId;
      const got = await run(`bookmark D1 ${db.name}`, 1, async ({ log, cf }) => {
        const { bookmark } = await cf().d1.bookmark(databaseId);
        log.info(`Time Travel bookmark of ${db.name}: ${bookmark}.`);
        return { bookmark };
      });
      bookmarks.push({ databaseId, bookmark: got.bookmark });
    }
    await run("record snapshot", 0, async ({ log, orm }) => {
      const [install] = await orm
        .select()
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      if (install === undefined) throw new JobError("the install no longer exists");
      await orm
        .insert(snapshots)
        .values(
          snapshotRow({
            // One snapshot per update job, so a retried step never inserts twice.
            id: params.jobId,
            installId: params.installId,
            jobId: params.jobId,
            workerVersionId: deployed.versionId,
            bookmarks,
            takenAt: new Date(now()),
            before: install,
            doMigrationTag: started.appliedDoTag,
            targetVersion: params.version,
          }),
        )
        .onConflictDoNothing();
      log.info(
        `Snapshot taken: version ${deployed.versionId} and ${bookmarks.length} D1 bookmark(s).`,
      );
      return {};
    });

    // 3. Resources for new bindings; nothing is deleted.
    for (const wf of diff.newWorkflows) await checkWorkflowNamePhase(steps, wf);
    const bound = [...diff.existing];
    for (const res of diff.toCreate) {
      bound.push(await provisionResourcePhase(steps, params.installId, res));
    }

    // 4. Static assets.
    const assetsJwt = await uploadAssetsPhase(
      steps,
      workerName,
      started.artifacts.zip,
      manifest.assets.files,
    );

    /** Every module fetched, and the metadata of the upload (never logged: it holds new secret values). */
    async function buildUpload(fetch: StepTools["fetch"]) {
      const modules = [];
      for (const module of manifest.worker.modules) {
        const got = await fetchArtifactFile(fetch, started.artifacts.zip, module);
        modules.push(uploadModule(module, got.bytes));
      }
      // Durable Object migrations go only to a full deploy, and only the
      // pending ones; the Worker has the others already.
      const { migrations: _all, ...base } = buildScriptMetadata({
        manifest,
        resources: bound,
        vars: resolveVars(manifest, started.userVars),
        assetsJwt,
        workflowNames: diff.workflowNames,
      });
      const metadata: ScriptMetadata = {
        ...base,
        bindings: [...(base.bindings ?? []), ...secretBindings(secretValues)],
        // Existing secrets are the only bindings carried over; everything else is sent above.
        keep_bindings: ["secret_text"],
      };
      if (fullDeploy !== null) metadata.migrations = fullDeploy;
      return { modules, metadata };
    }
    const bindingList = (metadata: ScriptMetadata) =>
      (metadata.bindings ?? []).map((b) => `${b.type} ${b.name}`);

    /** Records the uploaded version on the job, and what its upload created. */
    async function recordUpload(orm: StepTools["orm"], versionId: string): Promise<void> {
      await orm.update(jobs).set({ worker_version_id: versionId }).where(eq(jobs.id, params.jobId));
      const at = new Date(now());
      const rows: ResourceRecord[] = [
        ...diff.newWorkflows.map((wf) => ({
          kind: "workflow" as const,
          key: wf.binding,
          binding: wf.binding,
          name: wf.name,
          cfId: null,
        })),
        ...diff.newDurableObjects.map((d) => ({
          kind: "durable_object" as const,
          key: d.binding,
          binding: d.binding,
          name: d.className,
          cfId: null,
        })),
        ...Object.keys(secretValues).map((name) => ({
          kind: "secret" as const,
          key: name,
          binding: name,
          name,
          cfId: null,
        })),
      ];
      for (const row of rows) await recordResource(orm, params.installId, row, at);
    }

    /** The install's record once `versionId` serves all traffic. */
    const servingState = (versionId: string) => ({
      current_version_id: versionId,
      catalog_version: params.version,
      manifest_json: manifestText,
      artifact_url: started.artifacts.zip,
      artifact_digest: started.digest,
      pin_sha: manifest.source.sha,
      do_migration_tag: fullDeploy?.new_tag ?? started.appliedDoTag,
    });

    /** New D1 migration files, one database at a time; remembers which databases changed. */
    async function migrateDatabases(): Promise<void> {
      for (const target of d1Targets(manifest, bound)) {
        if ((await applyD1MigrationsPhase(steps, started.artifacts.zip, target)) > 0) {
          migrated.push(target.name);
        }
      }
    }

    let subdomain: string;
    if (fullDeploy === null) {
      // 5. The new version: every module in ONE multipart request.
      const uploaded = await run(
        "upload Worker version",
        moduleCost,
        async ({ log, fetch, cf }) => {
          const { modules, metadata } = await buildUpload(fetch);
          const versionMetadata: VersionMetadata = {
            ...metadata,
            annotations: {
              "workers/message": `Appflare: ${started.slug} ${params.version}`,
              "workers/tag": params.version,
            },
          };
          const result = await cf().versions.uploadVersion(workerName, {
            metadata: versionMetadata,
            modules,
          });
          log.info(
            `Uploaded version ${result.id} (${modules.length} module(s)); it serves no traffic yet.`,
            { versionId: result.id, bindings: bindingList(metadata) },
          );
          return { versionId: result.id, hasPreview: result.metadata?.has_preview ?? null };
        },
      );
      uploadedVersionId = uploaded.versionId;
      await run("record Worker version", 0, async ({ orm }) => {
        await recordUpload(orm, uploaded.versionId);
        return {};
      });

      // 6. Canary on the version's preview URL.
      subdomain = await lookupSubdomainPhase(steps);
      const skip = path.skipPreview ?? canarySkipReason(uploaded.hasPreview, 0);
      if (skip !== null) {
        await run("skip canary", 0, async ({ log }) => {
          log.warn(`${skip}.`);
          return {};
        });
      } else {
        await run("enable version previews", 1, async ({ log, cf }) => {
          await cf().workers.enableSubdomain(workerName, { enabled: true, previews_enabled: true });
          log.info("Preview URLs are enabled for this Worker.");
          return {};
        });
        await probeUntilHealthy(steps, step, {
          label: "canary",
          url: previewUrl(uploaded.versionId, workerName, subdomain, healthPath),
          healthyMessage: `version ${uploaded.versionId} is serving`,
          maxAttempts: CANARY_MAX_ATTEMPTS,
          expectVersion: params.version,
        });
      }

      // 7. D1 migrations: only files not applied yet, before promotion.
      await migrateDatabases();

      // 8. Promote. The API call is a step of its own, so the moment it
      // returns the job knows the new version serves traffic.
      await run("promote version", 1, async ({ log, cf }) => {
        await cf().versions.createDeployment(workerName, {
          versions: [{ version_id: uploaded.versionId, percentage: 100 }],
          annotations: { "workers/message": `Appflare: update to ${params.version}` },
        });
        log.info(`Version ${uploaded.versionId} now serves all traffic.`);
        return {};
      });
      promoted = true;
      servingRecord = servingState(uploaded.versionId);
    } else {
      // 5-8 for Durable Object migrations: D1 first, then one full deploy.
      await migrateDatabases();
      await run("skip canary", 0, async ({ log }) => {
        log.warn(`${FULL_DEPLOY_REASON}.`);
        return {};
      });
      const deployed = await run("deploy Worker script", moduleCost, async ({ log, fetch, cf }) => {
        const { modules, metadata } = await buildUpload(fetch);
        const api = cf();
        const result = await api.workers.uploadScript(workerName, {
          metadata,
          modules,
          excludeScript: true,
        });
        const versionId =
          hyphenateUuid(result.deployment_id) ??
          activeVersionId(await api.versions.listDeployments(workerName));
        if (versionId === null) {
          throw new JobError("Cloudflare did not report the id of the deployed version");
        }
        log.info(
          `Deployed version ${versionId} to all traffic with Durable Object migrations up to "${fullDeploy.new_tag}".`,
          { versionId, bindings: bindingList(metadata) },
        );
        return { versionId };
      });
      uploadedVersionId = deployed.versionId;
      promoted = true;
      servingRecord = servingState(deployed.versionId);
      await run("record Worker version", 0, async ({ orm }) => {
        await recordUpload(orm, deployed.versionId);
        return {};
      });
      subdomain = await lookupSubdomainPhase(steps);
    }

    const record = servingRecord;
    await run("record promotion", 0, async ({ orm }) => {
      await orm
        .update(installs)
        .set({ ...record, updated_at: new Date(now()) })
        .where(eq(installs.id, params.installId));
      return {};
    });

    await syncCronsPhase(
      steps,
      params.installId,
      workerName,
      started.resources.filter((r) => r.kind === "cron").map((r) => r.name),
      manifest.worker.crons,
    );

    // 9. Live health check, recorded rather than fatal: the version already serves.
    const url = `https://${workerName}.${subdomain}.workers.dev${healthPath}`;
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
        `Updated ${started.slug} from ${started.fromVersion} to ${params.version} at ${url} (health: ${healthLabel(health)}).`,
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    const version = uploadedVersionId;
    const wasPromoted = promoted;
    const serving = servingRecord;
    const aheadOfCode = wasPromoted ? [] : [...migrated];
    await step.do("mark update failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      // The new version serves traffic: the record says so even if the step
      // that writes it is the one that failed.
      await orm
        .update(installs)
        .set({ ...(serving ?? {}), status: "installed", updated_at: at })
        .where(and(eq(installs.id, params.installId), eq(installs.status, "updating")));
      const log = new StepLog(now);
      if (aheadOfCode.length > 0) {
        log.error(
          `The D1 database${aheadOfCode.length === 1 ? "" : "s"} ${aheadOfCode.join(", ")} ${aheadOfCode.length === 1 ? "is" : "are"} already migrated to the new schema while the previous code still serves. Retry the update, or restore ${aheadOfCode.length === 1 ? "it" : "them"} from this update's snapshot on the install page.`,
          { migrated: aheadOfCode },
        );
      }
      if (wasPromoted) {
        log.error(
          `Update failed at "${failedAt}" after version ${version} was promoted: it serves all traffic and is recorded as the install's version. Roll back from the install page if the app misbehaves.`,
          { versionId: version },
        );
      } else if (version !== null) {
        log.error(
          `Update failed at "${failedAt}". Version ${version} was uploaded but never promoted; the previous version keeps serving all traffic.`,
          { versionId: version },
        );
      } else {
        log.error(
          `Update failed at "${failedAt}". Nothing was deployed; the previous version keeps serving all traffic. Resources created so far stay recorded.`,
        );
      }
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
