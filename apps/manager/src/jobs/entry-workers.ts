import {
  type ArtifactManifest,
  appWorkersInDeployOrder,
  artifactManifestSchema,
  combinedWorkerFacts,
  type EntryWorkerPlaceholders,
  entryPlaceholderValues,
  entryScriptName,
  entryScriptNames,
  entryWorkerRefName,
  MAX_FREE_PLAN_ENTRY_WORKERS,
  sameDurableObjectExports,
  secondaryWorkers,
  type WorkerBinding,
  workerManifest,
} from "@appflare/schema";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { installs } from "../db/schema";

/**
 * Apps that install as several Workers (a catalog entry's `install.workers`,
 * an artifact manifest of format 2), as the jobs see them. The primary Worker
 * is the install's own: its Worker name is the install's, and the install,
 * update, rollback and uninstall jobs handle it exactly as the only Worker of
 * a one-Worker app. Every other Worker runs as `<install Worker name>-<name>`
 * on its workers.dev address (unless the entry keeps it off workers.dev), is
 * recorded as a `worker` resource, and is handled by the phases in
 * ./install/entry-worker-phases.ts.
 *
 * Resources belong to the app, shared by binding name, so they are planned
 * once from every Worker's bindings together ({@link entryBindings}).
 */

/** One Worker of an installed app. */
export interface EntryWorker {
  /** Its name within the catalog entry; null for an app of one Worker. */
  name: string | null;
  primary: boolean;
  /**
   * Whether it answers on its workers.dev URL. False only for a Worker other
   * than the primary one whose catalog entry sets `workersDev: false`: it is
   * reached only through the other Workers' bindings, so its workers.dev URL
   * and version previews stay off, and no job probes it.
   */
  workersDev: boolean;
  /** The Worker name it is installed under. */
  scriptName: string;
  /**
   * The artifact manifest as this Worker sees it: its own `worker` and
   * `assets`, and the catalog secrets and vars that go to it
   * (`workerManifest`). The manifest itself for an app of one Worker.
   */
  manifest: ArtifactManifest;
}

/** Every Worker of the app, in the order they are deployed (`appWorkersInDeployOrder`). */
export function entryWorkers(manifest: ArtifactManifest, installWorkerName: string): EntryWorker[] {
  return appWorkersInDeployOrder(manifest).map((w) => ({
    name: w.name,
    primary: w.primary,
    workersDev: w.workersDev,
    scriptName:
      w.name === null ? installWorkerName : entryScriptName(installWorkerName, w.name, w.primary),
    manifest: workerManifest(manifest, w),
  }));
}

/**
 * The Workers other than the primary one, in deploy order, split around the
 * primary Worker: `before` are deployed before it (they bind to none of the
 * Workers after it), `after` once it exists (they bind to it, or to a Worker
 * that does).
 */
export function otherEntryWorkers(
  manifest: ArtifactManifest,
  installWorkerName: string,
): { before: EntryWorker[]; after: EntryWorker[] } {
  const all = entryWorkers(manifest, installWorkerName);
  const at = all.findIndex((w) => w.primary);
  return { before: all.slice(0, at), after: all.slice(at + 1) };
}

/** Whether the app has Workers other than the primary one. */
export function hasOtherWorkers(manifest: ArtifactManifest): boolean {
  return secondaryWorkers(manifest).length > 0;
}

/** Each Worker's name within the entry to its installed Worker name; empty for one Worker. */
export function entryScriptNamesOf(
  manifest: ArtifactManifest,
  installWorkerName: string,
): Record<string, string> {
  return entryScriptNames(manifest.catalog, installWorkerName);
}

/**
 * Every binding of every Worker of the app, one per binding name, for the
 * plans that create resources: bindings of one name share one resource. For a
 * Durable Object binding the Worker that implements the class wins over one
 * that binds it from another Worker (`script_name` naming an entry Worker),
 * so the class is recorded once, with the Worker that has it.
 */
export function entryBindings(manifest: ArtifactManifest): WorkerBinding[] {
  const byName = new Map<string, WorkerBinding>();
  for (const binding of combinedWorkerFacts(manifest).bindings) {
    const seen = byName.get(binding.name);
    if (seen === undefined) {
      byName.set(binding.name, binding);
    } else if (
      seen.type === "durable_object_namespace" &&
      binding.type === "durable_object_namespace" &&
      entryWorkerRefName(seen.script_name) !== null &&
      entryWorkerRefName(binding.script_name) === null
    ) {
      byName.set(binding.name, binding);
    }
  }
  return [...byName.values()];
}

/**
 * What `{{workerUrl:<name>}}` and `{{workerName:<name>}}` become: each
 * Worker's installed name and workers.dev URL. The primary Worker's URL is
 * `appUrl`, the app's address, as `{{workerUrl}}` is. Undefined for an app
 * of one Worker.
 */
export function entryPlaceholders(
  manifest: ArtifactManifest,
  installWorkerName: string,
  subdomain: string,
  appUrl?: string,
): EntryWorkerPlaceholders | undefined {
  if (!hasOtherWorkers(manifest)) return undefined;
  return entryPlaceholderValues(manifest.catalog, installWorkerName, subdomain, appUrl);
}

/** Worker names allow at most 63 characters. */
export const MAX_WORKER_NAME_LENGTH = 63;

