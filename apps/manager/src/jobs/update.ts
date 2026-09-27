import { NonRetryableError } from "cloudflare:workflows";
import type { ScriptMetadata, VersionMetadata } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  appHealthMode,
  appHealthPath,
  workerUploadProblem,
} from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { parseStoredCapabilities, resolveAccountPlan } from "../capabilities/capabilities";
import { CatalogTrustError, catalogTrust } from "../catalog/catalogs.server";
import { cronTriggerCount } from "../catalog/cron-triggers";
import { readCachedListing } from "../catalog/merged.server";
import { unsignedTierRefusal } from "../catalog/sources";
import { createDb } from "../db/client";
import { installs, jobs, resources, source_builds } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { secretsToSet } from "../installs/derived-secrets";
import { emailRoutingChangeWarning, emailRoutingOfManifest } from "../installs/email-routing";
import { appSlugLabel } from "../installs/source-review";
import { appBaseUrl, domainHostnames, workersDevSubdomain } from "../installs/workers-dev";
import { entryBudgetLine, entryBudgetProblem, entryJobCost } from "./entry-budget";
import {
  entryBindings,
  entryPlaceholders,
  entryScriptNamesOf,
  entryWorkers,
  storedOtherWorkers,
  workerCountProblem,
  workerLabel,
} from "./entry-workers";
import {
  type ArtifactOrigin,
  artifactOriginOf,
  cleanupSandboxBuildsPhase,
  prebuiltBuildParams,
  resolveArtifactPhase,
  sourceManifest,
} from "./install/artifact-source";
import { checkCronLimitPhase } from "./install/cron-limit";
import {
  deployOtherWorkerVersionPhase,
  type EntryUploadContext,
  type OtherWorkerUpdate,
  otherWorkerRoutePhase,
  planEntryQueueConsumers,
  prepareOtherWorkerPhase,
  promoteOtherWorkerPhase,
  setOtherWorkerCronsPhase,
} from "./install/entry-worker-phases";
import { healthLabel } from "./install/health";
import { buildScriptMetadata, installVars } from "./install/metadata";
import {
  applyD1BaselinePhase,
  applyD1MigrationsPhase,
  applyD1PostDeployPhase,
  applyD1SchemaPhase,
  checkLiveHealthPhase,
  checkWorkflowNamePhase,
  d1Targets,
  lookupSubdomainPhase,
  probeUntilHealthy,
  provisionResourcePhase,
  type ResourceRecord,
  recordResource,
  syncCronsPhase,
  uploadAssetsPhase,
} from "./install/phases";
import {
  consumerPlans,
  consumerPlansOf,
  diffConsumerQueues,
  syncQueueConsumersPhase,
} from "./install/queue-consumers";
import { assignRateLimitsPhase } from "./install/rate-limits";
import { RESOURCE_LABEL } from "./install/resources";
import { deleteSupersededPhase, supersededConfigs } from "./reconfigure/hyperdrive";
import { secretSlots, storedVarsJson } from "./reconfigure/plan";
import { undoSecretChangesPhase } from "./reconfigure/secrets";
import type { JobContext } from "./run-job";
import { runSelfDeployingUpdate } from "./self-deploying/jobs";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError, type StepTools } from "./steps";
import { settleUnit } from "./units/result";
import {
  appliedDurableObjectTag,
  canarySkipReason,
  diffBindings,
  droppedDurableObjectExportsProblem,
  EXPORTS_DEPLOY_REASON,
  FULL_DEPLOY_REASON,
  lastDurableObjectTagOf,
  missingSecrets,
  pipelineShapesOf,
  previewUrl,
  type RecordedResource,
  secretBindings,
  updatePath,
  updateRefusal,
  updateSecretsUndoneMessage,
  updateVersionMessage,
  vectorizeShapesOf,
  workerExportsOf,
} from "./update/plan";
import { takeSnapshotPhase } from "./update/snapshot";

/**
 * The `update` job: moves an installed app to the catalog's current version
 * without downtime and with a way back.
 *
 * 1. Verify the new artifact manifest (signature, schema, slug, version, and
 *    the digest of the cached index entry). A sandbox tier app is built from
 *    its pinned commit in the sandbox Worker first, and its unsigned manifest
 *    is checked against that build instead (see ./install/artifact-source.ts);
 *    after a successful update only the current and previous builds are kept.
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
 * 7. Apply new D1 migration files, before promotion (as wrangler does), then
 *    each database's schema files (run on every update, never recorded). A
 *    D1 baseline runs only on an empty database (one created in step 3, now
 *    or by an earlier attempt), as a new install's would; a database an
 *    earlier version set up never gets it.
 * 8. Promote the version to 100% of traffic, then set its queue consumers
 *    and cron triggers.
 * 9. Health check on the app's address (its workers.dev URL, or its first custom
 *    domain while workers.dev is off). The version already serves, so
 *    the result is recorded on the install and never fails the job.
 * 10. Apply the post-deploy migrations, which the previous code could not
 *    have run against, last of all. A rollback does not revert them, as it
 *    reverts no migration.
 *
 * A version that brings Durable Object migrations takes another path from
 * step 5 on: Cloudflare applies those only on a full script upload, which
 * serves the new code at once. So the new D1 files are applied first, then
 * the whole script is deployed with the migrations (no preview check is
 * possible), then the health check runs.
 *
 * The install is `updating` while the job runs and returns to `installed`
 * whatever happens. On failure the job records `<step>: <message>`; the
 * install's recorded version changes only once the new version serves. A
 * failure after the upload and before promotion first takes the secrets the
 * version introduced off the Worker's newest version again.
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
  /**
   * Values of the derived vars computed from the secrets above (a VAPID
   * public key from its private key). Public settings: the job stores them
   * with the install's other settings once the new version serves.
   */
  vars: z.record(z.string(), z.string()).optional(),
  /** For a sandbox tier app: the admin confirmed the build's cost on Workers Paid. */
  buildConfirmed: z.boolean().optional(),
  /**
   * An install from a repository (or a catalog app built from source): the
   * rebuild the admin reviewed, which replaces the catalog as the source of
   * the new version. `version` is its version.
   */
  prebuilt: prebuiltBuildParams.optional(),
  /**
   * For a sandbox tier app, whose new version is known only once it is built:
   * the admin accepted that the update may deploy it without a preview check.
   * Without it the job refuses such a version before anything changes.
   */
  confirmNoPreview: z.boolean().optional(),
  /**
   * A self-deploying tier app: its own installer deploys the new version
   * (see ./self-deploying/jobs.ts); none of the steps below apply.
   */
  selfDeploying: z.boolean().optional(),
  /**
   * For a self-deploying app: a replacement for the app's own token, stored
   * on the sandbox Worker before the installer runs. Only here, never in D1.
   */
  appToken: z.string().min(1).max(1024).optional(),
  /**
   * The admin confirmed the account is on Workers Paid when the new version
   * sets more cron triggers than the Worker has; the cron trigger count is
   * then skipped.
   */
  paidConfirmed: z.boolean().optional(),
});
export type UpdateJobParams = z.infer<typeof updateJobParams>;

