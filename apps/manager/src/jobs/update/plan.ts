import type { WorkerDeployment } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  type CatalogPipeline,
  type CatalogPipelines,
  type CatalogSecret,
  catalogPipelinesSchema,
  catalogR2BucketSchema,
  type DoMigration,
  durableObjectExports,
  type HyperdriveDeclaration,
  hasDurableObjectExports,
  isOptionalSecret,
  isSeedOnly,
  managedR2LifecycleRuleId,
  type R2LifecycleRule,
  r2LifecycleApiRule,
  sameDurableObjectExports,
  type VectorizeIndexConfig,
  vectorizeBindingSchema,
  type WorkerBinding,
  type WorkerExports,
  workerExportsSchema,
} from "@appflare/schema";
import { z } from "zod";
import { isUpdateAvailable } from "../../catalog/versions";
import { appPlace } from "../../components/app-links";
import type { BuildKind, InstallOrigin, snapshots } from "../../db/schema";
import {
  type BindingPlan,
  type DurableObjectPlan,
  planBindings,
  RESOURCE_BINDINGS,
  type ResourceBindingPlan,
  type WorkflowPlan,
  withWorkflowRefs,
} from "../install/bindings";
import type { CreatedResource } from "../install/metadata";

/**
 * The pure decisions of the update and rollback jobs: whether an update may
 * run at all, which bindings need a new resource, which Durable Object
 * migrations are pending, which version serves traffic now, what a snapshot
 * row holds, and where a version's preview lives.
 */

/**
 * Why an update to `targetVersion` must not run, or null when it may. The
 * target must be the catalog's current version of the app and newer than the
 * installed one.
 */
export function updateRefusal(input: {
  installedVersion: string;
  targetVersion: string;
  /** The catalog index's current version of the app; undefined when the app is not listed. */
  indexVersion: string | undefined;
}): string | null {
  const { installedVersion, targetVersion, indexVersion } = input;
  if (indexVersion === undefined) return "the app is no longer in the catalog";
  if (targetVersion !== indexVersion) {
    return `${targetVersion} is not the catalog's current version of the app (${indexVersion})`;
  }
  if (targetVersion === installedVersion) return `version ${targetVersion} is already installed`;
  if (!isUpdateAvailable(installedVersion, targetVersion)) {
    return `${targetVersion} is older than the installed version ${installedVersion}`;
  }
  return null;
}

/** A live `resources` row of the install, as the update job reads it. */
export interface RecordedResource {
  id: string;
  kind: string;
  binding: string | null;
  name: string;
  cfId: string | null;
}

export interface BindingDiff {
  plan: BindingPlan;
  /** Bindings whose resource is already recorded, with their ids. */
  existing: CreatedResource[];
  /** Bindings new in this version: their resources are created before the upload. */
  toCreate: ResourceBindingPlan[];
  /**
   * Kept Vectorize indexes and R2 buckets whose settings the job brings up to
   * this version before the upload, under their recorded names: indexes this
   * version declares metadata indexes for, and buckets it declares lifecycle
   * rules for or the installed version did (`previouslyDeclared`).
   */
  toConfigure: Array<{ res: ResourceBindingPlan; previouslyDeclared: boolean }>;
  /** Workflow binding -> the account-wide Workflow name (recorded, or planned for new ones). */
  workflowNames: Record<string, string>;
  /** Workflows new in this version: their names must be free. */
  newWorkflows: WorkflowPlan[];
  /** Durable Object bindings new in this version (recorded after the upload). */
  newDurableObjects: DurableObjectPlan[];
  /**
   * Recorded resources no binding of the new version uses. An update never
   * deletes a resource: they stay in the account and stay recorded.
   */
  leftInPlace: RecordedResource[];
  /** Why the update cannot proceed; empty when it can. */
  problems: string[];
}

const PROVISIONED_KINDS: ReadonlySet<string> = new Set(Object.values(RESOURCE_BINDINGS));
const BOUND_KINDS: ReadonlySet<string> = new Set([
  ...PROVISIONED_KINDS,
  "workflow",
  "durable_object",
]);

/** Vectorize index shapes by binding name. */
export type VectorizeShapes = Readonly<Record<string, VectorizeIndexConfig>>;

/**
 * The dimensions and metric of each Vectorize binding in a stored artifact
 * manifest (the installed version's), by binding name. Bindings that do not
 * record a shape, and a manifest that does not parse, contribute nothing.
 */
