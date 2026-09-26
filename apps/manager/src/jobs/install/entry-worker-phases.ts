import { CloudflareApiError, type ScriptMetadata } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  type EntryWorkerPlaceholders,
  isOptionalSecret,
} from "@appflare/schema";
import { and, eq, isNull } from "drizzle-orm";
import { resources } from "../../db/schema";
import { workersDevSubdomain } from "../../installs/workers-dev";
import { type EntryWorker, entryBindings, workerLabel } from "../entry-workers";
import type { SecretChanges } from "../reconfigure/plan";
import { applySecretChangesPhase } from "../reconfigure/secrets";
import type { StepRunner } from "../run-job";
import { isNotFound, JobError, type JobSteps } from "../steps";
import { settleUnit } from "../units/result";
import type { ArtifactHost } from "../units/units";
import {
  activeVersionId,
  canarySkipReason,
  type DurableObjectMigrationUpload,
  durableObjectMigrationsSince,
  NO_PREVIEW_REASON,
  previewUrl,
  secretBindings,
  updateVersionMessage,
} from "../update/plan";
import type { ResourceBindingPlan } from "./bindings";
import { CronLimitError, putSchedulesChecked } from "./cron-limit";
import { buildScriptMetadata, type CreatedResource, installVars } from "./metadata";
import { probeUntilHealthy, recordResource, resourceId, uploadAssetsPhase } from "./phases";
import { type ConsumerPlan, planQueueConsumers } from "./queue-consumers";

/**
 * The phases that deploy, update, roll back and delete the Workers of an app
 * of several Workers other than the primary one (see ../entry-workers.ts).
 * The primary Worker goes through the jobs' own steps; each other Worker gets
 * the same treatment here, with its Worker name in every step name so the
 * steps of different Workers never share a name.
 */

/** Where the jobs read the artifact from. */
export interface ArtifactSource {
  zipUrl: string;
  host: ArtifactHost;
}

/** What every Worker's upload needs to know about the app as a whole. */
export interface EntryUploadContext {
  installId: string;
  /** The install's (primary) Worker name: `{{workerName}}` and the resources' prefix. */
  installWorkerName: string;
  source: ArtifactSource;
  /** Every resource the app binds, by binding. */
  resources: readonly CreatedResource[];
  workflowNames: Readonly<Record<string, string>>;
  rateLimitIds: Readonly<Record<string, string>>;
  /** The vars the admin set (values for the catalog's vars). */
  userVars: Readonly<Record<string, string>>;
  subdomain: string;
  accountId: string;
  /** The app's address, for `{{workerUrl}}`; its workers.dev URL when unset. */
  appUrl?: string;
  placeholders: EntryWorkerPlaceholders | undefined;
  /** Each Worker's name within the entry to its installed name. */
  entryNames: Readonly<Record<string, string>>;
}

/** The metadata of one Worker's upload, with its own vars and bindings. */
function workerMetadata(
  ctx: EntryUploadContext,
  worker: EntryWorker,
  assetsJwt: string | null,
): { metadata: ScriptMetadata; warnings: string[] } {
  const vars = installVars(worker.manifest, ctx.userVars, {
    workerName: ctx.installWorkerName,
    subdomain: ctx.subdomain,
    accountId: ctx.accountId,
    ...(ctx.appUrl === undefined ? {} : { workerUrl: ctx.appUrl }),
    ...(ctx.placeholders === undefined ? {} : { entryWorkers: ctx.placeholders }),
  });
  const metadata = buildScriptMetadata({
    manifest: worker.manifest,
    workerName: worker.scriptName,
    resources: ctx.resources,
    vars: vars.vars,
    assetsJwt,
    workflowNames: ctx.workflowNames,
    rateLimitIds: ctx.rateLimitIds,
    entryWorkers: ctx.entryNames,
  });
  return { metadata, warnings: vars.warnings };
}

/** The queues and consumers of every Worker of the app, planned together. */
export interface EntryQueuePlan {
  /** Queues no binding sends to, each once. */
  queues: ResourceBindingPlan[];
  /** Each Worker's consumers, by installed Worker name. */
  consumers: Map<string, ConsumerPlan[]>;
  problems: string[];
}

/**
 * Plans every Worker's queue consumers against the bindings of all the
 * app's Workers: a queue one Worker sends to and another consumes is one
 * queue, named by the producer binding.
 */