/** The canary retries 1042 and route propagation for a shorter time: the Worker's route is already live. */
export const CANARY_MAX_ATTEMPTS = 6;

type SecretsUndoOutcome = "undone" | "not-needed" | "left" | "failed";

/** What the failure report adds about secret values the unpromoted upload carried. */
function secretsNote(outcome: SecretsUndoOutcome | null): string {
  switch (outcome) {
    case "undone":
      return " The secrets it introduced were taken off the Worker's newest version, so the next upload does not carry them.";
    case "left":
      return " Another version was uploaded meanwhile; it keeps whatever secrets it was given.";
    case "failed":
      return " Appflare could not take the secrets it introduced off the Worker's newest version: the next upload would carry them. Retry the update, or set those secrets as you want them, before changing the app's settings.";
    default:
      return "";
  }
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

export async function runUpdate(ctx: JobContext): Promise<void> {
  const parsed = updateJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid update job payload");
  const params = parsed.data;
  if (params.selfDeploying === true) {
    await runSelfDeployingUpdate(ctx, params);
    return;
  }
  const { step, env, deps } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;
  /** Set once the new version exists / serves traffic, for the failure report. */
  let uploadedVersionId: string | null = null;
  let promoted = false;
  /** Set once post-deploy migrations began: the database may be past the previous code. */
  let postDeployStarted = false;
  /** The install's record once the new version serves; written again if the job fails later. */
  let servingRecord: Partial<typeof installs.$inferInsert> | null = null;
  /** D1 databases that got new migration files (named when a failure leaves them ahead of the code). */
  const migrated: string[] = [];
  /** An app of several Workers: its other Workers already moved to the new version. */
  const promotedOthers: string[] = [];
  /** The other Workers whose promotion started, and the version each serves once promoted. */
  const attemptedOthers: string[] = [];
  const promotedVersions: Record<string, string> = {};
  /** The version each other Worker served when the snapshot was taken. */
  let snapshotOthers: Record<string, string> | null = null;
  /**
   * Other Workers the serving version keeps on workers.dev that this version
   * takes off it, before their uploads: a failure before promotion puts their
   * addresses back. With the account's subdomain, for their route records.
   */
  const takenOffWorkersDev: string[] = [];
  let routeSubdomain: string | null = null;
  /** The catalog version installed before the job, for the annotation of a return. */
  let previousVersion = "the previous version";
  /**
   * Its other Workers' uploads that carry secrets this version introduces,
   * for a failure before their promotion to take them off again.
   */
  const othersSecretsUndo: Array<{
    workerName: string;
    label: string;
    versionId: string;
    servingVersionId: string;
    names: string[];
    uploadMessage: string;
  }> = [];
  /**
   * Set once an uploaded version carries secrets this version introduces:
   * what a failure before promotion needs to take them off again.
   */
  let secretsUndo: {
    workerName: string;
    servingVersionId: string;
    names: string[];
    /** Those of `names` the serving version has too (a derived secret's source), put back rather than dropped. */
    kept: string[];
    /** The upload's annotation, which finds its version when the upload did not name it. */
    uploadMessage: string;
  } | null = null;

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
      let origin: ArtifactOrigin;
      if (params.prebuilt !== undefined) {
        // A reviewed rebuild: the catalog has no say, and its version need
        // not sort after the installed one (a commit's version need not).
        if (install.origin === "catalog" && params.prebuilt.origin === "repository") {
          throw new JobError("a catalog install cannot be replaced by a repository build");
        }
        origin = { kind: "prebuilt", build: params.prebuilt };
      } else {
        if (env.KV === undefined) throw new JobError("the catalog cache is not available");
        // Its own catalog only: another catalog listing the same slug never updates it.
        const app =
          (
            await readCachedListing(
              { KV: env.KV, DB: env.DB },
              install.catalog_id,
              install.app_slug,
            )
          )?.app ?? null;
        const refusal = updateRefusal({
          installedVersion: install.catalog_version,
          targetVersion: params.version,
          indexVersion: app?.version,
        });
        if (refusal !== null || app === null) {
          throw new JobError(refusal ?? "the app is no longer in the catalog");
        }
        const unsigned = unsignedTierRefusal(install.catalog_id, app.tier);
        if (unsigned !== null) throw new JobError(unsigned);
        origin = artifactOriginOf(app, params.buildConfirmed === true);
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
      const settings = await readSettings(orm, [
        SETTING.accountId,
        SETTING.accountPlan,
        SETTING.accountCapabilities,
      ]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!env.CF_API_TOKEN) {
        throw new JobError("the Cloudflare API token is not configured; finish setup first");
      }
      log.info(
        `Updating ${appSlugLabel(install.app_slug)} from ${install.catalog_version} to ${params.version} on Worker "${install.worker_name}".`,
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
        // The detected plan first, then the one an admin set.
        accountPaid:
          resolveAccountPlan(
            settings.account_plan,
            parseStoredCapabilities(settings.account_capabilities),
          ).plan === "paid",
        slug: install.app_slug,
        catalogId: install.catalog_id,
        workerName: install.worker_name,
        fromVersion: install.catalog_version,
        recordedVersionId: install.current_version_id,
        // Installs made before the tag was recorded applied every migration
        // of the manifest they were installed from.
        appliedDoTag: install.do_migration_tag ?? lastDurableObjectTagOf(install.manifest_json),
        // The installed version's exports: other ones take a whole-script deploy.
        servingExports: workerExportsOf(install.manifest_json),
        // The installed version's index shapes: a kept index cannot change shape.
        vectorizeShapes: vectorizeShapesOf(install.manifest_json),
        // The installed version's streams: a kept stream and its sink cannot change.
        pipelineShapes: pipelineShapesOf(install.manifest_json),
        // The installed version's queue consumers, to tell which ones change.
        previousConsumers: consumerPlansOf(install.manifest_json),
        // An app of several Workers: what the installed version's other Workers have.
        previousOthers: storedOtherWorkers(install.manifest_json, install.worker_name).map((w) => ({
          scriptName: w.scriptName,
          workersDev: w.workersDev,
          doTag: appliedDurableObjectTag(w.manifest.worker),
          exports: w.manifest.worker.exports,
          crons: w.manifest.worker.crons,
          consumers: consumerPlans(w.manifest.worker.queueConsumers),
        })),
        emailRouting: emailRoutingOfManifest(install.manifest_json),
        userVars: { ...parseVars(install.config_json), ...(params.vars ?? {}) },
        workersDev: install.workers_dev_enabled,
        servedDomain: install.served_domain,
        // The app's domains, live ones first, for where it is reached below.
        domains: domainHostnames(rows) as string[] | undefined,
        origin,
        resources: recorded,
      };
    });
    steps.setAccountId(started.accountId);
    const { workerName, workersDev } = started;

    // 1. The new artifact manifest (a sandbox tier app is built first),
    // verified with the keys of the install's own catalog and no others.
    steps.current = "catalog keys";
    const trust = await catalogTrust(createDb(env.DB), started.catalogId, deps.signingKeys).catch(
      (error: unknown) => {
        throw error instanceof CatalogTrustError ? new JobError(error.message) : error;
      },
    );
    const source = await resolveArtifactPhase(steps, env, trust.signingKeys, {
      installId: params.installId,
      catalogId: trust.catalogId,
      slug: started.slug,
      version: params.version,
      origin: started.origin,
    });
    const manifestText = source.manifestText;
    // The signed Worker; the form's secrets and vars from a revision when the catalog lists one.
    const manifest: ArtifactManifest = sourceManifest(source);
    // An app of several Workers: the primary one is the install's Worker and
    // goes through the steps below; the others are uploaded and checked
    // before it and promoted, one by one, right before it.
    const workers = entryWorkers(manifest, workerName);
    const primary = workers.find((w) => w.primary);
    if (primary === undefined) throw new JobError("the artifact has no primary Worker");
    const primaryManifest = primary.manifest;
    const others = workers.filter((w) => !w.primary);
    // A step output recorded before other Workers existed has none.
    const previousOthers = started.previousOthers ?? [];
    const previousOf = (name: string) => previousOthers.find((p) => p.scriptName === name);
    const addedOthers = others.filter((w) => previousOf(w.scriptName) === undefined);
    const droppedOthers = previousOthers.filter(
      (p) => !others.some((w) => w.scriptName === p.scriptName),
    );
    const entryNames = entryScriptNamesOf(manifest, workerName);
    const diff = diffBindings(
      workerName,
      entryBindings(manifest),
      started.resources,
      started.vectorizeShapes,
      manifest.catalog.resources?.hyperdrive ?? [],
      manifest.catalog.resources?.pipelines,
      // A step output recorded before streams were compared has none.
      started.pipelineShapes ?? {},
    );
    const queuePlan = planEntryQueueConsumers(workerName, manifest, workers);
    const queueDiff = diffConsumerQueues(queuePlan.queues, started.resources);
    // A step output recorded before exports were read has none: the installed
    // version was uploaded without them.
    const path = updatePath(primaryManifest, started.appliedDoTag, started.servingExports);
    const fullDeploy = path.fullDeploy;
    const recordedSecrets = started.resources.filter((r) => r.kind === "secret").map((r) => r.name);
    // A derived secret the Worker lacks comes with its source, which the
    // update asked for again and set together with the value derived from it;
    // so does the source of a derived var the update computed.
    const newSecrets = secretsToSet(
      manifest.catalog.secrets,
      missingSecrets(manifest.catalog.secrets, recordedSecrets),
      manifest.catalog.vars.flatMap((v) =>
        v.derive !== undefined && params.vars?.[v.name] !== undefined ? [v.derive.from] : [],
      ),
    );
    const secretValues: Record<string, string> = {};
    for (const secret of newSecrets) {
      const value = params.secrets[secret.name];
      if (value !== undefined && value.length > 0) secretValues[secret.name] = value;
    }
    // The new secrets the primary Worker gets; the others' ride on their own uploads.
    const primarySecretValues = Object.fromEntries(
      Object.entries(secretValues).filter(([name]) =>
        primaryManifest.catalog.secrets.some((s) => s.name === name),
      ),
    );
    const healthPath = appHealthPath(manifest.catalog.install);
    const healthMode = appHealthMode(manifest.catalog.install);

    await run("plan update", async ({ log }) => {
      const problems = [...diff.problems, ...queuePlan.problems, ...queueDiff.problems];
      // A prebuilt version's preview question was asked when the update
      // started; a sandbox build answers it only now.
      if (
        started.origin.kind !== "release" &&
        path.skipPreview !== null &&
        params.confirmNoPreview !== true
      ) {
        problems.push(
          `${path.skipPreview}. This became known only once the version was built; start the update again and confirm updating without a preview check.`,
        );
      }
      for (const secret of newSecrets) {
        if (secretValues[secret.name] === undefined) {
          problems.push(
            `No value was provided for ${secret.label} (${secret.name}), which this version introduces.`,
          );
        }
      }
      // The upload reads and sends every module in one invocation; refuse
      // before the snapshot rather than failing mid-upload.
      for (const w of workers) {
        const tooBig = workerUploadProblem(
          w.manifest.worker.modules,
          w.primary ? "This version" : `The Worker "${w.name}" of this version`,
        );
        if (tooBig !== null) problems.push(tooBig);
        // A class the serving exports declare must stay declared; Cloudflare
        // would refuse the upload, and for the primary only after the others
        // were already uploaded.
        const dropped = droppedDurableObjectExportsProblem(
          w.manifest.worker.exports,
          w.primary ? started.servingExports : previousOf(w.scriptName)?.exports,
          w.primary ? undefined : (w.name ?? w.scriptName),
        );
        if (dropped !== null) problems.push(dropped);
      }
      const paid =
        started.accountPaid || params.paidConfirmed === true || manifest.catalog.plan === "paid";
      const tooManyWorkers = workerCountProblem(workers.length, paid);
      if (tooManyWorkers !== null) problems.push(tooManyWorkers);
      // Every step of the job shares one Workflow instance's limits.
      const budget =
        workers.length > 1 ? entryJobCost(workers, "update", CANARY_MAX_ATTEMPTS) : null;
      const overBudget = budget === null ? null : entryBudgetProblem(budget, paid, workers.length);
      if (overBudget !== null) problems.push(overBudget);
      // A Worker new in this version would need every secret it gets, and
      // Appflare keeps no secret values to give it.
      for (const w of addedOthers) {
        problems.push(
          `This version adds the Worker "${w.name}" (${w.scriptName}), which an update cannot create; uninstall the app and install this version instead.`,
        );
      }
      if (problems.length > 0) throw new JobError(problems.join(" "));
      if (budget !== null) log.info(entryBudgetLine(budget, paid, workers.length));
      for (const p of droppedOthers) {
        log.warn(
          `This version no longer has the Worker "${p.scriptName}"; it is left in place and removed when the app is uninstalled.`,
        );
      }
      for (const res of diff.toCreate) {
        log.info(`New binding ${res.binding}: creating ${RESOURCE_LABEL[res.kind]} "${res.name}".`);
      }
      for (const res of queueDiff.toCreate) {
        log.info(`New queue for a consumer: creating ${RESOURCE_LABEL[res.kind]} "${res.name}".`);
      }
      for (const row of diff.leftInPlace) {
        log.info(
          `Binding ${row.binding} is not in this version; its ${row.kind} "${row.name}" is left in place.`,
        );
      }
      for (const secret of newSecrets) {
        log.info(`New secret ${secret.name}: set with the new version.`);
      }
      // TODO: apply `install.emailRouting` changes between versions (create and
      // delete routing rules, take over or give back the catch-all). The zone the
      // admin chose and the records of what the install set up exist only from the
      // install; until an update can reconcile them, the job warns in its log and
      // leaves Email Routing as the install set it up.
      const emailChange = emailRoutingChangeWarning(
        started.emailRouting,
        manifest.catalog.install.emailRouting,
        params.version,
      );
      if (emailChange !== null) log.warn(emailChange);
      if (fullDeploy !== null) {
        log.warn(
          `Durable Object migrations up to "${fullDeploy.new_tag}" are pending, so this update deploys the whole Worker at once instead of checking a preview first.`,
        );
      } else if (path.scriptUpload) {
        log.warn(
          "This version changes the Durable Object classes its exports declare, so this update deploys the whole Worker at once instead of checking a preview first.",
        );
      }
      log.info(
        `Plan: ${diff.existing.length + queueDiff.existing.length} resource(s) kept, ${diff.toCreate.length + queueDiff.toCreate.length} to create, ${diff.leftInPlace.length} left in place.`,
      );
      return {};
    });

    // The account's cron trigger limit, when this version sets more cron
    // triggers than the Worker has, before anything changes. Skipped on
    // Workers Paid: a paid app was confirmed on it when it was installed, the
    // admin confirmed it for this update, or Settings records it.
    // The other Workers' cron triggers are theirs, not recorded rows.
    const recordedCrons =
      started.resources.filter((r) => r.kind === "cron").length +
      previousOthers.reduce((n, p) => n + cronTriggerCount([...new Set(p.crons)]), 0);
    const wantedCrons = workers.reduce(
      (n, w) => n + cronTriggerCount([...new Set(w.manifest.worker.crons)]),
      0,
    );
    if (wantedCrons > recordedCrons) {
      await checkCronLimitPhase(steps, {
        workerName,
        wanted: wantedCrons,
        paid:
          manifest.catalog.plan === "paid" || params.paidConfirmed === true || started.accountPaid,
        subject: "this version",
      });
    }

    // 2. Snapshot, before anything changes.
    const snapshot = await takeSnapshotPhase(steps, {
      installId: params.installId,
      jobId: params.jobId,
      workerName,
      recordedVersionId: started.recordedVersionId,
      resources: started.resources,
      appliedDoTag: started.appliedDoTag,
      targetVersion: params.version,
      otherWorkers: others,
    });
    snapshotOthers = others.length === 0 ? null : snapshot.otherVersions;
    previousVersion = started.fromVersion;

    // 3. Resources for new bindings; nothing is deleted.
    for (const wf of diff.newWorkflows) await checkWorkflowNamePhase(steps, wf);
    const bound = [...diff.existing, ...queueDiff.existing];
    for (const res of [...diff.toCreate, ...queueDiff.toCreate]) {
      bound.push(await provisionResourcePhase(steps, params.installId, res));
    }

    // Rate limits keep the install's namespaces; a new one gets its own.
    const rateLimitIds = await assignRateLimitsPhase(
      steps,
      params.installId,
      entryBindings(manifest),
    );

    // 4. Static assets.
    const assetsJwt = await uploadAssetsPhase(
      steps,
      workerName,
      source.zipUrl,
      primaryManifest.assets.files,
      source.host,
    );

    // Vars may name the Worker's URL (`{{workerUrl}}`), so the account's
    // workers.dev subdomain is known before the upload.
    const subdomain = await lookupSubdomainPhase(steps);
    // A stored value this version cannot read falls back to its default; the
    // upload step says so in its log.
    // Where the app is reached, for `{{workerUrl}}` and the health check below.
    const appBase = appBaseUrl({
      workerName,
      subdomain,
      workersDev,
      // A step output recorded before `domains` existed has only the resources.
      domains: started.domains ?? domainHostnames(started.resources),
      served: started.servedDomain,
    });
    const placeholders = entryPlaceholders(manifest, workerName, subdomain, appBase);
    const vars = installVars(primaryManifest, started.userVars, {
      workerName,
      subdomain,
      accountId: steps.accountId(),
      workerUrl: appBase,
      ...(placeholders === undefined ? {} : { entryWorkers: placeholders }),
    });

    /** The metadata of the upload (never logged: it holds new secret values). */
    function uploadMetadata(): ScriptMetadata {
      // Durable Object migrations go only to a full deploy, and only the
      // pending ones; the Worker has the others already.
      const { migrations: _all, ...base } = buildScriptMetadata({
        manifest: primaryManifest,
        workerName,
        resources: bound,
        vars: vars.vars,
        assetsJwt,
        workflowNames: diff.workflowNames,
        rateLimitIds,
        entryWorkers: entryNames,
      });
      const metadata: ScriptMetadata = {
        ...base,
        bindings: [...(base.bindings ?? []), ...secretBindings(primarySecretValues)],
        // Existing secrets are the only bindings carried over; everything else is sent above.
        keep_bindings: ["secret_text"],
      };
      if (fullDeploy !== null) metadata.migrations = fullDeploy;
      return metadata;
    }
    /** Every module read from the artifact and uploaded in ONE multipart request (one unit). */
    async function uploadWorker(
      log: StepTools["log"],
      metadata: ScriptMetadata,
      target: "script" | "version",
    ) {
      return settleUnit(
        await steps.units.api.uploadWorker({
          accountId: steps.accountId(),
          artifact: { zipUrl: source.zipUrl, host: source.host },
          workerName,
          modules: primaryManifest.worker.modules,
          metadata,
          target,
        }),
        log,
      );
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
      artifact_url: source.zipUrl,
      artifact_digest: source.digest,
      pin_sha: manifest.source.sha,
      ...source.provenance,
      do_migration_tag: fullDeploy?.new_tag ?? started.appliedDoTag,
      ...(others.length === 0
        ? {}
        : {
            worker_versions_json: JSON.stringify({
              ...snapshot.otherVersions,
              ...promotedVersions,
            }),
          }),
      // Derived vars computed for this update join the stored settings; the
      // snapshot keeps the settings from before, for a rollback.
      ...(Object.keys(params.vars ?? {}).length === 0
        ? {}
        : { config_json: storedVarsJson(started.userVars) }),
    });

    const databases = d1Targets(manifest, bound);
    /**
     * New D1 migration files, one database at a time, each followed by its
     * schema files; remembers which databases got new migrations, including
     * one where a later file failed. Schema files only create what is
     * missing, which the previous code never notices, so they do not count.
     */
    async function migrateDatabases(): Promise<void> {
      for (const target of databases) {
        // A baseline runs only on an empty database: one this update (or an
        // earlier attempt of it) created. One an earlier version set up has
        // tables or recorded migrations, and only takes the new migrations.
        await applyD1BaselinePhase(steps, source.zipUrl, target, source.host);
        await applyD1MigrationsPhase(
          steps,
          source.zipUrl,
          target,
          () => migrated.push(target.name),
          source.host,
        );
        await applyD1SchemaPhase(steps, source.zipUrl, target, source.host);
      }
    }

    // The other Workers' new versions, uploaded and checked before the
    // primary one; none serves until the promotions below.
    const entryContext: EntryUploadContext = {
      installId: params.installId,
      installWorkerName: workerName,
      source: { zipUrl: source.zipUrl, host: source.host },
      resources: bound,
      workflowNames: diff.workflowNames,
      rateLimitIds,
      userVars: started.userVars,
      subdomain,
      accountId: steps.accountId(),
      appUrl: appBase,
      placeholders,
      entryNames,
    };
    const otherUpdates: OtherWorkerUpdate[] = [];
    routeSubdomain = subdomain;
    for (const w of others) {
      if (!w.workersDev && previousOf(w.scriptName)?.workersDev !== false) {
        takenOffWorkersDev.push(w.scriptName);
      }
      const update = await prepareOtherWorkerPhase(steps, step, entryContext, w, {
        appliedDoTag: previousOf(w.scriptName)?.doTag ?? null,
        servingExports: previousOf(w.scriptName)?.exports,
        newSecrets: secretValues,
        // A step output recorded before the flag existed: every Worker was on workers.dev.
        wasOnWorkersDev: previousOf(w.scriptName)?.workersDev !== false,
        slug: started.slug,
        version: params.version,
        jobId: params.jobId,
        canaryAttempts: CANARY_MAX_ATTEMPTS,
      });
      otherUpdates.push(update);
      const serving = snapshot.otherVersions[w.scriptName];
      const names = Object.keys(update.introduced);
      if (update.versionId !== null && serving !== undefined && names.length > 0) {
        othersSecretsUndo.push({
          workerName: w.scriptName,
          label: workerLabel(w),
          versionId: update.versionId,
          servingVersionId: serving,
          names,
          uploadMessage: updateVersionMessage(started.slug, params.version, params.jobId),
        });
      }
    }
    /** The other Workers to their new versions, one by one, before the primary one. */
    async function promoteOthers(): Promise<void> {
      for (const update of otherUpdates) {
        attemptedOthers.push(update.worker.scriptName);
        promotedVersions[update.worker.scriptName] = await promoteOtherWorkerPhase(
          steps,
          entryContext,
          update,
          params.version,
        );
        promotedOthers.push(update.worker.scriptName);
      }
    }

    if (!path.scriptUpload) {
      // 5. The new version: every module in ONE multipart request. From here
      // until promotion, a failure takes the secrets it introduces off the
      // newest version again, even when the upload made a version and did not
      // say which (it is found by its annotation).
      const introduced = Object.keys(primarySecretValues);
      if (introduced.length > 0) {
        secretsUndo = {
          workerName,
          servingVersionId: snapshot.versionId,
          names: introduced,
          kept: introduced.filter((name) => recordedSecrets.includes(name)),
          uploadMessage: updateVersionMessage(started.slug, params.version, params.jobId),
        };
      }
      const uploaded = await run("upload Worker version", async ({ log }) => {
        for (const warning of vars.warnings) log.warn(warning);
        const metadata: VersionMetadata = {
          ...uploadMetadata(),
          annotations: {
            "workers/message": updateVersionMessage(started.slug, params.version, params.jobId),
            "workers/tag": params.version,
          },
        };
        const result = await uploadWorker(log, metadata, "version");
        if (result.versionId === null) {
          throw new JobError("Cloudflare did not report the id of the uploaded version");
        }
        log.info(
          `Uploaded version ${result.versionId} (${result.modules} module(s)); it serves no traffic yet.`,
          { versionId: result.versionId, bindings: bindingList(metadata) },
        );
        return { versionId: result.versionId, hasPreview: result.hasPreview };
      });
      uploadedVersionId = uploaded.versionId;
      await run("record Worker version", async ({ orm }) => {
        await recordUpload(orm, uploaded.versionId);
        return {};
      });

      // 6. Canary on the version's preview URL.
      const skip = path.skipPreview ?? canarySkipReason(uploaded.hasPreview, 0);
      if (skip !== null) {
        await run("skip canary", async ({ log }) => {
          log.warn(`${skip}.`);
          return {};
        });
      } else {
        await run("enable version previews", async ({ log, cf }) => {
          // The workers.dev URL stays as the admin left it; previews are always on.
          await cf().workers.enableSubdomain(workerName, workersDevSubdomain(workersDev));
          log.info("Preview URLs are enabled for this Worker.");
          return {};
        });
        await probeUntilHealthy(steps, step, {
          label: "canary",
          url: previewUrl(uploaded.versionId, workerName, subdomain, healthPath),
          healthyMessage: `version ${uploaded.versionId} is serving`,
          maxAttempts: CANARY_MAX_ATTEMPTS,
          expectVersion: params.version,
          mode: healthMode,
        });
      }

      // 7. D1 migrations: only files not applied yet, before promotion.
      await migrateDatabases();
      await promoteOthers();

      // 8. Promote. The API call is a step of its own, so the moment it
      // returns the job knows the new version serves traffic.
      await run("promote version", async ({ log, cf }) => {
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
      await promoteOthers();
      await run("skip canary", async ({ log }) => {
        log.warn(`${fullDeploy !== null ? FULL_DEPLOY_REASON : EXPORTS_DEPLOY_REASON}.`);
        return {};
      });
      const deployed = await run("deploy Worker script", async ({ log }) => {
        for (const warning of vars.warnings) log.warn(warning);
        const metadata = uploadMetadata();
        const result = await uploadWorker(log, metadata, "script");
        if (result.versionId === null) {
          throw new JobError("Cloudflare did not report the id of the deployed version");
        }
        log.info(
          fullDeploy !== null
            ? `Deployed version ${result.versionId} to all traffic with Durable Object migrations up to "${fullDeploy.new_tag}".`
            : `Deployed version ${result.versionId} to all traffic with its new Durable Object exports.`,
          { versionId: result.versionId, bindings: bindingList(metadata) },
        );
        return { versionId: result.versionId };
      });
      uploadedVersionId = deployed.versionId;
      promoted = true;
      servingRecord = servingState(deployed.versionId);
      await run("record Worker version", async ({ orm }) => {
        await recordUpload(orm, deployed.versionId);
        return {};
      });
    }

    const record = servingRecord;
    await run("record promotion", async ({ orm }) => {
      await orm
        .update(installs)
        .set({ ...record, updated_at: new Date(now()) })
        .where(eq(installs.id, params.installId));
      return {};
    });

    // Queue consumers belong to the script too: set them once the version
    // serves, each Worker's own; the primary Worker's sync, last, removes
    // those no Worker of the version has.
    for (const w of others) {
      await syncQueueConsumersPhase(steps, {
        installId: params.installId,
        workerName: w.scriptName,
        wanted: queuePlan.consumers.get(w.scriptName) ?? [],
        previous: previousOf(w.scriptName)?.consumers ?? [],
        queues: bound,
        recorded: started.resources,
        removeUnwanted: false,
      });
    }
    await syncQueueConsumersPhase(steps, {
      installId: params.installId,
      workerName,
      wanted: queuePlan.consumers.get(workerName) ?? [],
      // A job started before consumers were tracked has no record of them.
      previous: started.previousConsumers ?? [],
      queues: bound,
      recorded: started.resources,
      keepKeys: others.flatMap((w) =>
        (queuePlan.consumers.get(w.scriptName) ?? []).map((c) => c.queueKey),
      ),
    });

    // Cron triggers last of the script's settings: a refusal at the account's
    // limit is only a warning, and nothing after it depends on them.
    await syncCronsPhase(
      steps,
      params.installId,
      workerName,
      started.resources.filter((r) => r.kind === "cron").map((r) => r.name),
      primaryManifest.worker.crons,
    );
    for (const w of others) {
      await setOtherWorkerCronsPhase(
        steps,
        w,
        w.manifest.worker.crons,
        previousOf(w.scriptName)?.crons ?? [],
      );
    }
    // A Worker the installed version kept off workers.dev and this one puts
    // on it gets its URL now that the new version serves. The other way round
    // was done before its upload (`prepareOtherWorkerPhase`).
    for (const w of others) {
      if (w.workersDev && previousOf(w.scriptName)?.workersDev === false) {
        await otherWorkerRoutePhase(steps, params.installId, w, subdomain);
      }
    }

    // Hyperdrive configurations a settings change superseded are bound only
    // by versions before this update's snapshot, which is the latest now.
    await deleteSupersededPhase(steps, supersededConfigs(started.resources));

    // 9. Live health check, recorded rather than fatal: the version already serves.
    const url = `${appBase}${healthPath}`;
    const health = await checkLiveHealthPhase(steps, step, url, healthMode);

    // 10. Post-deploy migrations, once no request reaches the previous code
    // and everything else about the new version (queue consumers, cron
    // triggers) is in place, so a failure here leaves nothing else behind.
    // Nothing reverts them, a rollback included (see applyD1PostDeployPhase).
    for (const target of databases) {
      if (target.postDeploy.length > 0) postDeployStarted = true;
      await applyD1PostDeployPhase(steps, source.zipUrl, target, source.host);
    }

    // A sandbox build stays in the bucket while it may be needed: the version
    // now serving and the one before it (which a rollback returns to).
    if (source.provenance.build_kind === "sandbox") {
      await cleanupSandboxBuildsPhase(steps, env, params.installId, [
        params.version,
        started.fromVersion,
      ]);
    }

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
        // Builds waiting for review lost their objects to the clean-up above.
        orm
          .update(source_builds)
          .set({ status: "discarded", updated_at: at })
          .where(
            and(eq(source_builds.install_id, params.installId), eq(source_builds.status, "built")),
          ),
      ]);
      log.info(
        `Updated ${appSlugLabel(started.slug)} from ${started.fromVersion} to ${params.version} at ${url} (health: ${healthLabel(health)}).`,
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
    // The unpromoted upload is the Worker's newest version, and the next
    // upload (with `keep_bindings: ["secret_text"]`) would copy the secret
    // values it introduced from it: take them off first, as a failed settings
    // change does (see ./reconfigure/secrets.ts).
    let secretsBack: SecretsUndoOutcome | null = null;
    const undo = secretsUndo;
    if (!wasPromoted && undo !== null) {
      try {
        secretsBack = await undoSecretChangesPhase(steps, {
          jobId: params.jobId,
          workerName: undo.workerName,
          uploadedVersionId: version,
          uploadMessage: undo.uploadMessage,
          servingVersionId: undo.servingVersionId,
          // Only the names matter: each one the serving version lacks is
          // dropped, each one it has gets its serving value back.
          changes: { set: {}, unset: undo.names },
          slots: secretSlots([], undo.kept),
          carrier: "upload",
          undoneMessage: updateSecretsUndoneMessage(params.jobId),
        });
      } catch {
        secretsBack = "failed";
      }
    }
    // The same for each other Worker's unpromoted upload.
    const othersBack: string[] = [];
    for (const undoOther of othersSecretsUndo) {
      if (promotedOthers.includes(undoOther.workerName)) continue;
      try {
        await undoSecretChangesPhase(steps, {
          jobId: params.jobId,
          workerName: undoOther.workerName,
          uploadedVersionId: undoOther.versionId,
          uploadMessage: undoOther.uploadMessage,
          servingVersionId: undoOther.servingVersionId,
          changes: { set: {}, unset: undoOther.names },
          slots: [],
          carrier: "upload",
          undoneMessage: updateSecretsUndoneMessage(params.jobId),
          label: undoOther.label,
        });
      } catch {
        othersBack.push(undoOther.workerName);
      }
    }
    // The primary Worker still serves the previous version: the other Workers
    // whose promotion started go back to the versions the snapshot kept, so
    // the app runs one version again. Each return is one deployment call to
    // a version that already exists, so a retried step repeats it harmlessly.
    const returned: string[] = [];
    const othersPromoted: string[] = [];
    let othersRecord: Record<string, string> | null = null;
    if (!wasPromoted && snapshotOthers !== null && attemptedOthers.length > 0) {
      const kept = snapshotOthers;
      const record: Record<string, string> = { ...kept };
      for (const name of attemptedOthers) {
        const back = kept[name];
        try {
          if (back === undefined) throw new Error("the snapshot has no version of it");
          await deployOtherWorkerVersionPhase(
            steps,
            { primary: false, scriptName: name },
            back,
            previousVersion,
          );
          returned.push(name);
        } catch {
          othersPromoted.push(name);
          // Serving the new version when its promotion finished; unknown otherwise.
          const now = promotedVersions[name];
          if (now === undefined) delete record[name];
          else record[name] = now;
        }
      }
      othersRecord = record;
    }
    // A Worker taken off workers.dev for this version gets its address back
    // while the version that wants it serves again (every Worker but those
    // whose return to the snapshot's version failed).
    const offSubdomain = routeSubdomain;
    const routesBack: string[] = [];
    if (!wasPromoted && offSubdomain !== null) {
      for (const name of takenOffWorkersDev) {
        if (othersPromoted.includes(name)) continue;
        try {
          await otherWorkerRoutePhase(
            steps,
            params.installId,
            { primary: false, scriptName: name, workersDev: true },
            offSubdomain,
          );
        } catch {
          routesBack.push(name);
        }
      }
    }
    const othersRecordJson = othersRecord === null ? null : JSON.stringify(othersRecord);
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
        .set({
          ...(serving ?? {}),
          ...(othersRecordJson === null ? {} : { worker_versions_json: othersRecordJson }),
          status: "installed",
          updated_at: at,
        })
        .where(and(eq(installs.id, params.installId), eq(installs.status, "updating")));
      const log = new StepLog(now);
      if (aheadOfCode.length > 0) {
        log.error(
          `The D1 database${aheadOfCode.length === 1 ? "" : "s"} ${aheadOfCode.join(", ")} ${aheadOfCode.length === 1 ? "is" : "are"} already migrated to the new schema while the previous code still serves. Retry the update, or restore ${aheadOfCode.length === 1 ? "it" : "them"} from this update's snapshot on the install page.`,
          { migrated: aheadOfCode },
        );
      }
      if (returned.length > 0) {
        log.error(
          `The app's Workers ${returned.map((n) => `"${n}"`).join(", ")} were back on the versions the snapshot kept, as the primary Worker still serves the previous version.`,
          { returned },
        );
      }
      if (othersPromoted.length > 0) {
        log.error(
          `The app's Workers ${othersPromoted.map((n) => `"${n}"`).join(", ")} may still serve the new version while the primary Worker serves the previous one. Roll back to this update's snapshot from the install page, or retry the update.`,
          { promoted: othersPromoted },
        );
      }
      if (routesBack.length > 0) {
        log.error(
          `Appflare could not turn the workers.dev URL of ${routesBack.map((n) => `"${n}"`).join(", ")} back on for the version it serves; retry the update, or roll back to this update's snapshot.`,
          { routesBack },
        );
      }
      if (othersBack.length > 0) {
        log.error(
          `Appflare could not take the secrets this version introduced off the newest version of ${othersBack.map((n) => `"${n}"`).join(", ")}; the next upload would carry them.`,
        );
      }
      if (wasPromoted && postDeployStarted) {
        log.error(
          `Update failed at "${failedAt}" after version ${version} was promoted: it serves all traffic and is recorded as the install's version. Post-deploy D1 migrations already applied stay applied, and rolling back would not undo them, so the previous version may not work with the database. Retry the update, or restore the database from this update's snapshot together with a rollback.`,
          { versionId: version },
        );
      } else if (wasPromoted) {
        log.error(
          `Update failed at "${failedAt}" after version ${version} was promoted: it serves all traffic and is recorded as the install's version. Roll back from the install page if the app misbehaves.`,
          { versionId: version },
        );
      } else if (version !== null) {
        log.error(
          `Update failed at "${failedAt}". Version ${version} was uploaded but never promoted; the previous version keeps serving all traffic.${secretsNote(secretsBack)}`,
          { versionId: version },
        );
      } else {
        log.error(
          `Update failed at "${failedAt}". Nothing was deployed; the previous version keeps serving all traffic. Resources created so far stay recorded.${secretsNote(secretsBack)}`,
        );
      }
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }
}