export function vectorizeShapesOf(
  manifestJson: string | null,
): Record<string, VectorizeIndexConfig> {
  const shapes: Record<string, VectorizeIndexConfig> = {};
  if (manifestJson === null) return shapes;
  let bindings: unknown;
  try {
    bindings = (JSON.parse(manifestJson) as { worker?: { bindings?: unknown } }).worker?.bindings;
  } catch {
    return shapes;
  }
  if (!Array.isArray(bindings)) return shapes;
  for (const binding of bindings) {
    const parsed = vectorizeBindingSchema.safeParse(binding);
    if (parsed.success) {
      shapes[parsed.data.name] = { dimensions: parsed.data.dimensions, metric: parsed.data.metric };
    }
  }
  return shapes;
}

/** The lifecycle rules a stored manifest's catalog manifest declares, by R2 binding. */
export interface DeclaredLifecycle {
  rules: Record<string, R2LifecycleRule[]>;
  /** Bindings whose `resources.r2` entry does not parse: their rules are not known. */
  unreadable: string[];
}

/**
 * The lifecycle rules the catalog manifest of a stored artifact manifest
 * declares, by R2 binding. Each bucket is read on its own, so one that does
 * not parse hides only itself and is named in `unreadable`. A manifest that
 * does not parse, or declares none, contributes nothing.
 */
export function declaredLifecycleOf(manifestJson: string | null): DeclaredLifecycle {
  const out: DeclaredLifecycle = { rules: {}, unreadable: [] };
  if (manifestJson === null) return out;
  let declared: unknown;
  try {
    declared = (JSON.parse(manifestJson) as { catalog?: { resources?: { r2?: unknown } } }).catalog
      ?.resources?.r2;
  } catch {
    return out;
  }
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return out;
  for (const [binding, bucket] of Object.entries(declared)) {
    const parsed = catalogR2BucketSchema.safeParse(bucket);
    if (!parsed.success) out.unreadable.push(binding);
    else if (parsed.data.lifecycle.length > 0) out.rules[binding] = parsed.data.lifecycle;
  }
  return out;
}

/**
 * What a rollback's log says about lifecycle rules. A rollback never changes
 * a bucket's rules, so each rule the version it leaves declares, and the
 * version it returns to does not (or declares otherwise), stays on the
 * bucket and goes on deleting or moving objects. One message per bucket;
 * none when both versions declare the same rules. `buckets` maps R2
 * bindings to the install's bucket names.
 */
export function rollbackLifecycleWarnings(input: {
  from: DeclaredLifecycle;
  to: DeclaredLifecycle;
  buckets: Readonly<Record<string, string>>;
  toVersion: string;
}): string[] {
  const same = (a: R2LifecycleRule, b: R2LifecycleRule | undefined) =>
    b !== undefined &&
    JSON.stringify(r2LifecycleApiRule(a)) === JSON.stringify(r2LifecycleApiRule(b));
  const warnings: string[] = [];
  for (const [binding, rules] of Object.entries(input.from.rules)) {
    const bucket = Object.hasOwn(input.buckets, binding) ? input.buckets[binding] : undefined;
    if (bucket === undefined) continue;
    const then = Object.hasOwn(input.to.rules, binding) ? (input.to.rules[binding] ?? []) : [];
    const staying = rules.filter(
      (rule) =>
        !same(
          rule,
          then.find((r) => r.id === rule.id),
        ),
    );
    if (staying.length === 0) continue;
    const ids = staying.map((rule) => `"${managedR2LifecycleRuleId(rule.id)}"`).join(", ");
    const one = staying.length === 1;
    warnings.push(
      `The lifecycle ${one ? "rule" : "rules"} ${ids} on R2 bucket "${bucket}" ${one ? "stays" : "stay"}: a rollback does not change a bucket's rules, and version ${input.toVersion} does not declare ${one ? "it" : "them"} this way. ${one ? "It goes" : "They go"} on deleting or moving objects as ${one ? "it says" : "they say"}; delete ${one ? "it" : "them"} in the bucket's settings if the app should not have ${one ? "it" : "them"}.`,
    );
  }
  return warnings;
}