export function planEntryQueueConsumers(
  installWorkerName: string,
  manifest: ArtifactManifest,
  workers: readonly EntryWorker[],
): EntryQueuePlan {
  const bindings = entryBindings(manifest);
  const queues = new Map<string, ResourceBindingPlan>();
  const consumers = new Map<string, ConsumerPlan[]>();
  const problems = new Set<string>();
  for (const w of workers) {
    const plan = planQueueConsumers(installWorkerName, {
      bindings,
      queueConsumers: w.manifest.worker.queueConsumers,
    });
    for (const q of plan.queues) queues.set(q.name, q);
    for (const p of plan.problems) problems.add(p);
    consumers.set(w.scriptName, plan.consumers);
  }
  return { queues: [...queues.values()], consumers, problems: [...problems] };
}

/**
 * Install: one other Worker of the app, after the resources exist and the
 * Workers it binds to are deployed. Its assets, the script (recorded before
 * the upload, like the primary Worker's), its secrets, cron triggers, queue
 * consumers, and its workers.dev address, which it always keeps: only the
 * primary Worker is the app's address.
 */
export async function deployOtherWorkerPhase(
  steps: JobSteps,
  ctx: EntryUploadContext,
  worker: EntryWorker,
  input: {
    secrets: Readonly<Record<string, string>>;
    consumers: readonly ConsumerPlan[];
    attachConsumers: (
      steps: JobSteps,
      workerName: string,
      plans: readonly ConsumerPlan[],
    ) => Promise<void>;
  },
): Promise<{ versionId: string | null }> {
  const { run, now } = steps;
  const label = workerLabel(worker);
  const name = worker.scriptName;
  const own = worker.manifest;
  const assetsJwt = await uploadAssetsPhase(
    steps,
    name,
    ctx.source.zipUrl,
    own.assets.files,
    ctx.source.host,
    label,
  );
  await run(`record Worker name${label}`, async ({ orm }) => {
    await recordResource(
      orm,
      ctx.installId,
      { kind: "worker", key: name, binding: null, name, cfId: null },
      new Date(now()),
    );
    return {};
  });
  const upload = await run(`upload Worker script${label}`, async ({ log, orm }) => {
    const { metadata, warnings } = workerMetadata(ctx, worker, assetsJwt);
    for (const warning of warnings) log.warn(warning);
    try {
      const result = settleUnit(
        await steps.units.api.uploadWorker({
          accountId: steps.accountId(),
          artifact: { zipUrl: ctx.source.zipUrl, host: ctx.source.host },
          workerName: name,
          modules: own.worker.modules,
          metadata,
          target: "script",
        }),
        log,
      );
      log.info(`Uploaded Worker "${name}" (${result.modules} module(s)).`, {
        versionId: result.versionId,
        bindings: (metadata.bindings ?? []).map((b) => `${b.type} ${b.name}`),
      });
      return { versionId: result.versionId, scriptId: result.scriptId ?? name };
    } catch (error) {
      // A refused upload created no Worker: release the pending row, as for
      // the primary Worker.
      if (error instanceof CloudflareApiError && error.status < 500 && error.status !== 429) {
        await orm
          .update(resources)
          .set({ deleted_at: new Date(now()) })
          .where(
            and(
              eq(resources.id, resourceId(ctx.installId, "worker", name)),
              isNull(resources.cf_id),
            ),
          );
        log.warn(`Cloudflare refused the upload; no Worker "${name}" was created.`);
      }
      throw error;
    }
  });
  await run(`record Worker script${label}`, async ({ orm }) => {
    await orm
      .update(resources)
      .set({ cf_id: upload.scriptId })
      .where(eq(resources.id, resourceId(ctx.installId, "worker", name)));
    return {};
  });
  for (const secret of own.catalog.secrets) {
    const value = input.secrets[secret.name];
    if (isOptionalSecret(secret) && (value ?? "").length === 0) continue;
    await run(`set secret ${secret.name}${label}`, async ({ log, cf, orm }) => {
      if (value === undefined || value.length === 0) {
        throw new JobError(`no value was provided for the secret ${secret.name}`);
      }
      await cf().workers.putSecret(name, { name: secret.name, text: value });
      await recordResource(
        orm,
        ctx.installId,
        { kind: "secret", key: secret.name, binding: secret.name, name: secret.name, cfId: null },
        new Date(now()),
      );
      log.info(`Set secret ${secret.name} on Worker "${name}".`);
      return {};
    });
  }
  const crons = [...new Set(own.worker.crons)];
  if (crons.length > 0) {
    await run(`set cron triggers${label}`, async ({ log, cf }) => {
      // Recorded with the Worker, not as rows of their own: they go when it does.
      await putSchedulesChecked(
        cf(),
        name,
        crons,
        `The Worker "${name}" is uploaded without them; uninstall this install to remove it.`,
      );
      log.info(`Set ${crons.length} cron trigger(s) on Worker "${name}": ${crons.join(", ")}.`);
      return {};
    });
  }
  await input.attachConsumers(steps, name, input.consumers);
  await enableOtherWorkerRoutePhase(steps, ctx.installId, worker, ctx.subdomain);
  return { versionId: upload.versionId };
}

