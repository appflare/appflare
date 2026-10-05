import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  accessBypassPaths,
  accessNeededOnlyIfProtected,
  accessOfferOf,
  catalogWorkerName,
  connectionStringProblems,
  hyperdriveDeclarations,
  indexArtifactsSchema,
  isOptionalSecret,
  isSeedOnly,
  sha256Schema,
  workerUploadProblem,
} from "@appflare/schema";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";
import { accessPlaceholderValues } from "../access/placeholder-values.server";
import { parseStoredCapabilities, resolveAccountPlan } from "../capabilities/capabilities";
import { CatalogTrustError, catalogTrust } from "../catalog/catalogs.server";
import { cronTriggerCount } from "../catalog/cron-triggers";
import {
  requirementLabel,
  requirementSentence,
  requirementsToConfirm,
} from "../catalog/requirements";
import { createDb, type Database } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { accessRequiredRefusal } from "../installs/access-offer";
import { installDomainInput, workerNameSchema } from "../installs/install-input";
import { varsUseWorkerUrl } from "../installs/install-vars";
import { workersDevUrl } from "../installs/post-install";
import { appSlugLabel } from "../installs/source-review";
import { workersDevSubdomain } from "../installs/workers-dev";
import {
  accountWorkersProblem,
  entryBudgetLine,
  entryBudgetProblem,
  entryJobCost,
} from "./entry-budget";
import {
  type EntryWorker,
  entryBindings,
  entryNameProblems,
  entryPlaceholders,
  entryScriptNamesOf,
  entryWorkers,
  otherEntryWorkers,
  workerCountProblem,
} from "./entry-workers";
import {
  coverWorkersPhase,
  keepWorkersUnreachablePhase,
  protectBeforeUploadPhase,
  syncAccessPhase,
} from "./install/access";
import {
  type ArtifactOrigin,
  prebuiltBuildParams,
  resolveArtifactPhase,
  revisedCatalogRef,
  sandboxBuildParams,
  sourceManifest,
} from "./install/artifact-source";
import { planBindings, withWorkflowRefs } from "./install/bindings";
import { checkCronLimitPhase, putSchedulesChecked } from "./install/cron-limit";
import { seedD1Phase, seedOnlyValuesSchema, seedValues } from "./install/d1-seed";
import { installDomainPhase, servedAddressPhase, unservedWildcardPhase } from "./install/domain";
import {
  checkEmailRoutingPhase,
  emailRoutingJobInput,
  provisionEmailRoutingPhase,
} from "./install/email-routing";
import {
  deployOtherWorkerPhase,
  type EntryUploadContext,
  otherWorkerRoutePhase,
  planEntryQueueConsumers,
} from "./install/entry-worker-phases";
import { healthColumns, healthLabel } from "./install/health";
import { buildScriptMetadata, type CreatedResource, installVars } from "./install/metadata";
import {
  applyD1BaselinePhase,
  applyD1MigrationsPhase,
  applyD1PostDeployPhase,
  applyD1SchemaPhase,
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
import {
  checkPipelinesPhase,
  pipelineTokenProblems,
  provisionPipelinePhase,
} from "./install/pipelines";
import { attachQueueConsumersPhase } from "./install/queue-consumers";
import { explainR2Refusal } from "./install/r2-enablement";
import { assignRateLimitsPhase } from "./install/rate-limits";
import { putWorkflowsPhase, workflowsOf, workflowTargets } from "./install/workflows";
import type { JobContext } from "./run-job";
import { awaitSandboxEnabledPhase, sandboxEnableJobField } from "./sandbox-enable-wait";
import { runSelfDeployingInstall } from "./self-deploying/jobs";
import { selfDeployingJobInput } from "./self-deploying/phases";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError } from "./steps";
import { settleUnit } from "./units/result";
import { appliedDurableObjectTag } from "./update/plan";

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
  /**
   * The custom catalog the app comes from (`catalogs.id`), whose keys alone
   * verify its release; absent for the official catalog (and in jobs started
   * by an earlier manager version).
   */
  catalogId: z.string().min(1).max(64).optional(),
  version: z.string().min(1),
  workerName: workerNameSchema,
  /** The signed release; absent for a sandbox tier app, which is built instead. */
  artifacts: indexArtifactsSchema.optional(),
  digest: sha256Schema.optional(),
  /**
   * With the release: the revised catalog manifest the index lists for it,
   * whose form the admin filled in. Optional; a job started by an earlier
   * manager version does not carry it.
   */
  revisedCatalog: revisedCatalogRef.optional(),
  /** A sandbox tier app: what the sandbox Worker builds, and the admin's cost confirmation. */
  build: sandboxBuildParams.optional(),
  /**
   * A build the admin reviewed: a repository, or a catalog app built from
   * source at another commit. Already built; the job installs it as it is.
   */
  prebuilt: prebuiltBuildParams.optional(),
  /**
   * A self-deploying tier app: the catalog manifest its installer comes from,
   * the admin's cost confirmation, and the app's own token (which the job
   * stores on the sandbox Worker; never in D1).
   */
  selfDeploying: selfDeployingJobInput.optional(),
  secrets: z.record(z.string(), z.string()),
  /**
   * Connection strings by Hyperdrive binding, for the databases the app
   * reaches through Hyperdrive. Credentials: like secret values, they live
   * only here; `jobs.input_json` keeps the binding names. Optional because a
   * job started by an earlier manager version does not carry them.
   */
  hyperdrive: z.record(z.string(), z.string()).optional(),
  vars: z.record(z.string(), z.string()),
  /**
   * The seed-only secrets and vars the admin entered, for the app's D1 seed
   * statements. Like secret values, they live only here: `jobs.input_json`,
   * the install's settings and the Worker never get them. Optional because
   * only an app with seed-only values has them.
   */
  seed: seedOnlyValuesSchema.optional(),
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
  /**
   * The `sandbox_enable` job that turns sandbox builds on first, when the
   * install needs them and they were off at the start; the job waits for it.
   */
  sandboxEnableJob: sandboxEnableJobField,
  /**
   * Protect the app with Cloudflare Access from its first request on (see
   * ./install/access.ts). Optional because a job started by an earlier
   * manager version does not carry it.
   */
  access: z.boolean().optional(),
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
    // Starting such an install refuses Access protection; never deploy one unprotected.
    if (params.access === true) {
      throw new NonRetryableError(
        "an app deployed by its own installer cannot be protected with Cloudflare Access yet",
      );
    }
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
    params.prebuilt !== undefined
      ? { kind: "prebuilt", build: params.prebuilt }
      : params.build !== undefined
        ? { kind: "sandbox", build: params.build }
        : params.artifacts !== undefined && params.digest !== undefined
          ? {
              kind: "release",
              artifacts: params.artifacts,
              digest: params.digest,
              ...(params.revisedCatalog === undefined ? {} : { revised: params.revisedCatalog }),
            }
          : null;
  if (origin === null) throw new NonRetryableError("invalid install job payload: no artifact");

  /**
   * With Cloudflare Access: the app's Workers from their first upload until
   * Access covers them by their tags. A failure in between takes them off
   * workers.dev with their previews before the job fails.
   */
  let uncovered: string[] = [];
  try {
    await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      log.info(
        `Installing ${appSlugLabel(params.slug)} ${params.version} as Worker "${params.workerName}".`,
      );
      return {};
    });
    if (params.sandboxEnableJob !== undefined) {
      await awaitSandboxEnabledPhase(steps, step, env, params.sandboxEnableJob);
    }

    // 1. Fetch and verify the artifact manifest (a sandbox tier app is built
    // first; a self-deploying one never gets here, see the top), with the
    // keys of the catalog the app comes from and no others.
    steps.current = "catalog keys";
    const trust = await catalogTrust(createDb(db), params.catalogId, deps.signingKeys).catch(
      (error: unknown) => {
        throw error instanceof CatalogTrustError ? new InstallError(error.message) : error;
      },
    );
    const source = await resolveArtifactPhase(steps, env, trust.signingKeys, {
      installId: params.installId,
      catalogId: trust.catalogId,
      slug: params.slug,
      version: params.version,
      origin,
    });
    const manifestText = source.manifestText;
    // The signed Worker; the form's secrets and vars from a revision when the catalog lists one.
    const manifest: ArtifactManifest = sourceManifest(source);
    // An app of several Workers: the primary one is the install's own Worker
    // and goes through the steps below; the others are deployed around it,
    // in the order their bindings to each other need.
    const workers = entryWorkers(manifest, params.workerName);
    const primary = workers.find((w) => w.primary);
    if (primary === undefined) throw new NonRetryableError("the artifact has no primary Worker");
    const primaryManifest = primary.manifest;
    const others = otherEntryWorkers(manifest, params.workerName);
    const entryNames = entryScriptNamesOf(manifest, params.workerName);
    // Resources are the app's, shared by binding name across its Workers.
    const databases = hyperdriveDeclarations(manifest.catalog.resources?.hyperdrive);
    const plan = planBindings(
      params.workerName,
      entryBindings(manifest),
      databases,
      manifest.catalog.resources?.pipelines,
    );
    const queuePlan = planEntryQueueConsumers(params.workerName, manifest, workers);
    const primaryConsumers = queuePlan.consumers.get(params.workerName) ?? [];
    // Hyperdrive configurations first: Cloudflare connects to the database
    // when one is created, so an unreachable database stops the install
    // before anything else exists in the account. Pipelines streams last:
    // each comes with a sink that writes to a bucket, which may be one of
    // the app's R2 bindings created before it.
    const toCreate = [
      ...plan.resources.filter((r) => r.type === "hyperdrive"),
      ...plan.resources.filter((r) => r.type !== "hyperdrive" && r.type !== "pipelines"),
      ...queuePlan.queues,
    ];
    const streams = plan.resources.filter(
      (r): r is Extract<typeof r, { type: "pipelines" }> => r.type === "pipelines",
    );

    // 2. Preflight.
    const preflight = await run("preflight checks", async ({ log, orm }) => {
      if (manifest.catalog.plan === "paid" && !params.paidConfirmed) {
        throw new InstallError(
          "this app needs Workers Paid; confirm the account is on Workers Paid to install it",
        );
      }
      const { requires } = manifest.catalog;
      // Cloudflare Access, when the entry needs it only while the app is
      // protected, is no requirement to confirm: protection is checked itself.
      const toConfirm = requirementsToConfirm(manifest.catalog);
      if (requires.length > 0) {
        if (toConfirm.length > 0 && params.requirementsConfirmed === false) {
          throw new InstallError(
            `this app needs ${toConfirm.map(requirementLabel).join(", ")}; confirm the account meets these requirements to install it`,
          );
        }
        for (const requirement of requires) {
          log.info(
            `Requires ${requirementLabel(requirement)}: ${requirementSentence(requirement, { tier: manifest.catalog.install.tier, provisionsEmailRouting: manifest.catalog.install.emailRouting !== undefined, accessIfProtected: accessNeededOnlyIfProtected(manifest.catalog) }) ?? "see the app's catalog page."}`,
          );
        }
        if (toConfirm.length > 0 && params.requirementsConfirmed === true) {
          log.info("The admin confirmed this account meets these requirements.");
        }
      }
      const problems = [
        ...plan.problems,
        ...queuePlan.problems,
        ...entryNameProblems(manifest, params.workerName),
        // Messages name the binding and the part at fault, never the string.
        ...connectionStringProblems(databases, params.hyperdrive ?? {}),
        // Each Pipelines sink needs the token the admin entered for it.
        ...pipelineTokenProblems(streams, params.secrets),
        // An app that must be protected is never installed without it.
        ...(params.access !== true && accessOfferOf(manifest.catalog) === "required"
          ? [accessRequiredRefusal(manifest.catalog.name)]
          : []),
      ];
      if (problems.length > 0) throw new InstallError(problems.join(" "));
      // The upload reads and sends every module in one invocation; refuse
      // before anything is created rather than failing mid-upload.
      for (const w of workers) {
        const tooBig = workerUploadProblem(
          w.manifest.worker.modules,
          w.primary ? "This app version" : `The Worker "${w.name}" of this app version`,
        );
        if (tooBig !== null) throw new InstallError(tooBig);
      }
      // The Worker name is the unique key of an active install; an app whose
      // Worker name is fixed installs once.
      const fixed = manifest.catalog.install.fixedWorkerName;
      const fixedName = catalogWorkerName(manifest.catalog);
      if (fixed && params.workerName !== fixedName) {
        throw new InstallError(`this app only works as the Worker "${fixedName}"`);
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
      // The app's other Workers take names of their own, which no other
      // install may use either.
      const otherNames = workers.filter((w) => !w.primary).map((w) => w.scriptName);
      if (otherNames.length > 0) {
        const taken = await orm
          .select({ name: resources.name })
          .from(resources)
          .innerJoin(installs, eq(installs.id, resources.install_id))
          .where(
            and(
              ne(resources.install_id, params.installId),
              eq(resources.kind, "worker"),
              isNull(resources.deleted_at),
              ne(installs.status, "uninstalled"),
              inArray(resources.name, otherNames),
            ),
          )
          .limit(1);
        const primaries = await orm
          .select({ worker: installs.worker_name })
          .from(installs)
          .where(
            and(
              ne(installs.id, params.installId),
              ne(installs.status, "uninstalled"),
              inArray(installs.worker_name, otherNames),
            ),
          )
          .limit(1);
        const name = taken[0]?.name ?? primaries[0]?.worker;
        if (name !== undefined) {
          throw new InstallError(
            `another install already uses the Worker name "${name}", which this app needs for one of its Workers; choose another Worker name`,
          );
        }
      }
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
      // The detected plan first, then the one an admin set.
      const resolved = resolveAccountPlan(
        settings.account_plan,
        parseStoredCapabilities(settings.account_capabilities),
      );
      const accountPaid = resolved.plan === "paid";
      // Free only when detected or set so, not by default: the account's
      // Worker limit is checked against the free plan's only then.
      const accountFree = resolved.plan === "free" && resolved.source !== "default";
      const tooManyWorkers = workerCountProblem(
        workers.length,
        accountPaid || params.paidConfirmed,
      );
      if (tooManyWorkers !== null) throw new InstallError(tooManyWorkers);
      // Every step of the job shares one Workflow instance's step and
      // subrequest limits, so the app's Workers are counted against them
      // before anything is created.
      if (workers.length > 1) {
        const paid = accountPaid || params.paidConfirmed;
        const cost = entryJobCost(workers, "install", 0);
        const overBudget = entryBudgetProblem(cost, paid, workers.length);
        if (overBudget !== null) throw new InstallError(overBudget);
        log.info(entryBudgetLine(cost, paid, workers.length));
      }
      log.info(
        `Preflight passed: plan ${manifest.catalog.plan}, ${toCreate.length + streams.length} resource(s) to create.`,
      );
      return { accountId: settings.account_id, accountPaid, accountFree };
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
      for (const w of workers) {
        if (scripts.some((s) => s.id === w.scriptName)) {
          throw new InstallError(
            `a Worker named ${w.scriptName} already exists in this account; Appflare does not adopt existing Workers`,
          );
        }
      }
      // The same list counts the account's Workers against its plan's limit:
      // the free plan's only when the account is known to be on it (a step
      // output recorded before the field existed is not), else Workers Paid's.
      const noRoom = accountWorkersProblem(
        scripts.length,
        workers.length,
        preflight.accountFree === true && !preflight.accountPaid && !params.paidConfirmed
          ? "free"
          : "paid",
      );
      if (noRoom !== null) throw new InstallError(noRoom);
      log.info(
        workers.length === 1
          ? `No Worker named "${params.workerName}" exists yet.`
          : `No Worker named ${workers.map((w) => `"${w.scriptName}"`).join(", ")} exists yet.`,
      );
      return {};
    });

    for (const wf of plan.workflows) await checkWorkflowNamePhase(steps, wf);

    // An account without R2 refuses every R2 call. Ask once before creating
    // anything, so that failure leaves nothing behind to clean up.
    const firstBucket =
      toCreate.find((r) => r.kind === "r2") ??
      streams
        .map((s) => s.pipeline.bucket)
        .filter((b) => b.create)
        .map((b) => ({ name: b.name }))[0];
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
    const crons = [...new Set(primaryManifest.worker.crons)];
    await checkCronLimitPhase(steps, {
      workerName: params.workerName,
      // Every Worker of the app counts its own.
      wanted: workers.reduce(
        (n, w) => n + cronTriggerCount([...new Set(w.manifest.worker.crons)]),
        0,
      ),
      paid: params.paidConfirmed || preflight.accountPaid,
      subject: "this app",
    });

    // Pipelines too: a token without its permission, or an account without
    // it, is refused before anything is created.
    if (streams.length > 0) {
      await checkPipelinesPhase(steps, { accountPaid: preflight.accountPaid });
    }

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

    // Cloudflare Access, when the admin asked for it: the application comes
    // before anything of the app exists, covering each Worker's future
    // workers.dev hostname, so the app is never reachable without it.
    // Nothing of the app is created when this is refused. An external
    // domain the form asked for is covered here too (a `public`
    // destination), before its custom hostname is made.
    const protect = params.access === true;
    const accessExternalHosts = params.domain?.kind === "external" ? [params.domain.hostname] : [];
    // Its audience tag and team domain exist from here on, so the first
    // upload already carries them (`{{accessAud}}` and the others).
    const accessValues = protect
      ? accessPlaceholderValues(
          await protectBeforeUploadPhase(steps, {
            installId: params.installId,
            appName: manifest.catalog.name,
            workers: workers.map((w) => w.scriptName),
            pendingExternalHosts: accessExternalHosts,
            acceptPaths: accessBypassPaths(manifest.catalog),
          }),
        )
      : null;

    // 3. Resources: check the name is free, create, then record.
    const created: CreatedResource[] = [];
    for (const res of toCreate) {
      created.push(
        await provisionResourcePhase(steps, params.installId, res, params.hyperdrive ?? {}),
      );
    }
    for (const res of streams) {
      // The preflight checked the token is there.
      const token = params.secrets[res.pipeline.declared.sink.tokenSecret] ?? "";
      created.push(await provisionPipelinePhase(steps, params.installId, res, token));
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
      entryBindings(manifest),
    );

    // Vars may name the Worker's addresses (`{{workerUrl}}`, `{{appUrl}}`), so the account's
    // workers.dev subdomain is known before the upload.
    const subdomain = await lookupSubdomainPhase(steps);
    // A binding that runs a Workflow another Worker of the app defines sends that Workflow's name.
    const workflowNames = withWorkflowRefs(
      Object.fromEntries(plan.workflows.map((w) => [w.binding, w.name])),
      plan.workflowRefs,
    );
    const placeholders = entryPlaceholders(manifest, params.workerName, subdomain);
    // Each Workflow the app defines, created once the Worker that runs it is uploaded.
    const workflows = workflowTargets(manifest, params.workerName, workflowNames);
    // The wildcard domain the form asked for, set up once the Worker serves:
    // `{{wildcardHostname}}` names it from the first upload on, and is
    // deployed again without it when the domain step does not set it up.
    const wildcardHostname = params.domain?.kind === "wildcard" ? params.domain.hostname : null;
    const entryContext: EntryUploadContext = {
      installId: params.installId,
      installWorkerName: params.workerName,
      source: { zipUrl: source.zipUrl, host: source.host },
      resources: created,
      workflowNames,
      workflows,
      rateLimitIds,
      userVars: params.vars,
      subdomain,
      accountId: steps.accountId(),
      wildcardHostname,
      access: accessValues,
      placeholders,
      entryNames,
    };
    /** Deploys the app's other Workers, each with its secrets, crons, consumers and route. */
    /** The version each other Worker serves once deployed, recorded on the install. */
    const otherVersions: Record<string, string> = {};
    /** Each other Worker's script tag, for Cloudflare Access; null when its upload did not say. */
    const otherTags: Record<string, string | null> = {};
    async function deployOthers(list: readonly EntryWorker[]): Promise<void> {
      for (const w of list) {
        const deployed = await deployOtherWorkerPhase(steps, entryContext, w, {
          secrets: params.secrets,
          consumers: queuePlan.consumers.get(w.scriptName) ?? [],
          attachConsumers: (s, name, plans) =>
            attachQueueConsumersPhase(s, params.installId, name, plans, created),
          // With Access, routes wait until Access covers every Worker by its tag.
          deferRoute: protect,
        });
        if (deployed.versionId !== null) otherVersions[w.scriptName] = deployed.versionId;
        otherTags[w.scriptName] = deployed.tag;
      }
    }
    // The other Workers the primary one binds to exist before it is uploaded.
    if (protect) uncovered = workers.map((w) => w.scriptName);
    await deployOthers(others.before);

    // 4. Static assets.
    const assetsJwt = await uploadAssetsPhase(
      steps,
      params.workerName,
      source.zipUrl,
      primaryManifest.assets.files,
      source.host,
    );

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
      const vars = installVars(primaryManifest, params.vars, {
        workerName: params.workerName,
        subdomain,
        accountId: steps.accountId(),
        wildcardHostname,
        access: accessValues,
        ...(placeholders === undefined ? {} : { entryWorkers: placeholders }),
      });
      for (const warning of vars.warnings) log.warn(warning);
      const metadata = buildScriptMetadata({
        manifest: primaryManifest,
        workerName: params.workerName,
        resources: created,
        vars: vars.vars,
        assetsJwt,
        workflowNames,
        rateLimitIds,
        entryWorkers: entryNames,
      });
      try {
        // Every module in ONE multipart request, read and uploaded by one unit.
        const result = settleUnit(
          await steps.units.api.uploadWorker({
            accountId: steps.accountId(),
            artifact: { zipUrl: source.zipUrl, host: source.host },
            workerName: params.workerName,
            modules: primaryManifest.worker.modules,
            metadata,
            target: "script",
          }),
          log,
        );
        log.info(`Uploaded Worker "${params.workerName}" (${result.modules} module(s)).`, {
          versionId: result.versionId,
          bindings: (metadata.bindings ?? []).map((b) => `${b.type} ${b.name}`),
        });
        return {
          versionId: result.versionId,
          scriptId: result.scriptId ?? params.workerName,
          tag: result.tag ?? null,
        };
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

    // The script is live from here on: record it even if a later step fails.
    await run("record Worker script", async ({ orm }) => {
      await orm
        .update(installs)
        .set({
          current_version_id: upload.versionId,
          // The upload applied every Durable Object migration the manifest has.
          // None when Durable Object exports replaced the migrations.
          do_migration_tag: appliedDurableObjectTag(primaryManifest.worker),
          updated_at: new Date(now()),
        })
        .where(eq(installs.id, params.installId));
      await orm
        .update(resources)
        .set({ cf_id: upload.scriptId })
        .where(eq(resources.id, resourceId(params.installId, "worker", params.workerName)));
      return {};
    });

    // The Workflows the primary Worker defines, now that it runs their classes
    // (the upload created none; each other Worker's come after its own upload).
    await putWorkflowsPhase(
      steps,
      params.installId,
      workflowsOf(workflows, params.workerName),
      () => true,
      "install",
    );

    // The other Workers that bind to the primary one, now that it exists.
    await deployOthers(others.after);

    // Every Worker is uploaded: Cloudflare Access covers each by its tag
    // (previews, custom domains and routes too) before any of them is
    // turned on anywhere. On failure the Workers are taken off workers.dev
    // with their previews, and the install fails.
    if (protect) {
      await coverWorkersPhase(steps, {
        installId: params.installId,
        appName: manifest.catalog.name,
        workers: workers.map((w) => ({
          name: w.scriptName,
          // A step output recorded before tags were read has none: looked up.
          tag: w.primary ? upload.tag : otherTags[w.scriptName],
        })),
        pendingExternalHosts: accessExternalHosts,
        acceptPaths: accessBypassPaths(manifest.catalog),
      });
      uncovered = [];
      for (const w of [...others.before, ...others.after]) {
        if (w.workersDev) {
          await otherWorkerRoutePhase(steps, params.installId, w, subdomain);
        }
      }
    }

    // 6. D1 migrations, wrangler-style, once for every Worker of the app,
    // then each database's schema files.
    const d1Databases = d1Targets(manifest, created);
    // The seed statements read the vars the Worker got and the secrets set
    // below, besides the seed-only values; each seed runs once, here.
    const seedInput = (seed: NonNullable<(typeof d1Databases)[number]["seed"]>) =>
      seedValues(seed, {
        catalog: manifest.catalog,
        workerVars: installVars(primaryManifest, params.vars, {
          workerName: params.workerName,
          subdomain,
          accountId: steps.accountId(),
          wildcardHostname,
          access: accessValues,
          ...(placeholders === undefined ? {} : { entryWorkers: placeholders }),
        }).vars,
        secrets: params.secrets,
        seedOnly: params.seed,
        // The app is served on workers.dev while the install runs: a
        // domain the form asked for goes live only after the seeds.
        placeholders: {
          workerName: params.workerName,
          workerUrl: workersDevUrl(params.workerName, subdomain),
          appUrl: workersDevUrl(params.workerName, subdomain),
          accountId: steps.accountId(),
          wildcardHostname,
          access: accessValues,
        },
      });
    for (const target of d1Databases) {
      // Every database here is new, so a baseline runs first and records the
      // migrations as applied; the migrations phase then has nothing to do.
      // A retried job finds it already run (tables there) and skips it.
      await applyD1BaselinePhase(steps, source.zipUrl, target, source.host);
      await applyD1MigrationsPhase(steps, source.zipUrl, target, undefined, source.host);
      // A seed that claims a row before a schema file adds its default one.
      if (target.seed?.beforeSchema === true) {
        await seedD1Phase(steps, { ...target, seed: target.seed }, seedInput(target.seed));
      }
      await applyD1SchemaPhase(steps, source.zipUrl, target, source.host);
    }
    // The upload above already put the Worker in front of all traffic, so
    // the post-deploy migrations follow at once, recorded like the others,
    // then every other seed, once each database has all its tables.
    for (const target of d1Databases) {
      await applyD1PostDeployPhase(steps, source.zipUrl, target, source.host);
      if (target.seed !== undefined && target.seed.beforeSchema !== true) {
        await seedD1Phase(steps, { ...target, seed: target.seed }, seedInput(target.seed));
      }
    }

    // 7. Secrets. An optional secret the admin left unset gets no step, and
    // a seed-only one (used by the seed above) is never set on the Worker.
    for (const secret of primaryManifest.catalog.secrets) {
      if (isSeedOnly(secret)) continue;
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
      primaryConsumers,
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
      `https://${host}${manifest.catalog.install.health.path}`,
      manifest.catalog.install.health.mode,
      { installId: params.installId },
    );

    // The address the admin asked for besides workers.dev, now that the
    // Worker serves; reported in the log, never a reason to fail.
    let servedBy: string | null = null;
    if (params.domain !== undefined) {
      ({ servedBy } = await installDomainPhase(steps, {
        db,
        installId: params.installId,
        workerName: params.workerName,
        domain: params.domain,
        health: {
          path: manifest.catalog.install.health.path,
          mode: manifest.catalog.install.health.mode,
        },
        settingsUseWorkerUrl: varsUseWorkerUrl(manifest, params.vars),
      }));
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
            ...(others.before.length + others.after.length === 0
              ? {}
              : { worker_versions_json: JSON.stringify(otherVersions) }),
            manifest_json: manifestText,
            artifact_url: source.zipUrl,
            artifact_digest: source.digest,
            ...source.provenance,
            ...healthColumns(health, new Date(health.checkedAt)),
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
        `Installed ${appSlugLabel(params.slug)} ${params.version} at ${servedBy === null ? url : `https://${servedBy}/`} (health: ${healthLabel(health)}).`,
      );
      return {};
    });
    // With Access: the application lists exactly the addresses the install
    // has now (an external domain was covered before it was added), and the
    // app's public paths (`access.bypass`) are made public on each of them,
    // which needs the manifest recorded above. Until then those paths ask
    // for a sign-in like the rest. Never fails the job.
    if (protect) await syncAccessPhase(steps, params.installId);
    // The settings named the wildcard domain before its step ran; when the
    // step did not set it up, they are deployed again without it. Never throws.
    if (wildcardHostname !== null) {
      await unservedWildcardPhase(steps, env, {
        installId: params.installId,
        hostname: wildcardHostname,
      });
    }
    // The domain took over from workers.dev: settings that use the app's
    // address (`{{appUrl}}`) are deployed again with it. Never throws.
    if (servedBy !== null) {
      await servedAddressPhase(steps, env, { installId: params.installId, hostname: servedBy });
    }
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    // Fail closed: nothing of an app meant to be behind Access stays reachable.
    if (uncovered.length > 0) await keepWorkersUnreachablePhase(steps, uncovered);
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
