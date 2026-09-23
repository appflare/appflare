import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  hasFixedWorkerName,
  indexArtifactsSchema,
  sha256Schema,
} from "@appflare/schema";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { workerNameSchema } from "../installs/install-input";
import { fetchArtifactFile } from "./install/artifact";
import { planBindings } from "./install/bindings";
import { ARTIFACT_FETCH_COST } from "./install/budget";
import {
  buildScriptMetadata,
  type CreatedResource,
  resolveVars,
  uploadModule,
} from "./install/metadata";
import {
  applyD1MigrationsPhase,
  checkWorkflowNamePhase,
  d1Targets,
  loadVerifiedManifest,
  lookupSubdomainPhase,
  probeUntilHealthy,
  provisionResourcePhase,
  type ResourceRecord,
  recordResource as recordResourceRow,
  resourceId,
  uploadAssetsPhase,
  verifyManifestPhase,
} from "./install/phases";
import type { JobContext } from "./run-job";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError, type StepTools } from "./steps";
import { lastDurableObjectTag } from "./update/plan";

export { API_STEP, toStepError } from "./steps";

/**
 * The `install` job. Every Cloudflare API call and every
 * artifact transfer is its own `step.do` with retries for 429/5xx; 4xx and
 * integrity failures end the job at once (`NonRetryableError`). Each step writes
 * its log lines in one batch. On failure the job records `<step>: <message>`,
 * the install becomes `failed`, and every resource already created stays
 * recorded (no automatic deletion).
 */