/** Turns on (and records) the other Worker's workers.dev address, with version previews. */
export async function enableOtherWorkerRoutePhase(
  steps: JobSteps,
  installId: string,
  worker: EntryWorker,
  subdomain: string,
): Promise<void> {
  const host = `${worker.scriptName}.${subdomain}.workers.dev`;
  await steps.run(`enable workers.dev route${workerLabel(worker)}`, async ({ log, cf, orm }) => {
    await cf().workers.enableSubdomain(worker.scriptName, workersDevSubdomain(true));
    await recordResource(
      orm,
      installId,
      { kind: "subdomain", key: host, binding: null, name: host, cfId: null },
      new Date(steps.now()),
    );
    log.info(`Enabled https://${host}.`);
    return {};
  });
}

/** One other Worker's part of an update, between its upload and its promotion. */
export interface OtherWorkerUpdate {
  worker: EntryWorker;
  /** The assets completion token, for a full deploy at promotion; null without assets. */
  assetsJwt: string | null;
  /**
   * Durable Object migrations the Worker does not have yet: it is deployed
   * whole at promotion (Cloudflare applies them only on a full upload, which
   * serves at once), with no version and no preview before. Null otherwise.
   */
  pending: DurableObjectMigrationUpload | null;
  /** The uploaded version, not serving yet; null when `pending` defers the upload. */
  versionId: string | null;
  /** The secrets this version introduces that the upload carries. */
  introduced: Record<string, string>;
}

/** The metadata of one other Worker's update upload: its secrets carried over, new ones added. */
function updateMetadata(
  ctx: EntryUploadContext,
  update: Pick<OtherWorkerUpdate, "worker" | "assetsJwt" | "introduced">,
): { metadata: ScriptMetadata; warnings: string[] } {
  const { metadata: full, warnings } = workerMetadata(ctx, update.worker, update.assetsJwt);
  const { migrations: _all, ...base } = full;
  return {
    metadata: {
      ...base,
      bindings: [...(base.bindings ?? []), ...secretBindings(update.introduced)],
      keep_bindings: ["secret_text"],
    },
    warnings,
  };
}

/**
 * Update: prepares one other Worker's new version. Uploads its assets and
 * the version, which serves no traffic until {@link promoteOtherWorkerPhase},
 * and checks it on its preview URL (any answer but a 5xx; a Worker that
 * implements a Durable Object has none). A version with Durable Object
 * migrations the Worker lacks is deployed whole at promotion instead.
 * Secrets the version introduces ride on the upload; the rest are carried over.
 */