/** What of a stream the install created cannot change: its schema and where its sink writes. */
export interface PipelineShape {
  schema: CatalogPipeline["schema"] | null;
  bucket: string;
  namespace: string;
  table: string;
}

/** Stream shapes by binding name. */
export type PipelineShapes = Readonly<Record<string, PipelineShape>>;

function shapeOf(declared: CatalogPipeline): PipelineShape {
  return {
    schema: declared.schema ?? null,
    bucket: declared.sink.bucket,
    namespace: declared.sink.namespace,
    table: declared.sink.table,
  };
}

/**
 * The stream shape of each Pipelines binding the catalog manifest of a stored
 * artifact manifest (the installed version's) describes, by binding name. A
 * manifest that does not parse, or describes none, contributes nothing.
 */
export function pipelineShapesOf(manifestJson: string | null): Record<string, PipelineShape> {
  const shapes: Record<string, PipelineShape> = {};
  if (manifestJson === null) return shapes;
  let declared: unknown;
  try {
    declared = (JSON.parse(manifestJson) as { catalog?: { resources?: { pipelines?: unknown } } })
      .catalog?.resources?.pipelines;
  } catch {
    return shapes;
  }
  const parsed = catalogPipelinesSchema.safeParse(declared);
  if (!parsed.success) return shapes;
  for (const [binding, decl] of Object.entries(parsed.data)) shapes[binding] = shapeOf(decl);
  return shapes;
}

/**
 * What a new version's description of a kept stream changes, as words for a
 * message, or null when nothing that was created changes. Settings that
 * apply only when a sink is made (roll interval, compression, maintenance)
 * are not compared: the kept sink goes on as it was made.
 */
export function pipelineShapeChange(was: PipelineShape, now: CatalogPipeline): string | null {
  const next = shapeOf(now);
  const changes: string[] = [];
  if (JSON.stringify(was.schema) !== JSON.stringify(next.schema)) changes.push("its schema");
  if (was.bucket !== next.bucket || was.namespace !== next.namespace || was.table !== next.table) {
    changes.push(
      `the table its events land in (from ${was.bucket} ${was.namespace}.${was.table} to ${next.bucket} ${next.namespace}.${next.table})`,
    );
  }
  return changes.length === 0 ? null : changes.join(" and ");
}

/**
 * Compares the new version's bindings with the install's recorded resources.
 * A binding whose resource is recorded keeps it (same id, same name); a new
 * one gets a resource named as an install would name it. A binding that now
 * needs a different kind of resource than the one recorded under its name is
 * refused: replacing it would mean deleting or orphaning data. So is a kept
 * Vectorize binding whose dimensions or metric differ from `installedShapes`
 * (the installed version's): an index cannot be reshaped in place, and every
 * write the new version makes to the old index would fail. A kept index or
 * bucket whose settings the job may have to bring up to this version is
 * listed in `toConfigure`.
 */
