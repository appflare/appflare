import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError, type FetchLike } from "@appflare/cf-api";
import { probeContainers, probeR2 } from "@appflare/cf-api/capabilities";
import {
  artifactManifestSchema,
  indexArtifactsSchema,
  SANDBOX_BUCKET_NAME,
  SANDBOX_CONTAINERS,
  SANDBOX_WORKER_NAME,
  sandboxImage,
} from "@appflare/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { releaseFetch, releaseFetchAuthenticated } from "../catalog/release-fetch";
import { createDb } from "../db/client";
import { jobs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { releaseTokenOptions, releaseTokenSecret } from "../github/release-access.server";
import { fetchWhole } from "../jobs/install/artifact";
import { lookupSubdomainPhase } from "../jobs/install/phases";
import { explainR2Refusal } from "../jobs/install/r2-enablement";
import type { JobContext } from "../jobs/run-job";
import { StepLog } from "../jobs/step-log";
import { createJobSteps, errorMessage, isNotFound, JobError } from "../jobs/steps";
import { settleUnit } from "../jobs/units/result";
import type { ArtifactHost } from "../jobs/units/units";
import { activeVersionId } from "../jobs/update/plan";
import {
  type ContainerWait,
  containerChange,
  containerNamespaces,
  isSandboxWorker,
  sandboxScriptMetadata,
  sandboxVersionOf,
  VERSION_NOT_READY_CODE,
} from "./deploy-plan";
import { sandboxPreflightProblems } from "./preflight";
import { findSandboxRelease, verifySandboxManifest } from "./release";
import { SANDBOX_CONTAINER_WAIT } from "./units";

/**
 * The `sandbox_enable` and `sandbox_update` jobs: bring the account's
 * sandbox Worker to the release this manager pins, then connect the manager
 * to it. The same steps serve both, and every step first looks at what is
 * already there, so the job is idempotent: running it again after a failure
 * picks up where the last run stopped, and running it on an account the CLI
 * set up adopts what the CLI made (by name, only when it is an Appflare
 * sandbox Worker).
 *
 * 1. Check the account: R2 enabled, Containers usable (Workers Paid, and the
 *    token's Containers: Edit).
 * 2. Find the release `sandbox@<version>` and verify its signed manifest (an
 *    Appflare release key, the app, the version, its bindings).
 * 3. Look at the account: the sandbox Worker (its version and migration tag)
 *    and the build bucket.
 * 4. Create the bucket when it is missing.
 * 5. Upload the Worker, when it does not already run this release: every
 *    module read from the release zip and checked against the manifest, in
 *    one `PUT` from a job unit, with the container classes, the Durable
 *    Object migrations still to apply, and its secrets kept.
 * 6. Turn its `workers.dev` URL and previews off.
 * 7. Read the Durable Object namespace of each container class.
 * 8. Each container application: create it, or patch it and roll it out to
 *    the release's image.
 * 9. Wait until the applications are ready for builds (job units poll them).
 * 10. Connect the manager (its `SANDBOX` binding), unless it already is, and
 *     record the job as done. Always the last step: it may deploy the
 *     manager's own Worker, which this Workflow instance runs on.
 *
 * A failure leaves what was made in place: enabling again continues, and
 * "Disable sandbox builds" removes it.
 */

export const sandboxEnableJobParams = z.object({
  kind: z.enum(["sandbox_enable", "sandbox_update"]),
  jobId: z.string().min(1),
  /** The sandbox Worker release to deploy (the manager's pin when the job started). */
  version: z.string().min(1),
  /** The running `APPFLARE_VERSION` when the job started. */
  managerVersion: z.string().min(1),
  /**
   * The install or build job that turned sandbox builds on at first need,
   * which waits for this one; absent when an admin enabled them in Settings.
   */
  neededBy: z
    .object({ jobId: z.string().min(1), kind: z.enum(["install", "source_build"]) })
    .optional(),
});
export type SandboxEnableJobParams = z.infer<typeof sandboxEnableJobParams>;

/**
 * Calls of the wait unit before the job gives up. Each call runs over `SELF`
 * and waits up to about 100 seconds (50 while rollouts are polled too); new
 * applications were ready after about 80 seconds and a rollout after about
 * 100 when this was measured. The job's own invocation spends one
 * subrequest per call; with everything else a fresh enable stays under 40
 * of the free plan's 50.
 */
export const CONTAINER_WAIT_CALLS = 10;

/**
 * Enabling, updating and disabling run their heavy parts (the Worker upload,
 * the container wait, Appflare's own version check, the bucket pages) as job
 * units over the `SELF` binding. Run in the job's own invocation instead, a
 * fresh enable would pass the free plan's 50 subrequests, so a deployment
 * without `SELF` (one older than job units) is refused until Appflare is
 * updated.
 */
export function requireSelf(remote: boolean): void {
  if (!remote) {
    throw new JobError(
      "this deployment of Appflare has no SELF binding, which sandbox builds need to stay within Cloudflare's subrequest limit; update Appflare in Settings first, then try again",
    );
  }
}

export async function runSandboxEnable(ctx: JobContext): Promise<void> {
  const parsed = sandboxEnableJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid sandbox job payload");
  const params = parsed.data;
  const { step, env, deps } = ctx;
  const now = deps.now ?? Date.now;
  const steps = createJobSteps(ctx, params.jobId);
  const { run } = steps;
  const version = params.version;
  const userAgent = `Appflare/${params.managerVersion}`;
  /**
   * The GitHub access token marked for release downloads (from "start"):
   * usable when updating, since the sandbox Worker that holds it exists;
   * enabling falls back to `GITHUB_TOKEN`.
   */
  let releaseSecret: string | null = null;
  const tokenOptions = () => releaseTokenOptions(env, releaseSecret);
  const feed = (fetch: FetchLike) => releaseFetch(fetch, { ...tokenOptions(), userAgent });
  const releaseHost = (): ArtifactHost => ({
    kind: "release",
    userAgent,
    ...(releaseSecret === null ? {} : { tokenSecret: releaseSecret }),
  });

  try {
    const started = await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const settings = await readSettings(orm, [SETTING.accountId, SETTING.workerName]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!settings.worker_name) throw new JobError("Appflare does not know its own Worker yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      requireSelf(steps.units.remote);
      log.info(
        `${params.kind === "sandbox_update" ? "Updating" : "Enabling"} sandbox builds with the sandbox Worker ${version} (image ${sandboxImage(version)}).`,
      );
      if (params.neededBy !== undefined) {
        log.info(
          `Turned on first for the ${params.neededBy.kind === "install" ? "install" : "build"} job ${params.neededBy.jobId}, which waits for this one.`,
        );
      }
      return {
        accountId: settings.account_id,
        workerName: settings.worker_name,
        releaseTokenSecret: await releaseTokenSecret(env),
      };
    });
    steps.setAccountId(started.accountId);
    releaseSecret = started.releaseTokenSecret ?? null;

    // 1. What the account allows.
    await run("check account", async ({ log, cf }) => {
      const api = cf();
      const [r2, containers] = await Promise.all([probeR2(api), probeContainers(api)]);
      const problems = sandboxPreflightProblems({ r2, containers, accountId: api.accountId });
      if (problems.length > 0) throw new JobError(problems.join(" "));
      for (const probe of [r2, containers]) {
        // Could not tell (a network error, an answer the probe does not know): ask again.
        if (probe.state === "unknown") throw new Error(`the account check failed: ${probe.detail}`);
      }
      log.info("R2 is enabled, and the token can use Containers (the account is on Workers Paid).");
      return {};
    });

    // 2. The signed release.
    const release = await run("find sandbox Worker release", async ({ log, fetch }) => {
      const assets = await findSandboxRelease(feed(fetch), env, version, {
        viaApi: releaseFetchAuthenticated(tokenOptions()),
      });
      log.info(`Found the release sandbox@${version}.`);
      return { assets };
    });
    const assets = indexArtifactsSchema.parse(release.assets);
    const verified = await run("verify sandbox Worker release", async ({ log, fetch }) => {
      const manifestFile = await fetchWhole(feed(fetch), assets.manifest);
      const sigFile = await fetchWhole(feed(fetch), assets.sig);
      const manifest = await verifySandboxManifest(
        manifestFile.bytes,
        new TextDecoder().decode(sigFile.bytes),
        version,
        deps.signingKeys,
      );
      log.info(
        `Verified manifest.json of the sandbox Worker ${manifest.version} (key "${manifest.keyId}", ${manifest.worker.modules.length} module(s)).`,
      );
      return { manifest };
    });
    const manifest = artifactManifestSchema.parse(verified.manifest);

    // 3. What is there already.
    const account = await run("look at the account", async ({ log, cf }) => {
      const api = cf();
      const script = (await api.workers.listScripts()).find((s) => s.id === SANDBOX_WORKER_NAME);
      let deployedVersion: string | null = null;
      if (script !== undefined) {
        const bindings = await api.workers.getBindings(SANDBOX_WORKER_NAME);
        if (!isSandboxWorker(bindings)) {
          throw new JobError(
            `a Worker named "${SANDBOX_WORKER_NAME}" exists in this account but is not an Appflare sandbox Worker (it lacks its Sandbox Durable Object, build bucket and version), so it is left alone; rename or delete it first`,
          );
        }
        deployedVersion = sandboxVersionOf(bindings);
      }
      const bucket = await explainR2Refusal(SANDBOX_BUCKET_NAME, () =>
        api.r2.listBuckets({ nameContains: SANDBOX_BUCKET_NAME }),
      );
      const bucketExists = bucket.some((b) => b.name === SANDBOX_BUCKET_NAME);
      log.info(
        [
          script === undefined
            ? `There is no sandbox Worker yet.`
            : `The sandbox Worker runs ${deployedVersion ?? "an unknown version"}.`,
          bucketExists
            ? `The bucket ${SANDBOX_BUCKET_NAME} exists.`
            : "There is no build bucket yet.",
        ].join(" "),
      );
      return {
        workerExists: script !== undefined,
        deployedVersion,
        bucketExists,
      };
    });

    // 4. The build bucket.
    if (!account.bucketExists) {
      await run(`create bucket ${SANDBOX_BUCKET_NAME}`, async ({ log, cf }) => {
        try {
          await explainR2Refusal(SANDBOX_BUCKET_NAME, () =>
            cf().r2.createBucket({ name: SANDBOX_BUCKET_NAME }),
          );
          log.info(`Created the R2 bucket ${SANDBOX_BUCKET_NAME}.`);
        } catch (error) {
          // A retried step whose first create went through.
          if (!(error instanceof CloudflareApiError && error.status === 409)) throw error;
          log.info(`The R2 bucket ${SANDBOX_BUCKET_NAME} already exists.`);
        }
        return {};
      });
    }

    // 5. The Worker.
    let uploadedVersionId: string | null = null;
    if (account.workerExists && account.deployedVersion === version) {
      steps.current = "upload sandbox Worker";
      await run("keep sandbox Worker", async ({ log }) => {
        log.info(`The sandbox Worker already runs ${version}; it is not uploaded again.`);
        return {};
      });
    } else {
      const uploaded = await run("upload sandbox Worker", async ({ log, cf }) => {
        // Read on every attempt: a retry after an upload whose answer was lost
        // must send the tag that upload applied, not the one before it.
        const migrationTag =
          (await cf().workers.listScripts()).find((s) => s.id === SANDBOX_WORKER_NAME)
            ?.migration_tag ?? null;
        const result = settleUnit(
          await steps.units.api.uploadWorker({
            accountId: steps.accountId(),
            artifact: { zipUrl: assets.zip, host: releaseHost() },
            workerName: SANDBOX_WORKER_NAME,
            modules: manifest.worker.modules,
            metadata: sandboxScriptMetadata(manifest, migrationTag),
            target: "script",
          }),
          log,
        );
        log.info(
          `Uploaded and deployed the sandbox Worker ${version} (version ${result.versionId ?? "unknown"}, ${result.modules} module(s)).`,
        );
        return { versionId: result.versionId };
      });
      uploadedVersionId = uploaded.versionId;
    }

    // 6. No public URL.
    await run("turn off workers.dev", async ({ log, cf }) => {
      await cf().workers.enableSubdomain(SANDBOX_WORKER_NAME, {
        enabled: false,
        previews_enabled: false,
      });
      log.info("The sandbox Worker has no workers.dev URL and no preview URLs.");
      return {};
    });

    // 7. The namespaces the container applications back.
    const namespaces = await run("read Durable Object namespaces", async ({ log, cf }) => {
      const api = cf();
      const versionId =
        uploadedVersionId ??
        activeVersionId(await api.versions.listDeployments(SANDBOX_WORKER_NAME));
      let bindings: unknown = [];
      if (versionId !== null) {
        try {
          bindings = (await api.versions.getVersion(SANDBOX_WORKER_NAME, versionId)).resources
            ?.bindings;
        } catch (error) {
          // Right after an upload the version may not be readable yet: retry the step.
          if (
            error instanceof CloudflareApiError &&
            error.errors.some((e) => e.code === VERSION_NOT_READY_CODE)
          ) {
            throw new Error(`version ${versionId} is not readable yet (${error.message})`);
          }
          throw error;
        }
      }
      let ids = containerNamespaces(bindings);
      if (Object.values(ids).some((id) => id === null)) {
        ids = containerNamespaces(bindings, await api.workers.listDurableObjectNamespaces());
      }
      const missing = Object.entries(ids).filter(([, id]) => id === null);
      if (missing.length > 0) {
        throw new JobError(
          `the sandbox Worker has no Durable Object namespace for ${missing.map(([c]) => c).join(" and ")}`,
        );
      }
      log.info(
        `Durable Object namespaces: ${Object.entries(ids)
          .map(([c, id]) => `${c} ${id}`)
          .join(", ")}.`,
      );
      return { ids: ids as Record<string, string> };
    });

    // 8. The container applications.
    // As wrangler: container logs on when the Worker's observability or its logs are.
    const observability = manifest.worker.observability as
      | { enabled?: unknown; logs?: { enabled?: unknown } }
      | null
      | undefined;
    const logs = observability?.enabled === true || observability?.logs?.enabled === true;
    let waits: ContainerWait[] = [];
    for (const container of SANDBOX_CONTAINERS) {
      const wait = await run(`container application ${container.name}`, async ({ log, cf }) => {
        const api = cf();
        const namespaceId = namespaces.ids[container.class_name];
        if (namespaceId === undefined)
          throw new JobError(`no namespace for ${container.class_name}`);
        const existing =
          (await api.containers.listApplications({ name: container.name })).find(
            (a) => a.name === container.name,
          ) ?? null;
        let active = null;
        if (existing?.active_rollout_id !== undefined) {
          try {
            active = await api.containers.getRollout(existing.id, existing.active_rollout_id);
          } catch (error) {
            if (!isNotFound(error)) throw error;
          }
        }
        const change = containerChange(container, version, namespaceId, logs, existing, active);
        const base = { name: container.name, maxInstances: container.max_instances };
        switch (change.kind) {
          case "conflict":
            throw new JobError(change.message);
          case "create": {
            const app = await api.containers.createApplication(change.body);
            log.info(
              `Created the container application ${container.name} (${container.instance_type}, up to ${container.max_instances} instance(s)). Cloudflare prepares its instances now; none runs until a build starts one.`,
            );
            return { ...base, id: app.id, rolloutId: null };
          }
          case "none":
          case "patch": {
            const id = (existing as NonNullable<typeof existing>).id;
            if (change.kind === "patch") {
              await api.containers.modifyApplication(id, change.modify);
              log.info(
                `The container application ${container.name} runs this release; its instance limit is now ${container.max_instances}.`,
              );
            } else {
              log.info(`The container application ${container.name} already runs this release.`);
            }
            return { ...base, id, rolloutId: null };
          }
          case "wait-rollout": {
            const id = (existing as NonNullable<typeof existing>).id;
            log.info(`The container application ${container.name} is already rolling out to it.`);
            return { ...base, id, rolloutId: change.rolloutId };
          }
          case "rollout": {
            const id = (existing as NonNullable<typeof existing>).id;
            await api.containers.modifyApplication(id, change.modify);
            const rollout = await api.containers.createRollout(id, change.rollout);
            log.info(
              `Rolling out ${container.name} to ${sandboxImage(version)} (rollout ${rollout.id}).`,
            );
            return { ...base, id, rolloutId: rollout.id };
          }
        }
      });
      waits.push(wait);
    }

    // 9. Ready for builds.
    const maxCalls = SANDBOX_CONTAINER_WAIT.maxCalls;
    const attempts = CONTAINER_WAIT_CALLS;
    for (let attempt = 1; waits.length > 0; attempt++) {
      const result = await run(`wait for container applications (${attempt})`, async ({ log }) =>
        settleUnit(
          await steps.units.api.waitForSandboxContainers({
            accountId: steps.accountId(),
            apps: waits,
            maxCalls,
          }),
          log,
        ),
      );
      if (result.failure !== null) {
        steps.current = "wait for container applications";
        throw new JobError(result.failure);
      }
      if (result.settled) break;
      if (attempt >= attempts) {
        steps.current = "wait for container applications";
        throw new JobError(
          `the container applications are not ready yet (${result.apps
            .filter((a) => !a.settled)
            .map((a) => a.summary)
            .join(" ")}); nothing was removed, so enable sandbox builds again to keep waiting`,
        );
      }
      const pending = new Set(result.apps.filter((a) => !a.settled).map((a) => a.id));
      waits = waits.filter((w) => pending.has(w.id));
    }

    // 10. The manager's own binding, with the job recorded as done in the same
    // step so that no step runs after the manager's own Worker is deployed.
    // That deploy can cut this instance off before the step's result is saved
    // (seen live: it resumed on the new version about three minutes later,
    // and a step run after such a deploy hung for five minutes and failed
    // with an internal Workflows error before its retry went through). The
    // step then runs again, finds the binding on the serving version, changes
    // nothing and records the job once more.
    const subdomain = await lookupSubdomainPhase(steps);
    await run("connect Appflare to the sandbox Worker", async ({ log, orm }) => {
      settleUnit(
        await steps.units.api.setSandboxBinding({
          accountId: steps.accountId(),
          workerName: started.workerName,
          subdomain,
          currentVersion: env.APPFLARE_VERSION ?? params.managerVersion,
          connect: true,
        }),
        log,
      );
      await orm
        .update(jobs)
        .set({ status: "succeeded", finished_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      log.info(
        `Sandbox builds are on: the sandbox Worker ${version} builds with ${sandboxImage(version)}.`,
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark sandbox job failed", async () => {
      await createDb(env.DB)
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const log = new StepLog(now);
      log.error(
        `Stopped at "${steps.current}". What this job made stays in place: enable sandbox builds again to continue from there, or disable them to remove it.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
