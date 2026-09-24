import { NonRetryableError } from "cloudflare:workflows";
import type { FetchLike, WorkerBinding as UploadBinding, VersionMetadata } from "@appflare/cf-api";
import {
  artifactManifestSchema,
  indexArtifactsSchema,
  SANDBOX_WORKER_NAME,
  tooManyModulesMessage,
} from "@appflare/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { MANIFEST_TTL_SECONDS, manifestCacheKey } from "../catalog/app-manifest.server";
import { releaseFetch } from "../catalog/release-fetch";
import { createDb } from "../db/client";
import { jobs, snapshots } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { MANAGER_SUBDOMAIN } from "../installs/workers-dev";
import { fetchWhole, sha256Hex } from "./install/artifact";
import {
  loadVerifiedManifest,
  lookupSubdomainPhase,
  probeUntilHealthy,
  uploadAssetsPhase,
} from "./install/phases";
import type { JobContext } from "./run-job";
import {
  classifyManagerCanary,
  selfUpdateBindings,
  verifyManagerManifest,
} from "./self-update/plan";
import { recordStep } from "./self-update/record";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError } from "./steps";
import { settleUnit } from "./units/result";
import type { ArtifactHost } from "./units/units";
import { activeVersionId, bookmarksJson, previewUrl } from "./update/plan";

/**
 * The `self_update` job: moves the manager itself to a newer release, the
 * way an update moves an app, on its own Worker (`settings.worker_name`).
 *
 * 1. Fetch the release's `manifest.json` and `manifest.sig` and verify them:
 *    an Appflare signing key (selected by the manifest's `keyId`), the
 *    schema, `app: "appflare"`, and the requested version.
 *    Then check the release's shape: every module is Range-fetched for one
 *    upload in one invocation, so a release with more modules than fit the
 *    free plan's subrequests is refused before anything is read or changed.
 * 2. Snapshot: the version serving all traffic, the running Appflare
 *    version, and a D1 Time Travel bookmark of the manager's database, as a
 *    `snapshots` row without an install. The Cloudflare dashboard (or
 *    `wrangler rollback`) can return to that version without the manager.
 * 3. Upload the static assets, Range-fetched from the release zip.
 * 4. Upload the new Worker version with the running script's own bindings
 *    (its D1, KV, and Workflow, whatever they are named in this account),
 *    `APPFLARE_VERSION` set to the new version, and `keep_bindings:
 *    ["secret_text"]` for the secrets. There is no D1 migration step: the new
 *    version migrates its database itself on its first request.
 * 5. Canary: the new version's preview must answer `/api/health` with the
 *    new version and a healthy database. Otherwise the job fails and nothing
 *    is promoted.
 * 6. Promote the new version to all traffic: the last real step.
 * 7. `record`: mark the job succeeded and append to the version history.
 *
 * A Workflow instance running when its script is replaced continues on the
 * new code, so nothing may follow the promotion except `record`, whose name
 * and shape never change. Code that already is the target version (the
 * instance resumed after the switch) runs only that step. If the switch cuts
 * the instance off before it, the new version's first request completes the
 * job (see ./self-update/record.ts).
 */

export const selfUpdateJobParams = z.object({
  kind: z.literal("self_update"),
  jobId: z.string().min(1),
  /** The release version to move to. */
  version: z.string().min(1),
  /** The version running when the job started. */
  fromVersion: z.string().min(1),
  /** The release tag (`manager@<version>`). */
  tag: z.string().min(1),
  /** The release asset URLs. */
  artifacts: indexArtifactsSchema,
});
export type SelfUpdateJobParams = z.infer<typeof selfUpdateJobParams>;

/**
 * Preview probes before the canary gives up. More than an app update's: the
 * new version's first request also migrates the manager's database.
 */
export const SELF_UPDATE_CANARY_ATTEMPTS = 10;

