import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  appHealthMode,
  appHealthPath,
  artifactManifestSchema,
  hasFixedWorkerName,
  indexArtifactsSchema,
  isOptionalSecret,
  sha256Schema,
  tooManyModulesMessage,
} from "@appflare/schema";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { parseStoredCapabilities, resolveAccountPlan } from "../capabilities/capabilities";
import { cronTriggerCount } from "../catalog/cron-triggers";
import { requirementLabel, requirementSentence } from "../catalog/requirements";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { installDomainInput, workerNameSchema } from "../installs/install-input";
import { workersDevSubdomain } from "../installs/workers-dev";
import {
  type ArtifactOrigin,
  resolveArtifactPhase,
  sandboxBuildParams,
} from "./install/artifact-source";
import { planBindings } from "./install/bindings";
import { checkCronLimitPhase, putSchedulesChecked } from "./install/cron-limit";
import { installDomainPhase } from "./install/domain";
import {
  checkEmailRoutingPhase,
  emailRoutingJobInput,
  provisionEmailRoutingPhase,
} from "./install/email-routing";
import { healthLabel } from "./install/health";
import { buildScriptMetadata, type CreatedResource, installVars } from "./install/metadata";
import {
  applyD1MigrationsPhase,
  checkLiveHealthPhase,
  checkWorkflowNamePhase,
  d1Targets,
  lookupSubdomainPhase,
  provisionResourcePhase,
  type ResourceRecord,
  recordResource as recordResourceRow,
  resourceId,
  uploadAssetsPhase,
} from "./install/phases";
import { attachQueueConsumersPhase, planQueueConsumers } from "./install/queue-consumers";
import { explainR2Refusal } from "./install/r2-enablement";
import { assignRateLimitsPhase } from "./install/rate-limits";
import type { JobContext } from "./run-job";
import { runSelfDeployingInstall } from "./self-deploying/jobs";
import { selfDeployingJobInput } from "./self-deploying/phases";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError } from "./steps";
import { settleUnit } from "./units/result";
import { lastDurableObjectTag } from "./update/plan";

export { API_STEP, toStepError } from "./steps";
export { hyphenateUuid } from "./units/units";

/**
 * The `install` job. Every Cloudflare API call and every
 * artifact transfer is its own `step.do` with retries for 429/5xx; 4xx and
 * integrity failures end the job at once (`NonRetryableError`). Each step writes
 * its log lines in one batch. On failure the job records `<step>: <message>`,
 * the install becomes `failed`, and every resource already created stays
 * recorded (no automatic deletion). The final health check is the exception:
 * it records what the Worker answered on the install and never fails the job.
 */

/** The Workflow payload `startInstall` creates. Secret VALUES live only here. */
export const installJobParams = z.object({
  kind: z.literal("install"),
  jobId: z.string().min(1),
  installId: z.string().min(1),
  slug: z.string().min(1),
  version: z.string().min(1),
  workerName: workerNameSchema,
  /** The signed release; absent for a sandbox tier app, which is built instead. */
  artifacts: indexArtifactsSchema.optional(),
  digest: sha256Schema.optional(),
  /** A sandbox tier app: what the sandbox Worker builds, and the admin's cost confirmation. */
  build: sandboxBuildParams.optional(),
  /**
   * A self-deploying tier app: the catalog manifest its installer comes from,
   * the admin's cost confirmation, and the app's own token (which the job
   * stores on the sandbox Worker; never in D1).
   */
  selfDeploying: selfDeployingJobInput.optional(),
  secrets: z.record(z.string(), z.string()),
  vars: z.record(z.string(), z.string()),
  paidConfirmed: z.boolean(),
  /**
   * The admin confirmed the account meets the app's `requires`. Optional
   * because a job started by an earlier manager version does not carry it.
   */
  requirementsConfirmed: z.boolean().optional(),
  /** The zone the admin chose, for an app whose manifest sets `install.emailRouting`. */
  emailRouting: emailRoutingJobInput.optional(),
  /** A custom or external domain, added once the Worker serves (never fails the install). */
  domain: installDomainInput.optional(),
});
export type InstallJobParams = z.infer<typeof installJobParams>;

/** A failure the install reports as is; never retried. */
export class InstallError extends JobError {
  override name = "InstallError";
}

