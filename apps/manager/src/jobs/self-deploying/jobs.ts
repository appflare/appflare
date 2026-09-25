import { NonRetryableError } from "cloudflare:workflows";
import {
  appHealthPath,
  type CatalogManifest,
  type HealthMode,
  selfDeployingStage,
} from "@appflare/schema";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { readCachedCatalogApp } from "../../catalog/index.server";
import { requirementLabel } from "../../catalog/requirements";
import { createDb } from "../../db/client";
import { installs, jobs, resources } from "../../db/schema";
import { readSettings, SETTING } from "../../db/settings";
import type { InstallJobParams } from "../install";
import { cleanupSandboxBuildsPhase } from "../install/artifact-source";
import { healthLabel } from "../install/health";
import {
  checkLiveHealthPhase,
  type LiveHealthResult,
  lookupSubdomainPhase,
} from "../install/phases";
import type { JobContext } from "../run-job";
import { awaitSandboxEnabledPhase } from "../sandbox-enable-wait";
import { awaitSandboxSettledPhase } from "../sandbox-settle";
import { StepLog } from "../step-log";
import { createJobSteps, errorMessage, JobError, type JobSteps } from "../steps";
import type { UninstallJobParams } from "../uninstall";
import type { UpdateJobParams } from "../update";
import { updateRefusal } from "../update/plan";
import {
  awaitAppCredentialsPhase,
  checkSandboxForInstallerPhase,
  expectedWorkers,
  forgetAppCredentialsPhase,
  installerRequest,
  installerVars,
  loadInstallerCatalogPhase,
  recordDiscoveredPhase,
  recordedCatalog,
  runInstallerPhase,
  type SelfDeployingJobInput,
  selfDeployingInputOf,
  storeAppCredentialsPhase,
} from "./phases";

/**
 * The install, update and uninstall jobs of the self-deploying tier. The app
 * ships its own installer (an Alchemy stack, for example); the account's
 * sandbox Worker runs it at the pinned commit with the app's own token, which
 * the job stores on the sandbox Worker first (see phases.ts for its custody).
 *
 * - Install: check the sandbox Worker and the catalog entry, store the token
 *   and secrets, wait for the sandbox Worker version they deployed to answer
 *   (sandbox-settle.ts), run the deploy, record everything it created as
 *   managed by the app, then check the app's own URL (status-only unless the entry says
 *   otherwise: these apps usually sit behind Cloudflare Access).
 * - Update: run the deploy again at the new pin; the installer converges on
 *   what it deployed before. There is no snapshot and no rollback.
 * - Uninstall: run the installer's destroy command, then delete the token
 *   and secrets from the sandbox Worker. Appflare never deletes the app's
 *   resources itself.
 */

/** How the health check reads the app's answer: the entry's mode, else status-only. */
export function selfDeployingHealthMode(catalog: CatalogManifest): HealthMode {
  return catalog.install.healthMode ?? "status-only";
}