export async function prepareOtherWorkerPhase(
  steps: JobSteps,
  step: StepRunner,
  ctx: EntryUploadContext,
  worker: EntryWorker,
  input: {
    /** The last Durable Object migration tag the installed version of this Worker has. */
    appliedDoTag: string | null;
    /** Values of the secrets this version introduces, by name. */
    newSecrets: Readonly<Record<string, string>>;
    slug: string;
    version: string;
    jobId: string;
    canaryAttempts: number;
  },
): Promise<OtherWorkerUpdate> {
  const label = workerLabel(worker);
  const name = worker.scriptName;
  const own = worker.manifest;
  const pending = durableObjectMigrationsSince(own.worker.migrations, input.appliedDoTag) ?? null;
  const assetsJwt = await uploadAssetsPhase(
    steps,
    name,
    ctx.source.zipUrl,
    own.assets.files,
    ctx.source.host,
    label,
  );
  const introduced: Record<string, string> = {};
  for (const s of own.catalog.secrets) {
    const value = input.newSecrets[s.name];
    if (value !== undefined) introduced[s.name] = value;
  }
  const update: OtherWorkerUpdate = { worker, assetsJwt, pending, versionId: null, introduced };
  if (pending !== null) {
    await steps.run(`skip canary${label}`, async ({ log }) => {
      log.warn(
        `Durable Object migrations up to "${pending.new_tag}" are pending for Worker "${name}", so it is deployed whole when the update promotes, without a preview check.`,
      );
      return {};
    });
    return update;
  }
  const uploaded = await steps.run(`upload Worker version${label}`, async ({ log }) => {
    const { metadata: base, warnings } = updateMetadata(ctx, update);
    for (const warning of warnings) log.warn(warning);
    const metadata: ScriptMetadata = {
      ...base,
      annotations: {
        "workers/message": updateVersionMessage(input.slug, input.version, input.jobId),
        "workers/tag": input.version,
      },
    };
    const result = settleUnit(
      await steps.units.api.uploadWorker({
        accountId: steps.accountId(),
        artifact: { zipUrl: ctx.source.zipUrl, host: ctx.source.host },
        workerName: name,
        modules: own.worker.modules,
        metadata,
        target: "version",
      }),
      log,
    );
    if (result.versionId === null) {
      throw new JobError(`Cloudflare did not report the id of the version of "${name}"`);
    }
    log.info(
      `Uploaded version ${result.versionId} of Worker "${name}" (${result.modules} module(s)); it serves no traffic yet.`,
      { versionId: result.versionId },
    );
    return { versionId: result.versionId, hasPreview: result.hasPreview };
  });
  const skip = canarySkipReason(uploaded.hasPreview, 0);
  if (skip !== null) {
    await steps.run(`skip canary${label}`, async ({ log }) => {
      log.warn(`${skip}.`);
      return {};
    });
  } else {
    await steps.run(`enable version previews${label}`, async ({ log, cf }) => {
      await cf().workers.enableSubdomain(name, workersDevSubdomain(true));
      log.info(`Preview URLs are enabled for Worker "${name}".`);
      return {};
    });
    await probeUntilHealthy(steps, step, {
      label: `canary${label}`,
      url: previewUrl(uploaded.versionId, name, ctx.subdomain),
      healthyMessage: `version ${uploaded.versionId} of "${name}" is serving`,
      maxAttempts: input.canaryAttempts,
    });
  }
  return { ...update, versionId: uploaded.versionId };
}

/**
 * Update: one other Worker's new version to 100% of its traffic, after the
 * D1 migrations and before the primary Worker. A Worker with pending Durable
 * Object migrations is deployed whole here. Returns the version now serving.
 */
export async function promoteOtherWorkerPhase(
  steps: JobSteps,
  ctx: EntryUploadContext,
  update: OtherWorkerUpdate,
  version: string,
  /** The deployment's annotation; an update's by default. */
  message = `Appflare: update to ${version}`,
): Promise<string> {
  const name = update.worker.scriptName;
  const label = workerLabel(update.worker);
  const versionId = update.versionId;
  const pending = update.pending;
  if (versionId !== null) {
    await steps.run(`promote version${label}`, async ({ log, cf }) => {
      await cf().versions.createDeployment(name, {
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { "workers/message": message },
      });
      log.info(`Version ${versionId} of Worker "${name}" now serves all traffic.`);
      return {};
    });
    return versionId;
  }
  if (pending === null) throw new JobError(`no version of "${name}" was uploaded`);
  const deployed = await steps.run(`deploy Worker script${label}`, async ({ log }) => {
    const { metadata: base, warnings } = updateMetadata(ctx, update);
    for (const warning of warnings) log.warn(warning);
    const result = settleUnit(
      await steps.units.api.uploadWorker({
        accountId: steps.accountId(),
        artifact: { zipUrl: ctx.source.zipUrl, host: ctx.source.host },
        workerName: name,
        modules: update.worker.manifest.worker.modules,
        metadata: { ...base, migrations: pending },
        target: "script",
      }),
      log,
    );
    if (result.versionId === null) {
      throw new JobError(`Cloudflare did not report the id of the version of "${name}"`);
    }
    log.info(
      `Deployed version ${result.versionId} of Worker "${name}" to all traffic with Durable Object migrations up to "${pending.new_tag}".`,
      { versionId: result.versionId },
    );
    return { versionId: result.versionId };
  });
  return deployed.versionId;
}