/** Why the app's Workers cannot be installed under `installWorkerName`, as sentences. */
export function entryNameProblems(manifest: ArtifactManifest, installWorkerName: string): string[] {
  return entryWorkers(manifest, installWorkerName)
    .filter((w) => !w.primary && w.scriptName.length > MAX_WORKER_NAME_LENGTH)
    .map(
      (w) =>
        `The Worker name "${w.scriptName}" of the app's Worker "${w.name}" is longer than ${MAX_WORKER_NAME_LENGTH} characters; choose a shorter Worker name.`,
    );
}

/** How step names and logs tell an app's other Workers apart: ` (Worker "glance-content")`. */
export function workerLabel(w: Pick<EntryWorker, "primary" | "scriptName">): string {
  return w.primary ? "" : ` (Worker "${w.scriptName}")`;
}

/** The other Workers of a stored artifact manifest, or none when it is missing or unreadable. */
export function storedOtherWorkers(
  manifestJson: string | null,
  installWorkerName: string,
): EntryWorker[] {
  const manifest = parseStoredManifest(manifestJson);
  if (manifest === null) return [];
  return entryWorkers(manifest, installWorkerName).filter((w) => !w.primary);
}

/** A stored artifact manifest, or null when it is missing or does not parse. */
export function parseStoredManifest(manifestJson: string | null): ArtifactManifest | null {
  if (manifestJson === null) return null;
  try {
    const parsed = artifactManifestSchema.safeParse(JSON.parse(manifestJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const workerVersionsSchema = z.record(z.string(), z.string());

/** The versions a snapshot recorded for the app's other Workers (`worker_versions_json`). */
export function parseWorkerVersions(json: string | null): Record<string, string> {
  if (json === null) return {};
  try {
    const parsed = workerVersionsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * The install's `worker_versions_json` with `changes` merged in: a Worker
 * named with a version serves it, one named with null serves a version
 * Appflare does not know (the key is dropped).
 */
export function mergedWorkerVersions(changes: Readonly<Record<string, string | null>>): SQL {
  return sql`json_patch(coalesce(${installs.worker_versions_json}, '{}'), ${JSON.stringify(changes)})`;
}

/**
 * Whether the app's other Workers serve what a snapshot recorded for them,
 * as the install's record says (`worker_versions_json`). A Worker the record
 * does not know counts as serving something else.
 */
export function otherWorkersMatch(
  snapshotJson: string | null,
  installJson: string | null,
): boolean {
  const recorded = parseWorkerVersions(installJson);
  return Object.entries(parseWorkerVersions(snapshotJson)).every(
    ([name, versionId]) => recorded[name] === versionId,
  );
}

/**
 * Whether any other Worker of the app has another last Durable Object
 * migration tag in `manifestJson` than in `currentJson` (both stored
 * artifact manifests): Cloudflare refuses to roll a Worker back across such a
 * change, as for the primary Worker's `do_migration_tag`.
 */
export function otherDoTagsDiffer(
  manifestJson: string | null,
  currentJson: string | null,
  installWorkerName: string,
): boolean {
  const lastTag = (w: EntryWorker | undefined) => w?.manifest.worker.migrations.at(-1)?.tag ?? null;
  const then = storedOtherWorkers(manifestJson, installWorkerName);
  const now = storedOtherWorkers(currentJson, installWorkerName);
  const names = new Set([...then, ...now].map((w) => w.scriptName));
  return [...names].some(
    (name) =>
      lastTag(then.find((w) => w.scriptName === name)) !==
      lastTag(now.find((w) => w.scriptName === name)),
  );
}

/**
 * Whether any Worker of the app, the install's own included, declares other
 * Durable Object `exports` in `manifestJson` than in `currentJson` (both
 * stored artifact manifests): a Durable Object class change made through
 * `exports`, which Cloudflare refuses to roll a Worker back across, as for a
 * change made with migrations. Entrypoint exports do not count.
 */
export function durableObjectExportsDiffer(
  manifestJson: string | null,
  currentJson: string | null,
  installWorkerName: string,
): boolean {
  const workersOf = (json: string | null) => {
    const manifest = parseStoredManifest(json);
    return manifest === null ? [] : entryWorkers(manifest, installWorkerName);
  };
  const then = workersOf(manifestJson);
  const now = workersOf(currentJson);
  const names = new Set([...then, ...now].map((w) => w.scriptName));
  return [...names].some(
    (name) =>
      !sameDurableObjectExports(
        then.find((w) => w.scriptName === name)?.manifest.worker.exports,
        now.find((w) => w.scriptName === name)?.manifest.worker.exports,
      ),
  );
}

/**
 * The most Workers an app may have to install or update on Workers Free: each
 * Worker besides the primary one adds its own subrequests to the job's one
 * invocation, which may make 50 there (the count is in ./units/client.ts).
 * Workers Paid has no count of its own below the catalog's
 * `MAX_ENTRY_WORKERS`; the job's steps and subrequests are totalled instead
 * (./entry-budget.ts).
 */
export const MAX_FREE_PLAN_WORKERS = MAX_FREE_PLAN_ENTRY_WORKERS;

/** Why the app has too many Workers for one job on Workers Free, or null. */
export function workerCountProblem(count: number, paid: boolean): string | null {
  if (paid || count <= MAX_FREE_PLAN_WORKERS) return null;
  return `This app has ${count} Workers; more than ${MAX_FREE_PLAN_WORKERS} Workers exceed the free plan's request budget for one install or update job (50 subrequests), so it needs an account on Workers Paid.`;
}