export function diffBindings(
  workerName: string,
  bindings: readonly WorkerBinding[],
  recorded: readonly RecordedResource[],
  installedShapes: VectorizeShapes = {},
  /** The version's `resources.hyperdrive` (the catalog manifest's database declarations). */
  databases: readonly HyperdriveDeclaration[] = [],
  /** The version's `resources.pipelines` (the catalog manifest's stream descriptions). */
  streams: CatalogPipelines = {},
  /** The installed version's `resources.pipelines` ({@link pipelineShapesOf}). */
  installedStreams: PipelineShapes = {},
  /** R2 bindings the installed version declares lifecycle rules for ({@link declaredLifecycleOf}). */
  installedLifecycle: readonly string[] = [],
): BindingDiff {
  const plan = planBindings(workerName, bindings, databases, streams);
  const byBinding = new Map<string, RecordedResource[]>();
  for (const row of recorded) {
    if (row.binding === null || !BOUND_KINDS.has(row.kind)) continue;
    byBinding.set(row.binding, [...(byBinding.get(row.binding) ?? []), row]);
  }
  const diff: BindingDiff = {
    plan,
    existing: [],
    toCreate: [],
    toConfigure: [],
    workflowNames: {},
    newWorkflows: [],
    newDurableObjects: [],
    leftInPlace: [],
    problems: [...plan.problems],
  };
  const used = new Set<RecordedResource>();

  for (const res of plan.resources) {
    const rows = byBinding.get(res.binding) ?? [];
    const same = rows.find((r) => r.kind === res.kind);
    if (same !== undefined) {
      used.add(same);
      if (same.cfId === null) {
        diff.problems.push(
          `The ${res.kind} resource of binding ${res.binding} (${same.name}) is recorded without a Cloudflare id, so the update cannot bind it.`,
        );
        continue;
      }
      if (res.type === "pipelines") {
        const was = Object.hasOwn(installedStreams, res.binding)
          ? installedStreams[res.binding]
          : undefined;
        const change = was === undefined ? null : pipelineShapeChange(was, res.pipeline.declared);
        if (change !== null) {
          diff.problems.push(
            `Binding ${res.binding} sends events to the Pipelines stream "${same.name}"; this version changes ${change}. Cloudflare cannot change a stream or a sink once created, nor point a new sink at an existing table, so this version needs a fresh install.`,
          );
          continue;
        }
      }
      if (res.type === "vectorize") {
        const was = Object.hasOwn(installedShapes, res.binding)
          ? installedShapes[res.binding]
          : undefined;
        const now = res.vectorize;
        if (was !== undefined && (was.dimensions !== now.dimensions || was.metric !== now.metric)) {
          diff.problems.push(
            `Binding ${res.binding} uses the Vectorize index "${same.name}", created with ${was.dimensions} dimensions (${was.metric}); this version needs ${now.dimensions} dimensions (${now.metric}). A Vectorize index cannot be reshaped in place, so this version needs a fresh install.`,
          );
          continue;
        }
      }
      diff.existing.push({
        binding: res.binding,
        type: res.type,
        name: same.name,
        cfId: same.cfId,
      });
      if (res.type === "vectorize" && (res.metadataIndexes?.length ?? 0) > 0) {
        diff.toConfigure.push({ res: { ...res, name: same.name }, previouslyDeclared: false });
      } else if (res.type === "r2_bucket") {
        const previouslyDeclared = installedLifecycle.includes(res.binding);
        if ((res.lifecycle?.length ?? 0) > 0 || previouslyDeclared) {
          diff.toConfigure.push({ res: { ...res, name: same.name }, previouslyDeclared });
        }
      }
      continue;
    }
    const other = rows.find((r) => PROVISIONED_KINDS.has(r.kind));
    if (other !== undefined) {
      used.add(other);
      diff.problems.push(
        `Binding ${res.binding} was a ${other.kind} resource (${other.name}) and is a ${res.kind} resource in this version; Appflare does not replace a resource on update.`,
      );
      continue;
    }
    if (res.type === "hyperdrive") {
      // TODO: ask for the new database's connection string with the update,
      // as the update form asks for a new secret; until then such a version
      // is installed fresh.
      diff.problems.push(
        `Binding ${res.binding} connects to a database elsewhere and is new in this version; Appflare cannot ask for its connection string during an update yet, so this version needs a fresh install.`,
      );
      continue;
    }
    if (res.type === "pipelines") {
      // TODO: create the stream, sink and pipeline during an update; the sink
      // needs the token the admin entered at install, which Cloudflare keeps
      // write-only as a secret, so the update form would have to ask for it
      // again. Until then such a version is installed fresh.
      diff.problems.push(
        `Binding ${res.binding} sends events to a Pipelines stream and is new in this version; its sink needs the API token entered at install, which an update cannot read back, so this version needs a fresh install.`,
      );
      continue;
    }
    diff.toCreate.push(res);
  }

  for (const wf of plan.workflows) {
    const row = (byBinding.get(wf.binding) ?? []).find((r) => r.kind === "workflow");
    if (row !== undefined) {
      used.add(row);
      diff.workflowNames[wf.binding] = row.name;
    } else {
      diff.workflowNames[wf.binding] = wf.name;
      diff.newWorkflows.push(wf);
    }
  }

  // A binding that runs a Workflow another Worker of the app defines sends
  // that Workflow's name, recorded or planned.
  diff.workflowNames = withWorkflowRefs(diff.workflowNames, plan.workflowRefs);

  for (const d of plan.durableObjects) {
    const row = (byBinding.get(d.binding) ?? []).find((r) => r.kind === "durable_object");
    if (row !== undefined) used.add(row);
    else diff.newDurableObjects.push(d);
  }

  for (const rows of byBinding.values()) {
    for (const row of rows) if (!used.has(row)) diff.leftInPlace.push(row);
  }
  return diff;
}