/** The part of a settings change's secrets that goes to Workers that get `names`. */
export function secretChangesFor(changes: SecretChanges, names: readonly string[]): SecretChanges {
  const wanted = new Set(names);
  return {
    set: Object.fromEntries(Object.entries(changes.set).filter(([name]) => wanted.has(name))),
    unset: changes.unset.filter((name) => wanted.has(name)),
  };
}

/** Whether a settings change's secrets change anything. */
function changesAny(changes: SecretChanges): boolean {
  return Object.keys(changes.set).length > 0 || changes.unset.length > 0;
}

/**
 * Settings change: a new version of one other Worker with the same code, its
 * new vars and, through the versions secrets API, its secret changes, checked
 * on its preview URL. Promoted by {@link promoteOtherWorkerPhase} before the
 * primary Worker. `uploadedVersionId` is the upload the secrets patch was
 * made from, which a failure before promotion needs to put the secrets back.
 */
export async function reconfigureOtherWorkerPhase(
  steps: JobSteps,
  step: StepRunner,
  ctx: EntryUploadContext,
  worker: EntryWorker,
  input: {
    changes: SecretChanges;
    slug: string;
    version: string;
    jobId: string;
    canaryAttempts: number;
  },
): Promise<OtherWorkerUpdate & { uploadedVersionId: string; secretsPatched: boolean }> {
  const label = workerLabel(worker);
  const name = worker.scriptName;
  const own = worker.manifest;
  const assetsJwt = await uploadAssetsPhase(
    steps,
    name,
    ctx.source.zipUrl,
    own.assets.files,
    ctx.source.host,
    label,
  );
  const uploaded = await steps.run(`upload Worker version${label}`, async ({ log }) => {
    const { metadata: base, warnings } = updateMetadata(ctx, {
      worker,
      assetsJwt,
      introduced: {},
    });
    for (const warning of warnings) log.warn(warning);
    const result = settleUnit(
      await steps.units.api.uploadWorker({
        accountId: steps.accountId(),
        artifact: { zipUrl: ctx.source.zipUrl, host: ctx.source.host },
        workerName: name,
        modules: own.worker.modules,
        metadata: {
          ...base,
          annotations: {
            "workers/message": `Appflare: settings of ${input.slug} ${input.version}`,
            "workers/tag": input.version,
          },
        },
        target: "version",
      }),
      log,
    );
    if (result.versionId === null) {
      throw new JobError(`Cloudflare did not report the id of the version of "${name}"`);
    }
    log.info(
      `Uploaded version ${result.versionId} of Worker "${name}" with the new settings; it serves no traffic yet.`,
      { versionId: result.versionId },
    );
    return { versionId: result.versionId, hasPreview: result.hasPreview };
  });
  const secretsPatched = changesAny(input.changes);
  const final = secretsPatched
    ? await applySecretChangesPhase(steps, {
        jobId: input.jobId,
        workerName: name,
        uploadedVersionId: uploaded.versionId,
        version: input.version,
        changes: input.changes,
        label,
      })
    : { versionId: uploaded.versionId };
  const implementsDurableObject = own.worker.bindings.some(
    (b) =>
      b.type === "durable_object_namespace" &&
      (typeof b.script_name !== "string" || b.script_name.length === 0),
  );
  const skip = implementsDurableObject
    ? NO_PREVIEW_REASON
    : canarySkipReason(uploaded.hasPreview, 0);
  if (skip !== null) {
    await steps.run(`skip canary${label}`, async ({ log }) => {
      log.warn(`${skip}.`);
      return {};
    });
  } else {
    await steps.run(`enable version previews${label}`, async ({ log, cf }) => {
      await cf().workers.enableSubdomain(name, workersDevSubdomain(true));
      log.info(`Preview URLs are enabled for Worker "${name}".`);
      return {};
    });
    await probeUntilHealthy(steps, step, {
      label: `canary${label}`,
      url: previewUrl(final.versionId, name, ctx.subdomain),
      healthyMessage: `version ${final.versionId} of "${name}" is serving with the new settings`,
      maxAttempts: input.canaryAttempts,
    });
  }
  return {
    worker,
    assetsJwt,
    pending: null,
    versionId: final.versionId,
    introduced: {},
    uploadedVersionId: uploaded.versionId,
    secretsPatched,
  };
}