/** The health path every manager version serves. */
export const MANAGER_HEALTH_PATH = "/api/health";

export async function runSelfUpdate(ctx: JobContext): Promise<void> {
  const parsed = selfUpdateJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid self-update job payload");
  const params = parsed.data;
  const { step, env, deps } = ctx;
  const now = deps.now ?? Date.now;
  const record = { jobId: params.jobId, version: params.version, fromVersion: params.fromVersion };

  // Running as the target version means the promotion already happened and
  // this instance resumed on the new code: only the last step may run.
  if (env.APPFLARE_VERSION === params.version) {
    await recordStep(step, env.DB, record, now);
    return;
  }

  const steps = createJobSteps(ctx, params.jobId);
  const { run } = steps;
  const userAgent = `Appflare/${params.fromVersion}`;
  const feed = (fetch: FetchLike) => releaseFetch(fetch, { token: env.GITHUB_TOKEN, userAgent });
  /** Units read the release zip through the feed too, with their own Worker's GitHub token. */
  const releaseHost: ArtifactHost = { kind: "release", userAgent };
  /** Set once the new version exists, for the failure report. */
  let uploadedVersionId: string | null = null;

  try {
    const started = await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      if (env.APPFLARE_VERSION !== params.fromVersion) {
        throw new JobError(
          `Appflare ${env.APPFLARE_VERSION ?? "(unknown version)"} is running, not ${params.fromVersion} as when this update was started`,
        );
      }
      const settings = await readSettings(orm, [SETTING.accountId, SETTING.workerName]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!settings.worker_name) throw new JobError("Appflare does not know its own Worker yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Updating Appflare from ${params.fromVersion} to ${params.version} (release ${params.tag}) on Worker "${settings.worker_name}".`,
      );
      return { accountId: settings.account_id, workerName: settings.worker_name };
    });
    steps.setAccountId(started.accountId);
    const { workerName } = started;

    // 1. The release manifest.
    const verified = await run("verify release manifest", async ({ log, fetch }) => {
      const manifestFile = await fetchWhole(feed(fetch), params.artifacts.manifest);
      const sigFile = await fetchWhole(feed(fetch), params.artifacts.sig);
      const manifest = await verifyManagerManifest(
        manifestFile.bytes,
        new TextDecoder().decode(sigFile.bytes),
        params.version,
        deps.signingKeys,
      );
      const digest = await sha256Hex(manifestFile.bytes);
      // Later steps re-read the exact bytes by digest (step results are capped at 1 MiB).
      const key = manifestCacheKey(digest);
      if (env.KV !== undefined && (await env.KV.get(key)) === null) {
        await env.KV.put(key, new TextDecoder().decode(manifestFile.bytes), {
          expirationTtl: MANIFEST_TTL_SECONDS,
        });
      }
      log.info(`Verified manifest.json of Appflare ${manifest.version} (key "${manifest.keyId}").`);
      return { digest };
    });
    steps.current = "load release manifest";
    const manifest = artifactManifestSchema.parse(
      JSON.parse(
        await loadVerifiedManifest(env.KV, feed(steps.baseFetch), {
          artifacts: params.artifacts,
          digest: verified.digest,
        }),
      ),
    );
    await run("check release shape", async ({ log }) => {
      const count = manifest.worker.modules.length;
      const tooMany = tooManyModulesMessage(count, "The release");
      if (tooMany !== null) throw new JobError(tooMany);
      log.info(`The release has ${count} Worker module(s); they fit one upload.`);
      return {};
    });

    // 2. Snapshot, before anything changes.
    const deployed = await run("read current deployment", async ({ log, cf }) => {
      const versionId = activeVersionId(await cf().versions.listDeployments(workerName));
      if (versionId === null) {
        throw new JobError(
          "no single version serves all of Appflare's traffic (a gradual deployment is in progress); finish or undo it in the Cloudflare dashboard first",
        );
      }
      log.info(`Version ${versionId} (Appflare ${params.fromVersion}) serves all traffic.`);
      return { versionId };
    });
    const current = await run("read current bindings", async ({ log, cf }) => {
      const api = cf();
      // The sandbox Worker is optional; the new version binds it when it exists.
      const sandboxWorker = (await api.workers.listScripts()).some(
        (s) => s.id === SANDBOX_WORKER_NAME,
      );
      const plan = selfUpdateBindings({
        current: await api.workers.getBindings(workerName),
        manifest,
        workerName,
        newVersion: params.version,
        sandboxWorker,
      });
      if (sandboxWorker) {
        log.info(`The sandbox Worker "${SANDBOX_WORKER_NAME}" exists; the new version binds it.`);
      }
      const problems = [...plan.problems];
      if (plan.databaseId === null && problems.length === 0) {
        problems.push("The running Worker reports no database id for its DB binding.");
      }
      if (problems.length > 0 || plan.databaseId === null) throw new JobError(problems.join(" "));
      for (const warning of plan.warnings) log.warn(warning);
      log.info(`The new version keeps the running Worker's ${plan.bindings.length} binding(s).`, {
        bindings: plan.bindings.map((b) => `${b.type} ${b.name}`),
      });
      return { bindings: plan.bindings, databaseId: plan.databaseId };
    });
    const bookmark = await run("bookmark Appflare database", async ({ log, cf }) => {
      const got = await cf().d1.bookmark(current.databaseId);
      log.info(`Time Travel bookmark of Appflare's database: ${got.bookmark}.`);
      return { bookmark: got.bookmark };
    });
    await run("record snapshot", async ({ log, orm }) => {
      await orm
        .insert(snapshots)
        .values({
          // One snapshot per job, so a retried step never inserts twice.
          id: params.jobId,
          install_id: null,
          job_id: params.jobId,
          worker_version_id: deployed.versionId,
          d1_bookmarks_json: bookmarksJson([
            { databaseId: current.databaseId, bookmark: bookmark.bookmark },
          ]),
          taken_at: new Date(now()),
          catalog_version: params.fromVersion,
          target_catalog_version: params.version,
        })
        .onConflictDoNothing();
      log.info(
        `Snapshot taken: version ${deployed.versionId} and a bookmark of the database. If the new version misbehaves, the Cloudflare dashboard's Deployments page returns to it.`,
      );
      return {};
    });

    // 3. Static assets.
    const assetsJwt = await uploadAssetsPhase(
      steps,
      workerName,
      params.artifacts.zip,
      manifest.assets.files,
      releaseHost,
    );
    if (assetsJwt === null) {
      steps.current = "upload assets";
      throw new JobError("the release has no static assets");
    }

    // 4. The new version: every module in ONE multipart request.
    const uploaded = await run("upload Worker version", async ({ log }) => {
      const bindings: UploadBinding[] = [...current.bindings];
      if (manifest.assets.binding) bindings.push({ type: "assets", name: manifest.assets.binding });
      const metadata: VersionMetadata = {
        main_module: manifest.worker.mainModule,
        compatibility_date: manifest.worker.compatibilityDate,
        compatibility_flags: manifest.worker.compatibilityFlags,
        bindings,
        assets: { jwt: assetsJwt, config: { ...manifest.assets.config } },
        // Secrets are the only bindings carried over; everything else is sent above.
        keep_bindings: ["secret_text"],
        annotations: {
          "workers/message": `Appflare: self-update to ${params.version}`,
          "workers/tag": params.version,
        },
      };
      if (manifest.worker.observability) {
        metadata.observability = manifest.worker.observability as VersionMetadata["observability"];
      }
      if (manifest.worker.placement) {
        metadata.placement = manifest.worker.placement as VersionMetadata["placement"];
      }
      if (manifest.worker.limits) {
        metadata.limits = manifest.worker.limits as VersionMetadata["limits"];
      }
      // Every module in ONE multipart request, read and uploaded by one unit.
      const result = settleUnit(
        await steps.units.api.uploadWorker({
          accountId: steps.accountId(),
          artifact: { zipUrl: params.artifacts.zip, host: releaseHost },
          workerName,
          modules: manifest.worker.modules,
          metadata,
          target: "version",
        }),
        log,
      );
      const versionId = result.versionId;
      if (versionId === null) {
        throw new JobError("Cloudflare did not report the id of the uploaded version");
      }
      if (result.hasPreview === false) {
        throw new JobError(
          `Cloudflare serves no preview of version ${versionId}, so it cannot be checked before it serves traffic`,
        );
      }
      log.info(
        `Uploaded version ${versionId} (Appflare ${params.version}, ${result.modules} module(s)); it serves no traffic yet.`,
        { versionId, bindings: bindings.map((b) => `${b.type} ${b.name}`) },
      );
      return { versionId };
    });
    uploadedVersionId = uploaded.versionId;
    await run("record Worker version", async ({ orm }) => {
      await orm
        .update(jobs)
        .set({ worker_version_id: uploaded.versionId })
        .where(eq(jobs.id, params.jobId));
      return {};
    });

    // 5. Canary on the version's preview URL.
    const subdomain = await lookupSubdomainPhase(steps);
    await run("enable version previews", async ({ log, cf }) => {
      // Appflare keeps its own workers.dev URL (see MANAGER_SUBDOMAIN).
      await cf().workers.enableSubdomain(workerName, MANAGER_SUBDOMAIN);
      log.info("Preview URLs are enabled for Appflare's Worker.");
      return {};
    });
    await probeUntilHealthy(steps, step, {
      label: "canary",
      url: previewUrl(uploaded.versionId, workerName, subdomain, MANAGER_HEALTH_PATH),
      healthyMessage: `Appflare ${params.version} answers with a healthy database`,
      maxAttempts: SELF_UPDATE_CANARY_ATTEMPTS,
      classify: (probe, attempt, elapsedMs, maxAttempts) =>
        classifyManagerCanary(probe, params.version, attempt, elapsedMs, maxAttempts),
    });

    // 6. Promote: the last real step. The marker comes first: only a job
    // that reached this point can be completed by the new version (whose code
    // also served the canary above, before any switch).
    await run("mark promotion", async ({ orm }) => {
      await orm
        .update(jobs)
        .set({ promoting_version: params.version })
        .where(eq(jobs.id, params.jobId));
      return {};
    });
    await run("promote version", async ({ log, cf }) => {
      await cf().versions.createDeployment(workerName, {
        versions: [{ version_id: uploaded.versionId, percentage: 100 }],
        annotations: { "workers/message": `Appflare: self-update to ${params.version}` },
      });
      log.info(`Version ${uploaded.versionId} now serves all traffic.`);
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    const version = uploadedVersionId;
    await step.do("mark self-update failed", async () => {
      const at = new Date(now());
      await createDb(env.DB)
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at, promoting_version: null })
        .where(eq(jobs.id, params.jobId));
      const log = new StepLog(now);
      if (failedAt === "promote version") {
        log.error(
          `Self-update failed while promoting version ${version}. Cloudflare may or may not have switched to it: check /api/health or the Worker's Deployments page in the Cloudflare dashboard.`,
          { versionId: version },
        );
      } else if (version !== null) {
        log.error(
          `Self-update failed at "${failedAt}". Version ${version} was uploaded but never promoted; Appflare ${params.fromVersion} keeps serving all traffic.`,
          { versionId: version },
        );
      } else {
        log.error(
          `Self-update failed at "${failedAt}". Nothing was deployed; Appflare ${params.fromVersion} keeps serving all traffic.`,
        );
      }
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }

  // 7. The only step after the promotion (fixed name and shape).
  await recordStep(step, env.DB, record, now);
}