/** The tag of the last Durable Object migration, or null when there are none. */
export function lastDurableObjectTag(migrations: readonly DoMigration[]): string | null {
  return migrations.at(-1)?.tag ?? null;
}

/**
 * The last Durable Object migration tag a deploy of `worker` applies, or null.
 * Null when its `exports` declare Durable Objects: the upload then sends no
 * migrations ({@link pendingDurableObjectMigrations}), so none of its tags
 * ran, and a later version without such exports must still send them.
 */
export function appliedDurableObjectTag(
  worker: Pick<ArtifactManifest["worker"], "migrations" | "exports">,
): string | null {
  return hasDurableObjectExports(worker.exports) ? null : lastDurableObjectTag(worker.migrations);
}

/**
 * The last Durable Object migration tag in a stored artifact manifest, or
 * null, also when its Worker's `exports` declare Durable Objects
 * ({@link appliedDurableObjectTag}).
 */
export function lastDurableObjectTagOf(manifestJson: string | null): string | null {
  if (manifestJson === null) return null;
  try {
    const parsed = JSON.parse(manifestJson) as {
      worker?: { migrations?: unknown; exports?: unknown };
    };
    const exports = workerExportsSchema.safeParse(parsed.worker?.exports);
    if (exports.success && hasDurableObjectExports(exports.data)) return null;
    const migrations = parsed.worker?.migrations;
    if (!Array.isArray(migrations)) return null;
    const tag = (migrations.at(-1) as { tag?: unknown } | undefined)?.tag;
    return typeof tag === "string" ? tag : null;
  } catch {
    return null;
  }
}

export interface DurableObjectMigrationUpload {
  old_tag?: string;
  new_tag: string;
  steps: Record<string, unknown>[];
}

/**
 * The Durable Object migrations the Worker still needs, in the shape a script
 * upload sends them, or undefined when it has them all. Same rules as
 * wrangler's `getMigrationsToUpload`: with no applied tag every migration is
 * pending; with a tag the manifest knows, only the ones after it; with a tag
 * the manifest no longer has, every migration, from that tag.
 */
export function durableObjectMigrationsSince(
  migrations: readonly DoMigration[],
  appliedTag: string | null,
): DurableObjectMigrationUpload | undefined {
  const last = migrations.at(-1);
  if (last === undefined) return undefined;
  const strip = (list: readonly DoMigration[]) => list.map(({ tag: _tag, ...rest }) => rest);
  if (appliedTag === null) return { new_tag: last.tag, steps: strip(migrations) };
  const found = migrations.findIndex((m) => m.tag === appliedTag);
  if (found === -1) return { old_tag: appliedTag, new_tag: last.tag, steps: strip(migrations) };
  if (found === migrations.length - 1) return undefined;
  return { old_tag: appliedTag, new_tag: last.tag, steps: strip(migrations.slice(found + 1)) };
}

/**
 * The version serving all traffic: Cloudflare lists the deployment serving
 * traffic first. Null when there is none, or when it splits traffic between
 * versions (a gradual deployment someone started outside Appflare).
 */
export function activeVersionId(deployments: readonly WorkerDeployment[]): string | null {
  const versions = deployments[0]?.versions ?? [];
  if (versions.length !== 1) return null;
  const only = versions[0];
  return only !== undefined && only.percentage === 100 ? only.version_id : null;
}

/** `https://<first 8 hex of the version id>-<worker>.<subdomain>.workers.dev<path>` */
export function previewUrl(
  versionId: string,
  workerName: string,
  subdomain: string,
  path = "/",
): string {
  const prefix = versionId.replace(/-/g, "").slice(0, 8);
  return `https://${prefix}-${workerName}.${subdomain}.workers.dev${path}`;
}

/**
 * The `workers/message` annotation of the version an update uploads. It names
 * the job, so a failure can find the version even when the upload's answer
 * did not say its id.
 */
export function updateVersionMessage(slug: string, version: string, jobId: string): string {
  return `Appflare: ${slug} ${version} (update ${jobId})`;
}

/**
 * The `workers/message` annotation of the version a failed update makes to
 * take the secrets it introduced off the Worker's newest version.
 */
export function updateSecretsUndoneMessage(jobId: string): string {
  return `Appflare: update ${jobId} undone`;
}

