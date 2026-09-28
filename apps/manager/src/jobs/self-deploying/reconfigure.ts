import { NonRetryableError } from "cloudflare:workflows";
import { selfDeployingStage } from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import { createDb } from "../../db/client";
import { installs, jobs, resources } from "../../db/schema";
import { readSettings, SETTING } from "../../db/settings";
import { cleanupSandboxBuildsPhase } from "../install/artifact-source";
import { healthLabel } from "../install/health";
import { lookupSubdomainPhase } from "../install/phases";
import type { ReconfigureJobParams } from "../reconfigure";
import {
  changedVarNames,
  changesSecrets,
  parseStoredVars,
  secretChangeProblems,
  secretSlots,
  storedVarsJson,
} from "../reconfigure/plan";
import type { JobContext } from "../run-job";
import { awaitSandboxSettledPhase } from "../sandbox-settle";
import { StepLog } from "../step-log";
import { createJobSteps, errorMessage, JobError } from "../steps";
import { checkAppHealthPhase } from "./jobs";
import {
  awaitAppCredentialsPhase,
  checkSandboxForInstallerPhase,
  expectedWorkers,
  installerRequest,
  installerRunId,
  installerVars,
  recordDiscoveredPhase,
  recordedCatalog,
  runInstallerPhase,
  settingsRunId,
  storeAppCredentialsPhase,
} from "./phases";

/**
 * The settings change of a self-deploying app: the path its update takes,
 * at the version it runs. New secret values are stored on the sandbox Worker
 * (as the install stored them), then the app's own installer deploys the
 * installed pin again with the new settings, and converges the app's
 * Workers on them. The catalog manifest is the one the install recorded, so
 * the change does not depend on what the catalog lists now.
 *
 * Secrets can be replaced, not removed: the installer sets every secret the
 * entry declares on the app's Workers and knows nothing of others. As with
 * an update there is no snapshot and no rollback.
 */
export async function runSelfDeployingReconfigure(
  ctx: JobContext,
  params: ReconfigureJobParams,
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
        throw new JobError(`the install is ${install.status}, not being changed`);
      }
      if (install.build_kind !== "self-deploying") {
        throw new JobError("the install was not deployed by the app's own installer");
      }
      const catalog = recordedCatalog(install.manifest_json);
      if (catalog === null || install.pin_sha === null) {
        throw new JobError(
          "the install never got as far as its installer; install the app again instead",
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
        `Changing the settings of ${install.app_slug} ${install.catalog_version}: its installer deploys the installed commit again with them, as stage ${selfDeployingStage(params.installId)}.`,
      );
      return {
        accountId: settings.account_id,
        slug: install.app_slug,
        workerName: install.worker_name,
        version: install.catalog_version,
        pin: install.pin_sha,
        catalogText: install.manifest_json ?? "",
        storedVars: parseStoredVars(install.config_json),
        recorded,
      };
    });
    steps.setAccountId(started.accountId);
    const catalog = recordedCatalog(started.catalogText);
    if (catalog === null) {
      steps.current = "start";
      throw new JobError("the recorded catalog manifest cannot be read");
    }

    await checkSandboxForInstallerPhase(steps, env, {
      costConfirmed: params.buildConfirmed,
      needsConfirmation: true,
    });

    await run("plan settings change", async ({ log }) => {
      const slots = secretSlots(
        catalog.secrets,
        started.recorded.filter((r) => r.kind === "secret").map((r) => r.name),
      );
      const problems = secretChangeProblems(params.secrets, slots, { canRemove: false });
      if (params.emailRouting !== undefined) {
        problems.push("A self-deploying app does not receive email through Appflare.");
      }
      if (expectedWorkers(catalog, params.installId)[0] !== started.workerName) {
        problems.push(
          `the installer no longer serves the app from "${started.workerName}"; update or reinstall it instead`,
        );
      }
      const changedVars = changedVarNames(started.storedVars, params.vars);
      if (changedVars.length === 0 && !changesSecrets(params.secrets)) {
        problems.push("Nothing changes: the settings and secrets are as they are.");
      }
      if (problems.length > 0) throw new JobError(problems.join(" "));
      if (changedVars.length > 0) log.info(`Settings changed: ${changedVars.join(", ")}.`);
      const set = Object.keys(params.secrets.set).sort();
      if (set.length > 0) log.info(`Secrets with a new value: ${set.join(", ")}.`);
      log.info(
        "No snapshot is taken: the installer changes the app in place, and a self-deploying app cannot be rolled back.",
      );
      return {};
    });

    const subdomain = await lookupSubdomainPhase(steps);
    await storeAppCredentialsPhase(steps, {
      installId: params.installId,
      jobId: params.jobId,
      token: undefined,
      secrets: params.secrets.set,
    });
    // After this job's writes, or ones made on the install page just before it.
    await awaitSandboxSettledPhase(steps, steps.accountId());
    await awaitAppCredentialsPhase(steps, env, {
      installId: params.installId,
      accountId: started.accountId,
      catalog,
      mode: changesSecrets(params.secrets) ? "fresh" : "required",
    });

    steps.current = "prepare installer";
    const instanceType = catalog.install.container?.instanceType;
    const request = installerRequest({
      action: "deploy",
      installId: params.installId,
      accountId: started.accountId,
      catalog,
      pin: started.pin,
      version: started.version,
      vars: installerVars(catalog, params.vars, {
        workerName: started.workerName,
        workerUrl: `https://${started.workerName}.${subdomain}.workers.dev`,
        accountId: started.accountId,
      }),
      ...(instanceType === undefined ? {} : { instanceType }),
      // Its own log, next to the one of the deploy that put this version in place.
      runId: settingsRunId(params.jobId),
    });
    const deployed = await runInstallerPhase(steps, env, "deploy", request);
    await run("record settings", async ({ orm }) => {
      const at = new Date(now());
      await orm
        .update(installs)
        .set({
          config_json: storedVarsJson(params.vars),
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
    // This run's log and the one of the deploy that put the version in place.
    await cleanupSandboxBuildsPhase(steps, env, params.installId, [
      request.runId,
      installerRunId("deploy", started.version),
    ]);

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
        `Changed the settings of ${started.slug} ${started.version} (health: ${healthLabel(health)}).`,
      );
      return {};
    });
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    await step.do("mark settings change failed", async () => {
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
          ? "Settings change failed while the installer ran: it may have applied part of the new settings. Save them again to finish; a self-deploying app cannot be rolled back."
          : `Settings change failed at "${failedAt}", before the installer ran; the app keeps its previous settings.${changesSecrets(params.secrets) ? " A new secret value the job already stored on the sandbox Worker reaches the app with its next update or settings change." : ""}`,
      );
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