function parseVars(json: string | null): Record<string, string> {
  if (json === null) return {};
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The health check of the Worker that serves the app, or a recorded skip when it has no URL. */
export async function checkAppHealthPhase(
  ctx: JobContext,
  steps: JobSteps,
  catalog: CatalogManifest,
  url: string | null,
): Promise<LiveHealthResult> {
  if (url === null) {
    return steps.run("skip health check", async ({ log }) => {
      log.warn(
        "The Worker that serves the app has no workers.dev route, so Appflare cannot check it. Open the app from the address its installer printed.",
      );
      return {
        status: "unverified" as const,
        detail: "no workers.dev route",
        checkedAt: steps.now(),
      };
    });
  }
  return checkLiveHealthPhase(
    steps,
    ctx.step,
    `${url}${appHealthPath(catalog.install)}`,
    selfDeployingHealthMode(catalog),
  );
}

/** The install job for a self-deploying app (`params.selfDeploying` set). */
export async function runSelfDeployingInstall(
  ctx: JobContext,
  params: InstallJobParams & { selfDeploying: SelfDeployingJobInput },
): Promise<void> {
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;
  const input = params.selfDeploying;
  const stage = selfDeployingStage(params.installId);

  try {
    await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      log.info(
        `Installing ${params.slug} ${params.version} with its own installer, as stage ${stage}.`,
      );
      return {};
    });
    if (params.sandboxEnableJob !== undefined) {
      await awaitSandboxEnabledPhase(steps, step, env, params.sandboxEnableJob);
    }

    await checkSandboxForInstallerPhase(steps, env, {
      costConfirmed: input.costConfirmed,
      needsConfirmation: true,
    });
    const { catalog, text } = await loadInstallerCatalogPhase(steps, {
      slug: params.slug,
      input,
    });
    const workers = expectedWorkers(catalog, params.installId);
    const mainWorker = workers[0] ?? params.workerName;

    const preflight = await run("preflight checks", async ({ log, orm }) => {
      if (catalog.plan === "paid" && !params.paidConfirmed) {
        throw new JobError(
          "this app needs Workers Paid; confirm the account is on Workers Paid to install it",
        );
      }
      if (catalog.requires.length > 0 && params.requirementsConfirmed === false) {
        throw new JobError(
          `this app needs ${catalog.requires.map(requirementLabel).join(", ")}; confirm the account meets these requirements to install it`,
        );
      }
      if (input.appToken === undefined) {
        throw new JobError("this app deploys with its own Cloudflare token; enter it to install");
      }
      if (mainWorker !== params.workerName) {
        throw new JobError(
          `the install was claimed as "${params.workerName}", but the installer serves the app from "${mainWorker}"`,
        );
      }
      const clash = await orm
        .select({ worker: installs.worker_name })
        .from(installs)
        .where(
          and(
            ne(installs.id, params.installId),
            ne(installs.status, "uninstalled"),
            inArray(installs.worker_name, workers),
          ),
        )
        .limit(1);
      if (clash[0] !== undefined) {
        throw new JobError(`another install already uses the Worker name "${clash[0].worker}"`);
      }
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      // Recorded now, so an uninstall of a failed install knows what to destroy.
      await orm
        .update(installs)
        .set({ manifest_json: text, pin_sha: input.pin, updated_at: new Date(now()) })
        .where(eq(installs.id, params.installId));
      log.info(`Preflight passed. The installer creates ${workers.join(", ")} and what they bind.`);
      return { accountId: settings.account_id };
    });
    steps.setAccountId(preflight.accountId);

    await run("check Worker names", async ({ log, cf }) => {
      const scripts = new Set((await cf().workers.listScripts()).map((s) => s.id));
      const taken = workers.filter((w) => scripts.has(w));
      if (taken.length > 0) {
        throw new JobError(
          `a Worker named ${taken.join(", ")} already exists in this account; Appflare does not adopt existing Workers`,
        );
      }
      log.info(`No Worker named ${workers.join(" or ")} exists yet.`);
      return {};
    });

    const subdomain = await lookupSubdomainPhase(steps);

    await storeAppCredentialsPhase(steps, {
      installId: params.installId,
      jobId: params.jobId,
      token: input.appToken,
      secrets: params.secrets,
    });
    // Each write deployed a new version of the sandbox Worker; the run starts
    // once that version answers.
    await awaitSandboxSettledPhase(steps, steps.accountId());
    await awaitAppCredentialsPhase(steps, env, {
      installId: params.installId,
      accountId: preflight.accountId,
      catalog,
      mode: "fresh",
    });

    steps.current = "prepare installer";
    const request = installerRequest({
      action: "deploy",
      installId: params.installId,
      accountId: preflight.accountId,
      catalog,
      pin: input.pin,
      version: params.version,
      vars: installerVars(catalog, params.vars, {
        workerName: mainWorker,
        workerUrl: `https://${mainWorker}.${subdomain}.workers.dev`,
      }),
      ...(input.instanceType === undefined ? {} : { instanceType: input.instanceType }),
    });
    const deployed = await runInstallerPhase(steps, env, "deploy", request);
    await recordDiscoveredPhase(steps, params.installId, deployed.resources);

    const health = await checkAppHealthPhase(
      ctx,
      steps,
      catalog,
      deployed.workers.find((w) => w.name === mainWorker)?.url ?? null,
    );

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({
            status: "installed",
            manifest_json: text,
            artifact_url: input.manifestUrl,
            artifact_digest: input.manifestDigest,
            pin_sha: input.pin,
            build_kind: "self-deploying",
            sandbox_image: deployed.image,
            built_at: at,
            health_status: health.status,
            health_checked_at: new Date(health.checkedAt),
            updated_at: at,
          })
          .where(and(eq(installs.id, params.installId), eq(installs.status, "installing"))),
        orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: at, error: null })
          .where(eq(jobs.id, params.jobId)),
      ]);
      log.info(
        `Installed ${params.slug} ${params.version} as stage ${stage} (health: ${healthLabel(health)}).`,
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark install failed", async () => {
      const orm = createDb(env.DB);
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
      log.error(
        `Install failed at "${steps.current}". Whatever the installer created stays; uninstalling runs its destroy command.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}

/** The update job for a self-deploying app (`params.selfDeploying` set). */
export async function runSelfDeployingUpdate(
  ctx: JobContext,
  params: UpdateJobParams,
): Promise<void> {
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;

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
        throw new JobError(`the install is ${install.status}, not updating`);
      }
      if (install.build_kind !== "self-deploying") {
        throw new JobError("the install was not deployed by the app's own installer");
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
      if (app.tier !== "self-deploying" || app.build === undefined) {
        throw new JobError(
          `the catalog now lists ${app.slug} as a ${app.tier} tier app; uninstall it and install it again`,
        );
      }
      const recorded = await orm
        .select({ kind: resources.kind, name: resources.name })
        .from(resources)
        .where(and(eq(resources.install_id, params.installId), isNull(resources.deleted_at)));
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Updating ${install.app_slug} from ${install.catalog_version} to ${params.version}: its installer deploys the new version over the installed one.`,
      );
      return {
        accountId: settings.account_id,
        slug: install.app_slug,
        workerName: install.worker_name,
        fromVersion: install.catalog_version,
        userVars: parseVars(install.config_json),
        input: selfDeployingInputOf(app.build, params.buildConfirmed === true),
        recorded,
      };
    });
    steps.setAccountId(started.accountId);
    const input = started.input;

    await checkSandboxForInstallerPhase(steps, env, {
      costConfirmed: input.costConfirmed,
      needsConfirmation: true,
    });
    const { catalog, text } = await loadInstallerCatalogPhase(steps, { slug: started.slug, input });
    const workers = expectedWorkers(catalog, params.installId);

    const newSecrets: Record<string, string> = {};
    await run("plan update", async ({ log }) => {
      if (workers[0] !== started.workerName) {
        throw new JobError(
          `this version serves the app from "${workers[0]}", not "${started.workerName}"; uninstall it and install it again`,
        );
      }
      const known = new Set(started.recorded.filter((r) => r.kind === "secret").map((r) => r.name));
      const missing: string[] = [];
      for (const secret of catalog.secrets) {
        if (known.has(secret.name)) continue;
        const value = params.secrets[secret.name];
        if (value === undefined || value.length === 0)
          missing.push(`${secret.label} (${secret.name})`);
      }
      if (missing.length > 0) {
        throw new JobError(
          `no value was provided for ${missing.join(", ")}, which this version introduces`,
        );
      }
      log.info(
        "No snapshot is taken: the installer changes the app in place, and a self-deploying app cannot be rolled back.",
      );
      return {};
    });
    for (const secret of catalog.secrets) {
      const value = params.secrets[secret.name];
      if (value !== undefined && value.length > 0) newSecrets[secret.name] = value;
    }

    const subdomain = await lookupSubdomainPhase(steps);
    const replacing = params.appToken !== undefined || Object.keys(newSecrets).length > 0;
    await storeAppCredentialsPhase(steps, {
      installId: params.installId,
      jobId: params.jobId,
      token: params.appToken,
      secrets: newSecrets,
    });
    // After this job's writes, or ones made on the install page just before it.
    await awaitSandboxSettledPhase(steps, steps.accountId());
    await awaitAppCredentialsPhase(steps, env, {
      installId: params.installId,
      accountId: started.accountId,
      catalog,
      mode: replacing ? "fresh" : "required",
    });

    steps.current = "prepare installer";
    const request = installerRequest({
      action: "deploy",
      installId: params.installId,
      accountId: started.accountId,
      catalog,
      pin: input.pin,
      version: params.version,
      vars: installerVars(catalog, started.userVars, {
        workerName: started.workerName,
        workerUrl: `https://${started.workerName}.${subdomain}.workers.dev`,
      }),
      ...(input.instanceType === undefined ? {} : { instanceType: input.instanceType }),
    });
    const deployed = await runInstallerPhase(steps, env, "deploy", request);
    await run("record new version", async ({ orm }) => {
      const at = new Date(now());
      await orm
        .update(installs)
        .set({
          catalog_version: params.version,
          manifest_json: text,
          artifact_url: input.manifestUrl,
          artifact_digest: input.manifestDigest,
          pin_sha: input.pin,
          sandbox_image: deployed.image,
          built_at: at,
          updated_at: at,
        })
        .where(eq(installs.id, params.installId));
      return {};
    });
    await recordDiscoveredPhase(steps, params.installId, deployed.resources, started.recorded);

    const health = await checkAppHealthPhase(
      ctx,
      steps,
      catalog,
      deployed.workers.find((w) => w.name === started.workerName)?.url ?? null,
    );
    // Only the log of this run is worth keeping in the sandbox Worker's bucket.
    await cleanupSandboxBuildsPhase(steps, env, params.installId, [request.runId]);

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
        `Updated ${started.slug} from ${started.fromVersion} to ${params.version} (health: ${healthLabel(health)}).`,
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    await step.do("mark update failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      await orm
        .update(installs)
        .set({ status: "installed", updated_at: at })
        .where(and(eq(installs.id, params.installId), eq(installs.status, "updating")));
      const log = new StepLog(now);
      log.error(
        failedAt === "deploy in sandbox"
          ? "Update failed while the installer ran: it may have changed part of the app. Run the update again to finish it; a self-deploying app cannot be rolled back."
          : `Update failed at "${failedAt}", before the installer ran; nothing changed.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}

/** The uninstall job for a self-deploying app (`params.selfDeploying` set). */
export async function runSelfDeployingUninstall(
  ctx: JobContext,
  params: UninstallJobParams,
): Promise<void> {
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;

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
      const live = await orm
        .select({ kind: resources.kind, name: resources.name })
        .from(resources)
        .where(and(eq(resources.install_id, params.installId), isNull(resources.deleted_at)));
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      const catalog = recordedCatalog(install.manifest_json);
      log.info(
        catalog === null
          ? `Uninstalling "${install.worker_name}". The install never got as far as its installer, so there is nothing to destroy.`
          : `Uninstalling "${install.worker_name}" with its installer's destroy command (stage ${selfDeployingStage(params.installId)}).`,
      );
      return {
        accountId: settings.account_id,
        workerName: install.worker_name,
        version: install.catalog_version,
        pin: install.pin_sha,
        catalogText: catalog === null ? null : install.manifest_json,
        userVars: parseVars(install.config_json),
        deployed: live.filter((r) => r.kind !== "secret").length > 0,
      };
    });
    steps.setAccountId(started.accountId);
    const catalog = recordedCatalog(started.catalogText);
    /** Whether the installer's destroy command ran and left none of the app's Workers. */
    let destroyed = false;

    if (catalog !== null && started.pin !== null) {
      await checkSandboxForInstallerPhase(steps, env, {
        costConfirmed: undefined,
        needsConfirmation: false,
      });
      // A failed install may never have stored the token; with nothing
      // recorded as deployed, there is nothing Appflare knows of to destroy.
      const held = await awaitAppCredentialsPhase(steps, env, {
        installId: params.installId,
        accountId: started.accountId,
        catalog,
        mode: started.deployed ? "required" : "optional",
      });
      const destroy = held.tokenPresent && held.secretsPresent;
      if (!destroy) {
        await run("skip destroy", async ({ log }) => {
          log.warn(
            "Nothing was recorded as deployed and the sandbox Worker holds no credentials for this install, so the installer's destroy command is skipped. If it created anything, delete it in the Cloudflare dashboard.",
          );
          return {};
        });
      }
      if (destroy) {
        // A secret change made just before this job may still be rolling out.
        await awaitSandboxSettledPhase(steps, steps.accountId());
        const subdomain = await lookupSubdomainPhase(steps);
        steps.current = "prepare installer";
        const request = installerRequest({
          action: "destroy",
          installId: params.installId,
          accountId: started.accountId,
          catalog,
          pin: started.pin,
          version: started.version,
          vars: installerVars(catalog, started.userVars, {
            workerName: started.workerName,
            workerUrl: `https://${started.workerName}.${subdomain}.workers.dev`,
          }),
        });
        const result = await runInstallerPhase(steps, env, "destroy", request);
        if (result.remaining.length > 0) {
          steps.current = "destroy in sandbox";
          throw new JobError(
            `the installer's destroy command finished, but ${result.remaining.join(", ")} still exist; retry the uninstall, or delete them in the Cloudflare dashboard`,
          );
        }
        destroyed = true;
      }
    }

    await run("mark the app's resources deleted", async ({ log, orm }) => {
      await orm
        .update(resources)
        .set({ deleted_at: new Date(now()) })
        .where(and(eq(resources.install_id, params.installId), isNull(resources.deleted_at)));
      // Only the Workers were checked after the destroy; the installer answers
      // for the rest, so the log says what was checked and no more.
      log.info(
        destroyed
          ? "The installer's destroy command succeeded and none of the app's Workers remain. Appflare did not check its other resources one by one: their records are marked deleted. If the installer left a database, bucket or namespace behind, delete it in the Cloudflare dashboard."
          : "Marked the records of the app's resources deleted without running the installer; delete anything it created in the Cloudflare dashboard.",
      );
      return {};
    });

    if (catalog !== null) {
      await forgetAppCredentialsPhase(
        steps,
        { installId: params.installId, jobId: params.jobId },
        catalog.secrets.map((s) => s.name),
      );
    }
    await cleanupSandboxBuildsPhase(steps, env, params.installId, []);

    await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm.batch([
        orm
          .update(installs)
          .set({ status: "uninstalled", uninstalled_at: at, updated_at: at })
          .where(eq(installs.id, params.installId)),
        orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: at, error: null })
          .where(eq(jobs.id, params.jobId)),
      ]);
      log.info(`Uninstalled "${started.workerName}".`);
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    await step.do("mark uninstall failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      await orm.update(installs).set({ updated_at: at }).where(eq(installs.id, params.installId));
      const log = new StepLog(now);
      log.error(
        `Uninstall failed at "${steps.current}". Retry the uninstall; the installer's destroy command picks up where it stopped.`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