/** Why the new version cannot be checked before it serves traffic (shown to the admin and logged). */
export const NO_PREVIEW_REASON =
  "Workers that implement a Durable Object have no version preview URL, so the new version cannot be checked before it serves traffic; the health check after the update still runs";

export const FULL_DEPLOY_REASON =
  "This version changes Durable Object classes (migrations), which Cloudflare applies only when the whole Worker is deployed at once. The update deploys it directly, without a preview check, and the change to the classes cannot be undone";

export const EXPORTS_DEPLOY_REASON =
  "This version changes the Durable Object classes its exports declare, which Cloudflare applies only when the whole Worker is deployed at once. The update deploys it directly, without a preview check, and the change to the classes cannot be undone";

/**
 * The Durable Object migrations a Worker still needs, or null. None when its
 * `exports` declare Durable Objects: those replace migrations, and wrangler
 * 4.136.2 (`resolveDoLifecyclePayload`) then sends none.
 */
export function pendingDurableObjectMigrations(
  worker: Pick<ArtifactManifest["worker"], "migrations" | "exports">,
  appliedDoTag: string | null,
): DurableObjectMigrationUpload | null {
  if (hasDurableObjectExports(worker.exports)) return null;
  return durableObjectMigrationsSince(worker.migrations, appliedDoTag) ?? null;
}

/**
 * The primary Worker's `exports` in a stored artifact manifest, or undefined.
 *
 * The update compares the new version's Durable Object exports with these,
 * assuming the stored manifest's exports are the ones Cloudflare has. That
 * holds for every install and update this manager makes, since each upload
 * sends the manifest's exports. It does not hold for a version a manager
 * older than exports support installed from an artifact that already had
 * them: that manager stored them but never uploaded them. An update to a
 * version with the same exports then takes the version upload, and
 * Cloudflare refuses it ("declared in exports but not yet provisioned").
 * Recording the uploaded exports on the install would close that gap; the
 * stored manifest is used because no install column holds them.
 */