export async function runInstall(ctx: JobContext): Promise<void> {
  const parsed = installJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid install job payload");
  const params = parsed.data;
  if (params.selfDeploying !== undefined) {
    // The app's own installer deploys it; there is no artifact to install.
    await runSelfDeployingInstall(ctx, { ...params, selfDeploying: params.selfDeploying });
    return;
  }
  const { step, env, deps } = ctx;
  const db = env.DB;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;

  async function recordResource(orm: Database, row: ResourceRecord): Promise<void> {
    await recordResourceRow(orm, params.installId, row, new Date(now()));
  }

  const origin: ArtifactOrigin | null =
    params.build !== undefined
      ? { kind: "sandbox", build: params.build }
      : params.artifacts !== undefined && params.digest !== undefined
        ? { kind: "release", artifacts: params.artifacts, digest: params.digest }
        : null;
  if (origin === null) throw new NonRetryableError("invalid install job payload: no artifact");

  try {
    await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      log.info(`Installing ${params.slug} ${params.version} as Worker "${params.workerName}".`);
      return {};
    });

    // 1. Fetch and verify the artifact manifest (a sandbox tier app is built
    // first; a self-deploying one never gets here, see the top).
    const source = await resolveArtifactPhase(steps, env, deps.signingKeys, {
      installId: params.installId,
      slug: params.slug,
      version: params.version,
      origin,
    });
    const manifestText = source.manifestText;
    const manifest: ArtifactManifest = artifactManifestSchema.parse(JSON.parse(manifestText));
    const plan = planBindings(params.workerName, manifest.worker.bindings);
    const queuePlan = planQueueConsumers(params.workerName, manifest.worker);
    const toCreate = [...plan.resources, ...queuePlan.queues];

    // 2. Preflight.
    const preflight = await run("preflight checks", async ({ log, orm }) => {
      if (manifest.catalog.plan === "paid" && !params.paidConfirmed) {
        throw new InstallError(
          "this app needs Workers Paid; confirm the account is on Workers Paid to install it",
        );
      }
      const { requires } = manifest.catalog;
      if (requires.length > 0) {
        if (params.requirementsConfirmed === false) {
          throw new InstallError(
            `this app needs ${requires.map(requirementLabel).join(", ")}; confirm the account meets these requirements to install it`,
          );
        }
        for (const requirement of requires) {
          log.info(
            `Requires ${requirementLabel(requirement)}: ${requirementSentence(requirement, { tier: manifest.catalog.install.tier, provisionsEmailRouting: manifest.catalog.install.emailRouting !== undefined }) ?? "see the app's catalog page."}`,
          );
        }
        if (params.requirementsConfirmed === true) {
          log.info("The admin confirmed this account meets these requirements.");
        }
      }
      const problems = [...plan.problems, ...queuePlan.problems];
      if (problems.length > 0) throw new InstallError(problems.join(" "));
      // The upload fetches every module in one invocation; refuse before
      // anything is created rather than failing mid-upload.
      const tooMany = tooManyModulesMessage(manifest.worker.modules.length, "This app version");
      if (tooMany !== null) throw new InstallError(tooMany);
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
      const settings = await readSettings(orm, [
        SETTING.accountId,
        SETTING.accountPlan,
        SETTING.accountCapabilities,
      ]);
      if (!settings.account_id) throw new InstallError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new InstallError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Preflight passed: plan ${manifest.catalog.plan}, ${toCreate.length} resource(s) to create.`,
      );
      return {
        accountId: settings.account_id,
        // The detected plan first, then the one an admin set.
        accountPaid:
          resolveAccountPlan(
            settings.account_plan,
            parseStoredCapabilities(settings.account_capabilities),
          ).plan === "paid",
      };
    });
    steps.setAccountId(preflight.accountId);

    await run("verify API token", async ({ log, cf }) => {
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

    await run("check Worker name", async ({ log, cf }) => {
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

    // An account without R2 refuses every R2 call. Ask once before creating
    // anything, so that failure leaves nothing behind to clean up.
    const firstBucket = toCreate.find((r) => r.kind === "r2");
    if (firstBucket !== undefined) {
      await run("check R2 is enabled", async ({ log, cf }) => {
        await explainR2Refusal(firstBucket.name, () =>
          cf().r2.listBuckets({ nameContains: params.workerName }),
        );
        log.info("R2 is enabled on this account.");
        return {};
      });
    }

    // The account's cron trigger limit (5 on Workers Free) is checked before
    // anything is created, like R2. Skipped on Workers Paid: the admin
    // confirmed it for this install (a paid app always asks), or Settings
    // records it for the account.
    const crons = [...new Set(manifest.worker.crons)];
    await checkCronLimitPhase(steps, {
      workerName: params.workerName,
      wanted: cronTriggerCount(crons),
      paid: params.paidConfirmed || preflight.accountPaid,
      subject: "this app",
    });

    // Email Routing is checked before anything is created, like R2.
    const emailRouting = manifest.catalog.install.emailRouting;
    if (emailRouting !== undefined && params.emailRouting === undefined) {
      steps.current = "check Email Routing";
      throw new InstallError("this app receives email; choose a zone for it and install again");
    }
    const emailInspection =
      emailRouting === undefined || params.emailRouting === undefined
        ? null
        : await checkEmailRoutingPhase(steps, {
            zoneId: params.emailRouting.zoneId,
            config: emailRouting,
            workerName: params.workerName,
          });

    // 3. Resources: check the name is free, create, then record.
    const created: CreatedResource[] = [];
    for (const res of toCreate) {
      created.push(await provisionResourcePhase(steps, params.installId, res));
    }

    if (plan.durableObjects.length > 0) {
      await run("record Durable Object classes", async ({ log, orm }) => {
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

    const rateLimitIds = await assignRateLimitsPhase(
      steps,
      params.installId,
      manifest.worker.bindings,
    );

    // 4. Static assets.
    const assetsJwt = await uploadAssetsPhase(
      steps,
      params.workerName,
      source.zipUrl,
      manifest.assets.files,
      source.host,
    );

    // Vars may name the Worker's URL (`{{workerUrl}}`), so the account's
    // workers.dev subdomain is known before the upload.
    const subdomain = await lookupSubdomainPhase(steps);

    // 5. Script upload: every module in ONE multipart request. The Worker is
    // recorded first, with no id yet (pending): an upload whose response is
    // lost has still created it, and an uninstall deletes a Worker only when
    // this install recorded it (the name was checked free just before).
    await run("record Worker name", async ({ orm }) => {
      await recordResource(orm, {
        kind: "worker",
        key: params.workerName,
        binding: null,
        name: params.workerName,
        cfId: null,
      });
      return {};
    });
    const upload = await run("upload Worker script", async ({ log, orm }) => {
      const vars = installVars(manifest, params.vars, { workerName: params.workerName, subdomain });
      for (const warning of vars.warnings) log.warn(warning);
      const metadata = buildScriptMetadata({
        manifest,
        workerName: params.workerName,
        resources: created,
        vars: vars.vars,
        assetsJwt,
        workflowNames: Object.fromEntries(plan.workflows.map((w) => [w.binding, w.name])),
        rateLimitIds,
      });
      try {
        // Every module in ONE multipart request, read and uploaded by one unit.
        const result = settleUnit(
          await steps.units.api.uploadWorker({
            accountId: steps.accountId(),
            artifact: { zipUrl: source.zipUrl, host: source.host },
            workerName: params.workerName,
            modules: manifest.worker.modules,
            metadata,
            target: "script",
          }),
          log,
        );
        log.info(`Uploaded Worker "${params.workerName}" (${result.modules} module(s)).`, {
          versionId: result.versionId,
          bindings: (metadata.bindings ?? []).map((b) => `${b.type} ${b.name}`),
        });
        return { versionId: result.versionId, scriptId: result.scriptId ?? params.workerName };
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
          log.warn(`Cloudflare refused the upload; no Worker "${params.workerName}" was created.`);
        }
        throw error;
      }
    });

    // The script is live from here on: record it (and the Workflows its upload
    // created) even if a later step fails.
    await run("record Worker script", async ({ orm }) => {
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
      await applyD1MigrationsPhase(steps, source.zipUrl, target, undefined, source.host);
    }

    // 7. Secrets. An optional secret the admin left unset gets no step.
    for (const secret of manifest.catalog.secrets) {
      if (isOptionalSecret(secret) && (params.secrets[secret.name] ?? "").length === 0) continue;
      await run(`set secret ${secret.name}`, async ({ log, cf, orm }) => {
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

    // 8. Cron triggers, queue consumers, then the workers.dev route.
    if (crons.length > 0) {
      await run("set cron triggers", async ({ log, cf, orm }) => {
        await putSchedulesChecked(
          cf(),
          params.workerName,
          crons,
          `The Worker "${params.workerName}" is uploaded without them; uninstall this install to remove it.`,
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

    // Queue consumers belong to the script, like its cron triggers.
    await attachQueueConsumersPhase(
      steps,
      params.installId,
      params.workerName,
      queuePlan.consumers,
      created,
    );

    const host = `${params.workerName}.${subdomain}.workers.dev`;

    await run("enable workers.dev route", async ({ log, cf, orm }) => {
      // The install's stored choice (on for every new install); previews stay on.
      const [row] = await orm
        .select({ workersDev: installs.workers_dev_enabled })
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      const enabled = row?.workersDev ?? true;
      await cf().workers.enableSubdomain(params.workerName, workersDevSubdomain(enabled));
      if (!enabled) {
        log.info(`Left https://${host} off; version previews are on.`);
        return {};
      }
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

    // Email Routing rules name the Worker, so they come after its upload.
    if (emailInspection !== null) {
      await provisionEmailRoutingPhase(steps, params.installId, emailInspection, params.workerName);
    }

    // 9. Health check at the app's health path, through route propagation
    // and error 1042. Everything is created by now, so the result is recorded
    // on the install and never fails the job.
    const url = `https://${host}/`;
    const health = await checkLiveHealthPhase(
      steps,
      step,
      `https://${host}${appHealthPath(manifest.catalog.install)}`,
      appHealthMode(manifest.catalog.install),
    );

    // The address the admin asked for besides workers.dev, now that the
    // Worker serves; reported in the log, never a reason to fail.
    if (params.domain !== undefined) {
      await installDomainPhase(steps, {
        db,
        installId: params.installId,
        workerName: params.workerName,
        domain: params.domain,
        health: {
          path: appHealthPath(manifest.catalog.install),
          mode: appHealthMode(manifest.catalog.install),
        },
      });
    }

    // 10. Record the install.
    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({
            status: "installed",
            current_version_id: upload.versionId,
            manifest_json: manifestText,
            artifact_url: source.zipUrl,
            artifact_digest: source.digest,
            ...source.provenance,
            health_status: health.status,
            health_checked_at: new Date(health.checkedAt),
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
      log.info(
        `Installed ${params.slug} ${params.version} at ${url} (health: ${healthLabel(health)}).`,
      );
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
