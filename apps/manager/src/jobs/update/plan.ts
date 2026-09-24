import type { WorkerDeployment } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  type CatalogSecret,
  type DoMigration,
  type VectorizeIndexConfig,
  vectorizeBindingSchema,
  type WorkerBinding,
} from "@appflare/schema";
import { isUpdateAvailable } from "../../catalog/versions";
import type { BuildKind, snapshots } from "../../db/schema";
import {
  type BindingPlan,
  type DurableObjectPlan,
  planBindings,
  RESOURCE_BINDINGS,
  type ResourceBindingPlan,
  type WorkflowPlan,
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

/**
 * Compares the new version's bindings with the install's recorded resources.
 * A binding whose resource is recorded keeps it (same id, same name); a new
 * one gets a resource named as an install would name it. A binding that now
 * needs a different kind of resource than the one recorded under its name is
 * refused: replacing it would mean deleting or orphaning data. So is a kept
 * Vectorize binding whose dimensions or metric differ from `installedShapes`
 * (the installed version's): an index cannot be reshaped in place, and every
 * write the new version makes to the old index would fail.
 */
export function diffBindings(
  workerName: string,
  bindings: readonly WorkerBinding[],
  recorded: readonly RecordedResource[],
  installedShapes: VectorizeShapes = {},
): BindingDiff {
  const plan = planBindings(workerName, bindings);
  const byBinding = new Map<string, RecordedResource[]>();
  for (const row of recorded) {
    if (row.binding === null || !BOUND_KINDS.has(row.kind)) continue;
    byBinding.set(row.binding, [...(byBinding.get(row.binding) ?? []), row]);
  }
  const diff: BindingDiff = {
    plan,
    existing: [],
    toCreate: [],
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

/** The last Durable Object migration tag in a stored artifact manifest, or null. */
export function lastDurableObjectTagOf(manifestJson: string | null): string | null {
  if (manifestJson === null) return null;
  try {
    const parsed = JSON.parse(manifestJson) as { worker?: { migrations?: unknown } };
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

/** Why the new version cannot be checked before it serves traffic (shown to the admin and logged). */
export const NO_PREVIEW_REASON =
  "Workers that implement a Durable Object have no version preview URL, so the new version cannot be checked before it serves traffic; the health check after the update still runs";

export const FULL_DEPLOY_REASON =
  "This version changes Durable Object classes (migrations), which Cloudflare applies only when the whole Worker is deployed at once. The update deploys it directly, without a preview check, and the change to the classes cannot be undone";

/**
 * How an update reaches the new version. Normally it uploads the version,
 * checks its preview, and promotes it. When the version brings Durable Object
 * migrations the Worker does not have yet, Cloudflare applies them only on a
 * full script upload, which serves the new code at once (a version upload
 * refuses them), so the update deploys directly. Either way a Worker that
 * implements a Durable Object has no preview to check.
 */
export function updatePath(
  manifest: Pick<ArtifactManifest, "worker">,
  appliedDoTag: string | null,
): {
  fullDeploy: DurableObjectMigrationUpload | null;
  /** Why no preview check runs, or null when one does. */
  skipPreview: string | null;
} {
  const pending = durableObjectMigrationsSince(manifest.worker.migrations, appliedDoTag) ?? null;
  const implementsDurableObject = manifest.worker.bindings.some(
    (b) =>
      b.type === "durable_object_namespace" &&
      (typeof b.script_name !== "string" || b.script_name.length === 0),
  );
  return {
    fullDeploy: pending,
    skipPreview:
      pending !== null ? FULL_DEPLOY_REASON : implementsDurableObject ? NO_PREVIEW_REASON : null,
  };
}

/** Secrets the new version declares that the Worker does not have yet. */
export function missingSecrets(
  declared: readonly CatalogSecret[],
  recordedNames: Iterable<string>,
): CatalogSecret[] {
  const have = new Set(recordedNames);
  return declared.filter((s) => !have.has(s.name));
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
    target_catalog_version: input.targetVersion,
    // "{}" for an install with no changed settings, so a rollback can tell
    // "none" from "not recorded" (null).
    config_json: input.before.config_json === undefined ? null : (input.before.config_json ?? "{}"),
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