/**
 * Update and rollback: gives one other Worker the cron triggers its version
 * has. They are not recorded as rows of their own (the Worker takes them with
 * it); a refusal at the account's limit is a warning, as for the primary.
 */
export async function setOtherWorkerCronsPhase(
  steps: JobSteps,
  worker: Pick<EntryWorker, "primary" | "scriptName">,
  crons: readonly string[],
  before: readonly string[],
): Promise<void> {
  const wanted = [...new Set(crons)];
  const had = [...new Set(before)];
  if (wanted.length === had.length && wanted.every((c) => had.includes(c))) return;
  await steps.run(`set cron triggers${workerLabel(worker)}`, async ({ log, cf }) => {
    try {
      await putSchedulesChecked(
        cf(),
        worker.scriptName,
        wanted,
        `The version serves traffic; the Worker "${worker.scriptName}" keeps the cron triggers it had (${had.length > 0 ? had.join(", ") : "none"}).`,
        "then the next update or rollback sets them",
      );
    } catch (error) {
      if (!(error instanceof CronLimitError)) throw error;
      log.warn(error.message);
      return {};
    }
    log.info(
      wanted.length === 0
        ? `Removed every cron trigger of Worker "${worker.scriptName}".`
        : `Set ${wanted.length} cron trigger(s) on Worker "${worker.scriptName}": ${wanted.join(", ")}.`,
    );
    return {};
  });
}

/**
 * Snapshot: the version each other Worker serves now, by Worker name. Read
 * before anything changes, with the primary Worker's.
 */
export async function readOtherWorkerVersionsPhase(
  steps: JobSteps,
  workers: readonly EntryWorker[],
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const w of workers) {
    const got = await steps.run(`read current deployment${workerLabel(w)}`, async ({ log, cf }) => {
      const versionId = activeVersionId(await cf().versions.listDeployments(w.scriptName));
      if (versionId === null) {
        throw new JobError(
          `no single version serves all of the Worker "${w.scriptName}"'s traffic (a gradual deployment is in progress); finish or undo it in the Cloudflare dashboard first`,
        );
      }
      log.info(`Version ${versionId} serves all traffic of Worker "${w.scriptName}".`);
      return { versionId };
    });
    versions[w.scriptName] = got.versionId;
  }
  return versions;
}

/** Rollback: puts one other Worker back on the version the snapshot recorded. */
export async function deployOtherWorkerVersionPhase(
  steps: JobSteps,
  worker: Pick<EntryWorker, "primary" | "scriptName">,
  versionId: string,
  toVersion: string,
): Promise<void> {
  await steps.run(`deploy snapshot version${workerLabel(worker)}`, async ({ log, cf }) => {
    // Forced for the same reason as the primary Worker's rollback.
    await cf().versions.createDeployment(worker.scriptName, {
      versions: [{ version_id: versionId, percentage: 100 }],
      annotations: { "workers/message": `Appflare: roll back to ${toVersion}` },
      force: true,
    });
    log.info(`Version ${versionId} of Worker "${worker.scriptName}" now serves all traffic.`);
    return {};
  });
}

/** A recorded Worker of the install other than the primary one. */
export interface OtherWorkerRow {
  id: string;
  name: string;
}

/**
 * Uninstall: deletes the app's other Workers, before the primary one, each
 * with its routes, cron triggers, secrets and Durable Objects. One already
 * gone counts as deleted.
 */
export async function deleteOtherWorkersPhase(
  steps: JobSteps,
  rows: readonly OtherWorkerRow[],
): Promise<void> {
  for (const row of rows) {
    await steps.run(`delete Worker ${row.name}`, async ({ log, cf, orm }) => {
      try {
        await cf().workers.deleteScript(row.name, { force: true });
        log.info(
          `Deleted Worker "${row.name}" with its routes, cron triggers, secrets, and Durable Objects.`,
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
        log.info(`Worker "${row.name}" was already gone.`);
      }
      // Its workers.dev address is marked with the primary Worker's, which
      // goes last and marks everything bound to the install's Workers.
      await orm
        .update(resources)
        .set({ deleted_at: new Date(steps.now()) })
        .where(eq(resources.id, row.id));
      return {};
    });
  }
}