export function workerExportsOf(manifestJson: string | null): WorkerExports | undefined {
  if (manifestJson === null) return undefined;
  try {
    const parsed = JSON.parse(manifestJson) as { worker?: { exports?: unknown } };
    const exports = workerExportsSchema.safeParse(parsed.worker?.exports);
    return exports.success ? exports.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `state` values of a Durable Object export entry that keep a namespace under
 * its class name (wrangler 4.136.2's `DurableObjectExport`): live (the
 * default when `state` is absent), or the receiving side of a transfer. The
 * others (`deleted`, `renamed`, `transferred`) are tombstones that take the
 * namespace off that name.
 */
const LIVE_DURABLE_OBJECT_STATES = new Set<string | undefined>([
  undefined,
  "created",
  "expecting-transfer",
]);

/**
 * Why a version of a Worker cannot replace the serving one, or null: the
 * serving version's `exports` declare a live Durable Object class that the
 * new `exports` have no Durable Object entry for, live or tombstone.
 * Cloudflare refuses (code 100402, `provisioned_class_missing_from_config`)
 * every upload that leaves out a class with a namespace once `exports`
 * declared it, including one that goes back to migrations, so the update
 * stops before it uploads anything. `worker` names the Worker for an app of
 * several.
 */
export function droppedDurableObjectExportsProblem(
  next: WorkerExports | undefined,
  serving: WorkerExports | undefined,
  worker?: string,
): string | null {
  const kept = durableObjectExports(next);
  const dropped = Object.entries(durableObjectExports(serving))
    .filter(([name, entry]) => LIVE_DURABLE_OBJECT_STATES.has(stateOf(entry)) && !(name in kept))
    .map(([name]) => `"${name}"`);
  if (dropped.length === 0) return null;
  const classes = dropped.length === 1 ? `class ${dropped[0]}` : `classes ${dropped.join(" and ")}`;
  const where = worker === undefined ? "" : ` of the Worker "${worker}"`;
  return `This version no longer declares the Durable Object ${classes}${where} in its exports. Once exports declare a Durable Object class, Cloudflare refuses any version that leaves it out, even one that goes back to migrations. The app's config must keep declaring it in exports, or mark it deleted there (state "deleted") to retire it and its data.`;
}

function stateOf(entry: WorkerExports[string]): string | undefined {
  return typeof entry.state === "string" ? entry.state : undefined;
}

/**
 * How an update reaches the new version. Normally it uploads the version,
 * checks its preview, and promotes it. When the version brings Durable Object
 * migrations the Worker does not have yet, or Durable Object `exports` other
 * than the serving version's, Cloudflare applies them only on a full script upload,
 * which serves the new code at once, so the update deploys directly. Either
 * way a Worker that implements a Durable Object has no preview to check.
 */
export function updatePath(
  manifest: Pick<ArtifactManifest, "worker">,
  appliedDoTag: string | null,
  /** The `exports` of the version serving now ({@link workerExportsOf}). */
  servingExports: WorkerExports | undefined,
): {
  /** The Durable Object migrations the script upload applies, or null. */
  fullDeploy: DurableObjectMigrationUpload | null;
  /** Whether the update deploys the whole script instead of uploading a version. */
  scriptUpload: boolean;
  /** Why no preview check runs, or null when one does. */
  skipPreview: string | null;
} {
  const pending = pendingDurableObjectMigrations(manifest.worker, appliedDoTag);
  // Only Durable Object entries decide: an entrypoint's settings are versioned.
  const exportsChanged = !sameDurableObjectExports(manifest.worker.exports, servingExports);
  const implementsDurableObject =
    hasDurableObjectExports(manifest.worker.exports) ||
    manifest.worker.bindings.some(
      (b) =>
        b.type === "durable_object_namespace" &&
        (typeof b.script_name !== "string" || b.script_name.length === 0),
    );
  return {
    fullDeploy: pending,
    scriptUpload: pending !== null || exportsChanged,
    skipPreview:
      pending !== null
        ? FULL_DEPLOY_REASON
        : exportsChanged
          ? EXPORTS_DEPLOY_REASON
          : implementsDurableObject
            ? NO_PREVIEW_REASON
            : null,
  };
}

/**
 * Secrets the new version needs that the Worker does not have yet. An
 * optional secret is never asked for here; the app's settings can set it.
 */
export function missingSecrets<
  T extends Pick<CatalogSecret, "name"> & Partial<Pick<CatalogSecret, "optional" | "seedOnly">>,
>(declared: readonly T[], recordedNames: Iterable<string>): T[] {
  const have = new Set(recordedNames);
  // A seed-only secret is never on the Worker: the install used it once.
  return declared.filter((s) => !isOptionalSecret(s) && !isSeedOnly(s) && !have.has(s.name));
}

/**
 * New secrets as upload bindings. They go into the uploaded version itself
 * (as `wrangler versions upload --secrets-file` sends them): setting a secret
 * on the script instead deploys a version at once, and Cloudflare refuses it
 * while the newest version is not deployed, which is exactly the state
 * between an upload and its promotion.
 */
export function secretBindings(
  values: Readonly<Record<string, string>>,
): Array<{ type: "secret_text"; name: string; text: string }> {
  return Object.entries(values).map(([name, text]) => ({ type: "secret_text", name, text }));
}

/**
 * Why the canary cannot probe the new version before promotion, or null when
 * it can. Cloudflare serves no preview URL for Workers that implement a
 * Durable Object; the upload result says so in `metadata.has_preview`.
 */
export function canarySkipReason(
  hasPreview: boolean | null,
  durableObjectBindings: number,
): string | null {
  if (hasPreview === true) return null;
  if (hasPreview === false || durableObjectBindings > 0) return NO_PREVIEW_REASON;
  return null;
}

/** `{ [database_id]: bookmark }`, the shape `snapshots.d1_bookmarks_json` stores. */
export function bookmarksJson(
  bookmarks: ReadonlyArray<{ databaseId: string; bookmark: string }>,
): string {
  return JSON.stringify(Object.fromEntries(bookmarks.map((b) => [b.databaseId, b.bookmark])));
}

export function parseBookmarks(json: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

/** The install's catalog state a snapshot keeps, so a rollback can put it back. */
export interface InstallState {
  catalog_version: string;
  manifest_json: string | null;
  artifact_url: string;
  artifact_digest: string | null;
  pin_sha: string | null;
  /** Build provenance; absent means a signed artifact. */
  build_kind?: BuildKind;
  sandbox_image?: string | null;
  built_at?: Date | null;
  /** Where the code came from; absent means the catalog. */
  origin?: InstallOrigin;
  source_url?: string | null;
  source_ref?: string | null;
  /**
   * The settings the admin changed (never secrets), null when none; a
   * rollback puts them back. Absent when the caller does not know them.
   */
  config_json?: string | null;
}

export interface SnapshotInput {
  id: string;
  installId: string;
  jobId: string;
  /** The version serving 100% of traffic before the update. */
  workerVersionId: string;
  bookmarks: ReadonlyArray<{ databaseId: string; bookmark: string }>;
  takenAt: Date;
  before: InstallState;
  /** The Durable Object migration tag the Worker had before the update. */
  doMigrationTag: string | null;
  /** The catalog version the job moves to (the same one for a settings change). */
  targetVersion: string;
  /** An app of several Workers: the version each other Worker served, by Worker name. */
  otherVersions?: Readonly<Record<string, string>>;
  /** Configuration id by Hyperdrive binding, as the install recorded them bound before the job. */
  hyperdrive?: Readonly<Record<string, string>>;
}

/**
 * The Hyperdrive configurations the install records as bound, by binding:
 * what the serving version binds, and so what a snapshot of it needs.
 */
export function boundHyperdriveIds(
  resources: ReadonlyArray<Pick<RecordedResource, "kind" | "binding" | "cfId">>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of resources) {
    if (r.kind === "hyperdrive" && r.binding !== null && r.cfId !== null) out[r.binding] = r.cfId;
  }
  return out;
}

/** A snapshot's `hyperdrive_json`, or null when it recorded none (taken before it was recorded). */
export function parseSnapshotHyperdrive(json: string | null): Record<string, string> | null {
  if (json === null) return null;
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Why a rollback to a version that binds these Hyperdrive configurations
 * cannot run, or null when every one of them is live (bound or superseded)
 * in `live`, the configuration ids the install records and has not deleted.
 */
export function hyperdriveRollbackRefusal(
  installId: string,
  bound: Readonly<Record<string, string>>,
  live: ReadonlySet<string>,
): string | null {
  const gone = Object.entries(bound).filter(([, id]) => !live.has(id));
  if (gone.length === 0) return null;
  return `The version this snapshot recorded connects ${gone.map(([binding]) => binding).join(" and ")} through a Hyperdrive configuration that has since been deleted, so rolling back to it would leave the app without its database. Roll back to a later snapshot, or replace the connection string under ${appPlace(installId, "databases", "Databases in the app's settings")} instead.`;
}

/** The `snapshots` row an update or a settings change inserts before it changes anything. */
export function snapshotRow(input: SnapshotInput): typeof snapshots.$inferInsert {
  return {
    id: input.id,
    install_id: input.installId,
    job_id: input.jobId,
    worker_version_id: input.workerVersionId,
    d1_bookmarks_json: bookmarksJson(input.bookmarks),
    taken_at: input.takenAt,
    catalog_version: input.before.catalog_version,
    manifest_json: input.before.manifest_json,
    artifact_url: input.before.artifact_url,
    artifact_digest: input.before.artifact_digest,
    pin_sha: input.before.pin_sha,
    do_migration_tag: input.doMigrationTag,
    build_kind: input.before.build_kind ?? "artifact",
    sandbox_image: input.before.sandbox_image ?? null,
    built_at: input.before.built_at ?? null,
    origin: input.before.origin ?? "catalog",
    source_url: input.before.source_url ?? null,
    source_ref: input.before.source_ref ?? null,
    target_catalog_version: input.targetVersion,
    // "{}" for an install with no changed settings, so a rollback can tell
    // "none" from "not recorded" (null).
    config_json: input.before.config_json === undefined ? null : (input.before.config_json ?? "{}"),
    worker_versions_json:
      input.otherVersions === undefined || Object.keys(input.otherVersions).length === 0
        ? null
        : JSON.stringify(input.otherVersions),
    hyperdrive_json: JSON.stringify(input.hyperdrive ?? {}),
  };
}

/** Cron triggers to add and remove when a version's schedule differs from the recorded one. */
export function cronChanges(
  recorded: readonly string[],
  wanted: readonly string[],
): { changed: boolean; added: string[]; removed: string[] } {
  const have = new Set(recorded);
  const want = new Set(wanted);
  const added = [...want].filter((c) => !have.has(c));
  const removed = [...have].filter((c) => !want.has(c));
  return { changed: added.length > 0 || removed.length > 0, added, removed };
}