/** The Workflow payload `startInstall` creates. Secret VALUES live only here. */
export const installJobParams = z.object({
  kind: z.literal("install"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  workerName: workerNameSchema,
  artifacts: indexArtifactsSchema,
  digest: sha256Schema,
  secrets: z.record(z.string(), z.string()),
  vars: z.record(z.string(), z.string()),
  paidConfirmed: z.boolean(),
});
export type InstallJobParams = z.infer<typeof installJobParams>;

/** A single invocation can never make more than this many subrequests (free plan). */
const INVOCATION_CAP = 48;

/** A failure the install reports as is; never retried. */
export class InstallError extends JobError {
  override name = "InstallError";
}

/** wrangler's `parseNonHyphenedUuid`: the upload's `deployment_id` may lack hyphens. */
export function hyphenateUuid(id: string | null | undefined): string | null {
  if (id == null || id.includes("-")) return id ?? null;
  if (id.length !== 32) return null;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export async function runInstall(ctx: JobContext): Promise<void> {
  const parsed = installJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid install job payload");
  const params = parsed.data;
  const { step, env, deps } = ctx;
  const db = env.DB;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now, baseFetch } = steps;

  async function recordResource(orm: Database, row: ResourceRecord): Promise<void> {
    await recordResourceRow(orm, params.installId, row, new Date(now()));
  }

  const artifact = {
    slug: params.slug,
    version: params.version,
    artifacts: params.artifacts,
    digest: params.digest,
  };

  try {
    await run("start", 0, async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      log.info(`Installing ${params.slug} ${params.version} as Worker "${params.workerName}".`);
      return {};
    });

    // 1. Fetch and verify the artifact manifest.
    await verifyManifestPhase(steps, env.KV, artifact, deps.signingKeys);
    steps.current = "load artifact manifest";
    const manifestText = await loadVerifiedManifest(env.KV, baseFetch, artifact);
    const manifest: ArtifactManifest = artifactManifestSchema.parse(JSON.parse(manifestText));
    const plan = planBindings(params.workerName, manifest.worker.bindings);

    // 2. Preflight.
    const preflight = await run("preflight checks", 0, async ({ log, orm }) => {
      if (manifest.catalog.plan === "paid" && !params.paidConfirmed) {
        throw new InstallError(
          "this app needs Workers Paid; confirm the account is on Workers Paid to install it",
        );
      }
      for (const requirement of manifest.catalog.requires) {
        log.warn(
          `This app requires "${requirement}". Appflare does not check the account for it; the install fails later if it is missing.`,
        );
      }
      if (plan.problems.length > 0) throw new InstallError(plan.problems.join(" "));
      const moduleCost = manifest.worker.modules.length * ARTIFACT_FETCH_COST + 2;
      if (moduleCost > INVOCATION_CAP) {
        throw new InstallError(
          `the Worker has ${manifest.worker.modules.length} modules; a single upload cannot fetch that many within the free plan's subrequest limit`,
        );
      }
      // The Worker name is the unique key of an active install; an app whose
      // Worker name is fixed installs once.
      const fixed = hasFixedWorkerName(manifest.catalog.install);
      if (fixed && params.workerName !== manifest.catalog.install.workerName) {
        throw new InstallError(
          `this app only works as the Worker "${manifest.catalog.install.workerName}"`,
        );
      }
      const clash = await orm
        .select({ id: installs.id, slug: installs.app_slug, worker: installs.worker_name })
        .from(installs)
        .where(
          and(
            ne(installs.id, params.installId),
            ne(installs.status, "uninstalled"),
            fixed
              ? or(eq(installs.worker_name, params.workerName), eq(installs.app_slug, params.slug))
              : eq(installs.worker_name, params.workerName),
          ),
        )
        .limit(1);
      const other = clash[0];
      if (other !== undefined) {
        throw new InstallError(
          other.worker === params.workerName
            ? `another install already uses the Worker name "${params.workerName}"`
            : `${params.slug} is already installed as "${other.worker}" and only works under one Worker name`,
        );
      }
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new InstallError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new InstallError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Preflight passed: plan ${manifest.catalog.plan}, ${plan.resources.length} resource(s) to create.`,
      );
      return { accountId: settings.account_id };
    });
    steps.setAccountId(preflight.accountId);

    await run("verify API token", 2, async ({ log, cf }) => {
      const api = cf();
      let status: string;
      try {
        status = (await api.tokens.verify()).status;
      } catch (error) {
        if (!(error instanceof CloudflareApiError) || error.status >= 500 || error.status === 429) {
          throw error;
        }
        status = (await api.tokens.verifyUserToken()).status;
      }
      if (status !== "active") throw new InstallError(`the API token is ${status}`);
      log.info("The Cloudflare API token is active.");
      return {};
    });

    await run("check Worker name", 2, async ({ log, cf }) => {
      const scripts = await cf().workers.listScripts();
      if (scripts.some((s) => s.id === params.workerName)) {
        throw new InstallError(
          `a Worker named ${params.workerName} already exists in this account; Appflare does not adopt existing Workers`,
        );
      }
      log.info(`No Worker named "${params.workerName}" exists yet.`);
      return {};
    });

    for (const wf of plan.workflows) await checkWorkflowNamePhase(steps, wf);

    // 3. Resources: check the name is free, create, then record.
    const created: CreatedResource[] = [];
    for (const res of plan.resources) {
      created.push(await provisionResourcePhase(steps, params.installId, res));
    }

    if (plan.durableObjects.length > 0) {
      await run("record Durable Object classes", 0, async ({ log, orm }) => {
        for (const d of plan.durableObjects) {
          await recordResource(orm, {
            kind: "durable_object",
            key: d.binding,
            binding: d.binding,
            name: d.className,
            cfId: null,
          });
        }
        log.info(
          `Durable Object classes: ${plan.durableObjects.map((d) => d.className).join(", ")} (created by the script upload).`,
        );
        return {};
      });
    }

    // 4. Static assets.
    const assetsJwt = await uploadAssetsPhase(
      steps,
      params.workerName,
      params.artifacts.zip,
      manifest.assets.files,
    );

    // 5. Script upload: every module in ONE multipart request. The Worker is
    // recorded first, with no id yet (pending): an upload whose response is
    // lost has still created it, and an uninstall deletes a Worker only when
    // this install recorded it (the name was checked free just before).
    await run("record Worker name", 0, async ({ orm }) => {
      await recordResource(orm, {
        kind: "worker",
        key: params.workerName,
        binding: null,
        name: params.workerName,
        cfId: null,
      });
      return {};
    });
    const moduleCost = manifest.worker.modules.length * ARTIFACT_FETCH_COST + 2;
    /** The multipart upload of every module (one request). */
    async function uploadScript(
      log: StepTools["log"],
      fetch: StepTools["fetch"],
      cf: StepTools["cf"],
    ): Promise<{ versionId: string | null; scriptId: string }> {
      const modules = [];
      for (const module of manifest.worker.modules) {
        const got = await fetchArtifactFile(fetch, params.artifacts.zip, module);
        modules.push(uploadModule(module, got.bytes));
      }
      const metadata = buildScriptMetadata({
        manifest,
        resources: created,
        vars: resolveVars(manifest, params.vars),
        assetsJwt,
        workflowNames: Object.fromEntries(plan.workflows.map((w) => [w.binding, w.name])),
      });
      const api = cf();
      const result = await api.workers.uploadScript(params.workerName, {
        metadata,
        modules,
        excludeScript: true,
      });
      let versionId = hyphenateUuid(result.deployment_id);
      if (versionId === null) {
        const deployments = await api.versions.listDeployments(params.workerName);
        versionId = deployments[0]?.versions?.[0]?.version_id ?? null;
      }
      log.info(`Uploaded Worker "${params.workerName}" (${modules.length} module(s)).`, {
        versionId,
        bindings: (metadata.bindings ?? []).map((b) => `${b.type} ${b.name}`),
      });
      return { versionId, scriptId: result.id ?? params.workerName };
    }

    const upload = await run(
      "upload Worker script",
      moduleCost,
      async ({ log, fetch, cf, orm }) => {
        try {
          return await uploadScript(log, fetch, cf);
        } catch (error) {
          // A refused upload (4xx other than 429) created no Worker. Release the
          // pending row so an uninstall never deletes a same-named Worker made
          // elsewhere later.
          if (error instanceof CloudflareApiError && error.status < 500 && error.status !== 429) {
            await orm
              .update(resources)
              .set({ deleted_at: new Date(now()) })
              .where(
                and(
                  eq(resources.id, resourceId(params.installId, "worker", params.workerName)),
                  isNull(resources.cf_id),
                ),
              );
            log.warn(
              `Cloudflare refused the upload; no Worker "${params.workerName}" was created.`,
            );
          }
          throw error;
        }
      },
    );

    // The script is live from here on: record it (and the Workflows its upload
    // created) even if a later step fails.
    await run("record Worker script", 0, async ({ orm }) => {
      await orm
        .update(installs)
        .set({
          current_version_id: upload.versionId,
          // The upload applied every Durable Object migration the manifest has.
          do_migration_tag: lastDurableObjectTag(manifest.worker.migrations),
          updated_at: new Date(now()),
        })
        .where(eq(installs.id, params.installId));
      await orm
        .update(resources)
        .set({ cf_id: upload.scriptId })
        .where(eq(resources.id, resourceId(params.installId, "worker", params.workerName)));
      for (const wf of plan.workflows) {
        await recordResource(orm, {
          kind: "workflow",
          key: wf.binding,
          binding: wf.binding,
          name: wf.name,
          cfId: null,
        });
      }
      return {};
    });

    // 6. D1 migrations, wrangler-style.
    for (const target of d1Targets(manifest, created)) {
      await applyD1MigrationsPhase(steps, params.artifacts.zip, target);
    }

    // 7. Secrets.
    for (const secret of manifest.catalog.secrets) {
      await run(`set secret ${secret.name}`, 1, async ({ log, cf, orm }) => {
        const value = params.secrets[secret.name];
        if (value === undefined || value.length === 0) {
          throw new InstallError(`no value was provided for the secret ${secret.name}`);
        }
        await cf().workers.putSecret(params.workerName, { name: secret.name, text: value });
        await recordResource(orm, {
          kind: "secret",
          key: secret.name,
          binding: secret.name,
          name: secret.name,
          cfId: null,
        });
        log.info(`Set secret ${secret.name}.`);
        return {};
      });
    }

    // 8. Cron triggers, then the workers.dev route.
    const crons = manifest.worker.crons;
    if (crons.length > 0) {
      await run("set cron triggers", 1, async ({ log, cf, orm }) => {
        await cf().workers.putSchedules(
          params.workerName,
          crons.map((cron) => ({ cron })),
        );
        for (const cron of crons) {
          await recordResource(orm, {
            kind: "cron",
            key: cron,
            binding: null,
            name: cron,
            cfId: null,
          });
        }
        log.info(`Set ${crons.length} cron trigger(s): ${crons.join(", ")}.`);
        return {};
      });
    }

    const subdomain = await lookupSubdomainPhase(steps);
    const host = `${params.workerName}.${subdomain}.workers.dev`;

    await run("enable workers.dev route", 1, async ({ log, cf, orm }) => {
      await cf().workers.enableSubdomain(params.workerName, {
        enabled: true,
        previews_enabled: true,
      });
      await recordResource(orm, {
        kind: "subdomain",
        key: host,
        binding: null,
        name: host,
        cfId: null,
      });
      log.info(`Enabled https://${host}.`);
      return {};
    });

    // 9. Health check through route propagation and error 1042.
    const url = `https://${host}/`;
    const healthy = await probeUntilHealthy(steps, step, {
      label: "health",
      url,
      healthyMessage: "the Worker is serving",
    });

    // 10. Record the install.
    await run("finish", 0, async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({
            status: "installed",
            current_version_id: upload.versionId,
            manifest_json: manifestText,
            updated_at: at,
          })
          // Only from `installing`: an install whose job was settled from
          // outside (or that is being uninstalled) never flips back.
          .where(and(eq(installs.id, params.installId), eq(installs.status, "installing"))),
        orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: at, error: null })
          .where(eq(jobs.id, params.jobId)),
      ]);
      log.info(`Installed ${params.slug} ${params.version} at ${url} (health ${healthy}).`);
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark install failed", async () => {
      const orm = createDb(db);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      await orm
        .update(installs)
        .set({ status: "failed", updated_at: at })
        .where(eq(installs.id, params.installId));
      const log = new StepLog(now);
      log.error(`Install failed at "${steps.current}". Resources created so far stay recorded.`);
      await log.flush(db, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
