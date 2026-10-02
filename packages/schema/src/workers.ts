import type {
  ArtifactAssets,
  ArtifactD1,
  ArtifactManifest,
  ArtifactWorker,
  WorkerBinding,
} from "./artifact";
import type { CatalogManifest, CatalogSecret, CatalogVar } from "./catalog";
import type { EntryWorkerPlaceholders } from "./placeholders";

/**
 * Apps that install as several Workers deployed together (a catalog entry's
 * `install.workers`, an artifact manifest's `workers`).
 *
 * One Worker is primary: it runs under the install's own Worker name, answers
 * the app's address and health check, and is described by the manifest's
 * `worker` and `assets`, exactly as the only Worker of a one-Worker app is.
 * Every other Worker is listed in the manifest's `workers` and runs as
 * `<install Worker name>-<name>`. Resources are the entry's, shared by binding
 * name: two Workers that bind `DB` use one D1 database, whose SQL is the
 * manifest's `d1.DB`.
 *
 * Where a wrangler config names another Worker of the entry (a service
 * binding's `service`, a Durable Object or Workflow binding's `script_name`),
 * the packer records `{{workerName:<name>}}` instead, and the manager puts the
 * installed Worker's name in its place. A Worker is deployed only after the
 * Workers it names, so the entry's Workers must not name each other in a
 * cycle. A Workflow is created with the Worker that defines it (its binding
 * names no other Worker); a binding in another Worker runs that Workflow.
 *
 * Imports only types, so `artifact.ts` can use it without a cycle at load time.
 */

/** One Worker of an app. */
export interface AppWorker {
  /** The Worker's name within the entry (`install.workers[].name`); `null` for a one-Worker app. */
  name: string | null;
  primary: boolean;
  /**
   * Whether it answers on its workers.dev URL (`entryWorkerOnWorkersDev`).
   * For the primary Worker, whether it may: the install's own setting decides.
   */
  workersDev: boolean;
  worker: ArtifactWorker;
  assets: ArtifactAssets;
}

/**
 * Whether the entry Worker `name` answers on its workers.dev URL: every
 * Worker does unless its `install.workers[].workersDev` is false, which the
 * catalog schema allows only for a Worker other than the primary one. Such a
 * Worker is reached only through the bindings of the entry's other Workers,
 * so its workers.dev URL and version previews stay off.
 */
export function entryWorkerOnWorkersDev(
  catalog: { install: Pick<CatalogManifest["install"], "workers"> },
  name: string | null,
): boolean {
  if (name === null) return true;
  const declared = catalog.install.workers?.find((w) => w.name === name);
  return declared === undefined || declared.primary || declared.workersDev;
}

/** Lowercase letters, digits and inner hyphens, as `ENTRY_WORKER_NAME_PATTERN` in catalog.ts. */
const ENTRY_NAME = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";

/** A value that names one of the entry's Workers: `{{workerName:<name>}}`, whole. */
export const ENTRY_WORKER_REF_PATTERN = new RegExp(`^\\{\\{workerName:(${ENTRY_NAME})\\}\\}$`);

/** How an artifact names one of its entry's Workers where the wrangler config named it. */
export function entryWorkerRef(name: string): string {
  return `{{workerName:${name}}}`;
}

/** The entry Worker `value` names (`{{workerName:<name>}}`), or null when it names none. */
export function entryWorkerRefName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = ENTRY_WORKER_REF_PATTERN.exec(value);
  return match?.[1] ?? null;
}

/**
 * The entry Workers a binding names: a service binding's `service`, or a
 * Durable Object or Workflow binding's `script_name`, when the packer
 * recorded it as `{{workerName:<name>}}`.
 */
export function bindingEntryRefs(binding: WorkerBinding): string[] {
  if (binding.type === "service") {
    const name = entryWorkerRefName(binding.service);
    return name === null ? [] : [name];
  }
  if (binding.type === "durable_object_namespace" || binding.type === "workflow") {
    const name = entryWorkerRefName(binding.script_name);
    return name === null ? [] : [name];
  }
  return [];
}

/**
 * Whether a `workflow` binding defines its Workflow: it names no script, so
 * uploading its Worker creates (or updates) the Workflow to run that Worker's
 * class. One whose `script_name` names another Worker runs the Workflow that
 * Worker defines instead, as wrangler 4.136.2 tells them apart
 * (`checkWorkflowConflicts`: a binding with no `script_name`, or the
 * Worker's own name, is deployed with it).
 */
export function definesWorkflow(binding: WorkerBinding): boolean {
  return (
    binding.type === "workflow" &&
    (typeof binding.script_name !== "string" || binding.script_name.length === 0)
  );
}

/** A `workflow` binding's Workflow name as the app's wrangler config gives it (`workflow_name`). */
export function upstreamWorkflowName(binding: WorkerBinding): string {
  return typeof binding.workflow_name === "string" ? binding.workflow_name : binding.name;
}

/** The entry Workers a Worker's bindings name, each once. */
export function workerEntryRefs(worker: Pick<ArtifactWorker, "bindings">): string[] {
  return [...new Set(worker.bindings.flatMap(bindingEntryRefs))];
}

/** The primary Worker's name within the entry, or null for a one-Worker app. */
export function primaryEntryWorkerName(
  catalog:
    | Pick<CatalogManifest, "install">
    | { install: Pick<CatalogManifest["install"], "workers"> },
): string | null {
  return catalog.install.workers?.find((w) => w.primary)?.name ?? null;
}

/** The Workers other than the primary one: the manifest's `workers`, empty for one Worker. */
export function secondaryWorkers(manifest: {
  workers?: readonly AppWorkerEntry[] | undefined;
}): readonly AppWorkerEntry[] {
  return manifest.workers ?? [];
}

/** One entry of an artifact manifest's `workers`. */
export interface AppWorkerEntry {
  name: string;
  worker: ArtifactWorker;
  assets: ArtifactAssets;
}

/** Every Worker of the app: the primary one first, then the others in the entry's order. */
export function appWorkers(manifest: ArtifactManifest): AppWorker[] {
  const primary: AppWorker = {
    name: primaryEntryWorkerName(manifest.catalog),
    primary: true,
    workersDev: true,
    worker: manifest.worker,
    assets: manifest.assets,
  };
  return [
    primary,
    ...secondaryWorkers(manifest).map((w) => ({
      name: w.name,
      primary: false,
      workersDev: entryWorkerOnWorkersDev(manifest.catalog, w.name),
      worker: w.worker,
      assets: w.assets,
    })),
  ];
}

/** How many Workers the app installs. */
export function appWorkerCount(manifest: ArtifactManifest): number {
  return 1 + secondaryWorkers(manifest).length;
}

/**
 * The Worker name an entry Worker runs under: the install's own for the
 * primary, `<install Worker name>-<name>` for every other one.
 */
export function entryScriptName(installWorkerName: string, name: string, primary: boolean): string {
  return primary ? installWorkerName : `${installWorkerName}-${name}`;
}

/**
 * The installed Worker name of every Worker of the entry, by its name within
 * the entry. Empty for a one-Worker app.
 */
export function entryScriptNames(
  catalog: Pick<CatalogManifest, "install">,
  installWorkerName: string,
): Record<string, string> {
  const names: Record<string, string> = {};
  for (const w of catalog.install.workers ?? []) {
    names[w.name] = entryScriptName(installWorkerName, w.name, w.primary);
  }
  return names;
}

/** An order of an entry's Workers, or the Workers that name each other in a cycle. */
export type EntryWorkerOrder = { order: string[]; cycle: null } | { order: null; cycle: string[] };

/**
 * The order to deploy an entry's Workers in: each after every Worker it names
 * (`workerEntryRefs`), otherwise in the given order with the primary Worker
 * as late as it can be. `workers` lists each Worker's name and bindings;
 * names no Worker has are ignored here (the manifest checks refuse them).
 */
export function entryWorkerOrder(
  workers: ReadonlyArray<{
    name: string;
    primary: boolean;
    worker: Pick<ArtifactWorker, "bindings">;
  }>,
): EntryWorkerOrder {
  const known = new Set(workers.map((w) => w.name));
  const needs = new Map(
    workers.map((w) => [
      w.name,
      new Set(workerEntryRefs(w.worker).filter((n) => n !== w.name && known.has(n))),
    ]),
  );
  // Others first in their own order, the primary last among equals.
  const candidates = [...workers.filter((w) => !w.primary), ...workers.filter((w) => w.primary)];
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < workers.length) {
    const next = candidates.find(
      (w) => !placed.has(w.name) && [...(needs.get(w.name) ?? [])].every((n) => placed.has(n)),
    );
    if (next === undefined) {
      return {
        order: null,
        cycle: candidates.filter((w) => !placed.has(w.name)).map((w) => w.name),
      };
    }
    order.push(next.name);
    placed.add(next.name);
  }
  return { order, cycle: null };
}

/** Every Worker of `manifest` in deploy order (`entryWorkerOrder`); the given order when it has a cycle. */
export function appWorkersInDeployOrder(manifest: ArtifactManifest): AppWorker[] {
  const all = appWorkers(manifest);
  if (all.length === 1) return all;
  const named = all.map((w) => ({ ...w, name: w.name ?? "" }));
  const result = entryWorkerOrder(named);
  if (result.order === null) return all;
  return result.order.flatMap((name) => all.filter((w) => w.name === name));
}

/**
 * The Workers (by name within the entry) a secret goes to: its `workers`,
 * else every Worker of the entry. Empty for a one-Worker app, whose only
 * Worker gets every secret.
 */
export function secretTargets(
  secret: Pick<CatalogSecret, "workers">,
  catalog: Pick<CatalogManifest, "install">,
): string[] {
  const all = (catalog.install.workers ?? []).map((w) => w.name);
  if (all.length === 0) return [];
  return secret.workers !== undefined ? all.filter((n) => secret.workers?.includes(n)) : all;
}

/** Whether the var is one of the Worker's own (its wrangler config declares it). */
function declaresVar(worker: Pick<ArtifactWorker, "bindings">, name: string): boolean {
  return worker.bindings.some(
    (b) => (b.type === "plain_text" || b.type === "json") && b.name === name,
  );
}

/**
 * The Workers (by name within the entry) a catalog var goes to: its
 * `workers`, else the Workers whose wrangler config declares it, else every
 * Worker of the entry. Empty for a one-Worker app.
 */
export function varTargets(
  v: Pick<CatalogVar, "name" | "workers">,
  manifest: ArtifactManifest,
): string[] {
  const workers = appWorkers(manifest).filter(
    (w): w is AppWorker & { name: string } => w.name !== null,
  );
  if (workers.length === 0) return [];
  if (v.workers !== undefined) {
    return workers.filter((w) => v.workers?.includes(w.name)).map((w) => w.name);
  }
  const declaring = workers.filter((w) => declaresVar(w.worker, v.name)).map((w) => w.name);
  return declaring.length > 0 ? declaring : workers.map((w) => w.name);
}

/**
 * The manifest's view of one Worker for code written for a one-Worker app:
 * its own `worker` and `assets` in place of the primary's, and only the
 * catalog secrets and vars that go to it. The primary Worker's view keeps the
 * manifest's `worker` and `assets`.
 */
export function workerManifest(manifest: ArtifactManifest, worker: AppWorker): ArtifactManifest {
  if (worker.name === null) return manifest;
  const name = worker.name;
  const catalog = {
    ...manifest.catalog,
    secrets: manifest.catalog.secrets.filter((s) =>
      secretTargets(s, manifest.catalog).includes(name),
    ),
    vars: manifest.catalog.vars.filter((v) => varTargets(v, manifest).includes(name)),
  };
  return { ...manifest, worker: worker.worker, assets: worker.assets, catalog };
}

/**
 * What the per-Worker placeholders become for an install under
 * `installWorkerName`, by each Worker's name within the entry: its installed
 * name, its workers.dev URL (null while the account's subdomain is unknown,
 * and for a Worker kept off workers.dev, which has none), and the address it
 * is served at. The primary Worker's address is `appUrl` when given (its
 * custom domain while workers.dev is off), else its workers.dev URL; every
 * other Worker is served at its workers.dev URL. Undefined for an app of one
 * Worker.
 */
export function entryPlaceholderValues(
  catalog: Pick<CatalogManifest, "install">,
  installWorkerName: string,
  subdomain: string | null | undefined,
  appUrl?: string | null,
): EntryWorkerPlaceholders | undefined {
  const declared = catalog.install.workers;
  if (declared === undefined) return undefined;
  const values: Record<
    string,
    { workerName: string; workerUrl: string | null; appUrl: string | null }
  > = {};
  for (const w of declared) {
    const scriptName = entryScriptName(installWorkerName, w.name, w.primary);
    const workerUrl =
      subdomain && entryWorkerOnWorkersDev(catalog, w.name)
        ? `https://${scriptName}.${subdomain}.workers.dev`
        : null;
    values[w.name] = {
      workerName: scriptName,
      workerUrl,
      appUrl: w.primary && appUrl != null ? appUrl : workerUrl,
    };
  }
  return values;
}

/**
 * The bindings, Durable Object migrations, crons and queue consumers of every
 * Worker of the app together, for what an app uses as a whole (`appServices`).
 */
export function combinedWorkerFacts(
  manifest: Pick<ArtifactManifest, "worker"> & {
    workers?: readonly { worker: ArtifactWorker }[] | undefined;
  },
): Pick<ArtifactWorker, "bindings" | "migrations" | "crons" | "queueConsumers"> {
  const workers = [manifest.worker, ...(manifest.workers ?? []).map((w) => w.worker)];
  return {
    bindings: workers.flatMap((w) => w.bindings),
    migrations: workers.flatMap((w) => w.migrations),
    crons: workers.flatMap((w) => w.crons),
    queueConsumers: workers.flatMap((w) => w.queueConsumers),
  };
}

/** Binding types whose bindings of one name share one resource across an entry's Workers. */
const SHARED_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "kv_namespace",
  "d1",
  "r2_bucket",
  "queue",
  "vectorize",
]);

/**
 * What is wrong with the Workers of an artifact of several, as sentences;
 * empty when nothing is. The packer, the manifest schema and the manager all
 * hold an artifact to these.
 */
export function entryWorkerProblems(manifest: {
  worker: ArtifactWorker;
  workers: readonly AppWorkerEntry[];
  d1: ArtifactD1;
  catalog: Pick<CatalogManifest, "install">;
}): string[] {
  const problems: string[] = [];
  const declared = manifest.catalog.install.workers;
  if (declared === undefined) {
    return ["The artifact lists several Workers, but its catalog manifest has no install.workers."];
  }
  const primaryName = declared.find((w) => w.primary)?.name;
  const others = declared.filter((w) => !w.primary).map((w) => w.name);
  const listed = manifest.workers.map((w) => w.name);
  if (primaryName === undefined || others.join("\n") !== listed.join("\n")) {
    problems.push(
      `The artifact's Workers (${listed.join(", ")}) are not the catalog manifest's Workers other than the primary one (${others.join(", ")}).`,
    );
    return problems;
  }
  const all = [
    { name: primaryName, primary: true, worker: manifest.worker },
    ...manifest.workers.map((w) => ({ name: w.name, primary: false, worker: w.worker })),
  ];
  const names = new Set(all.map((w) => w.name));
  const types = new Map<string, { type: string; worker: string; shape: string }>();
  const workflowOwners = new Map<string, string>();
  /** Each Workflow a Worker defines, by its name in the wrangler config. */
  const workflowsDefined = new Map<string, { worker: string; className: unknown }>();
  /** Workflow bindings that run a Workflow another Worker of the entry defines. */
  const workflowRuns: Array<{ worker: string; target: string; binding: WorkerBinding }> = [];
  const doClasses = new Map<string, { className: unknown; worker: string }>();
  for (const w of all) {
    for (const binding of w.worker.bindings) {
      for (const ref of bindingEntryRefs(binding)) {
        if (!names.has(ref)) {
          problems.push(
            `Binding ${binding.name} of the Worker "${w.name}" names the Worker "${ref}", which the entry does not have.`,
          );
        } else if (ref === w.name) {
          problems.push(
            `Binding ${binding.name} of the Worker "${w.name}" names its own Worker by name; a Worker binds itself as "self".`,
          );
        }
      }
      if (binding.type === "durable_object_namespace") {
        // One binding name is one class, wherever it lives: the install
        // records it once.
        const seenClass = doClasses.get(binding.name);
        if (seenClass === undefined) {
          doClasses.set(binding.name, { className: binding.class_name, worker: w.name });
        } else if (seenClass.className !== binding.class_name) {
          problems.push(
            `The Durable Object binding ${binding.name} names the class ${String(seenClass.className)} in the Worker "${seenClass.worker}" and ${String(binding.class_name)} in the Worker "${w.name}"; bindings of one name must name one class.`,
          );
        }
      }
      if (definesWorkflow(binding)) {
        const owner = workflowOwners.get(binding.name);
        if (owner !== undefined) {
          problems.push(
            `The Workers "${owner}" and "${w.name}" both have the Workflow binding ${binding.name}; a Workflow belongs to one Worker.`,
          );
        }
        workflowOwners.set(binding.name, w.name);
        // Workflow names are the account's: two Workers defining one would
        // take it from each other.
        const name = upstreamWorkflowName(binding);
        const defined = workflowsDefined.get(name);
        if (defined !== undefined && defined.worker !== w.name) {
          problems.push(
            `The Workers "${defined.worker}" and "${w.name}" both define the Workflow "${name}"; a Workflow belongs to one Worker, and the others bind it with its script_name.`,
          );
        } else if (defined === undefined) {
          workflowsDefined.set(name, { worker: w.name, className: binding.class_name });
        }
      } else if (binding.type === "workflow") {
        const target = entryWorkerRefName(binding.script_name);
        if (target !== null) workflowRuns.push({ worker: w.name, target, binding });
      }
      if (binding.type === "plain_text" || binding.type === "json") continue;
      const shape = SHARED_RESOURCE_TYPES.has(binding.type)
        ? JSON.stringify({ ...binding, delivery_delay: undefined })
        : "";
      const seen = types.get(binding.name);
      if (seen === undefined) {
        types.set(binding.name, { type: binding.type, worker: w.name, shape });
      } else if (seen.type !== binding.type) {
        problems.push(
          `The binding ${binding.name} is a ${seen.type} binding in the Worker "${seen.worker}" and a ${binding.type} binding in the Worker "${w.name}"; bindings of one name share one resource, so they must be of one type.`,
        );
      } else if (seen.shape !== shape) {
        problems.push(
          `The binding ${binding.name} is declared differently in the Workers "${seen.worker}" and "${w.name}"; bindings of one name share one resource.`,
        );
      }
    }
  }
  // A binding that runs another Worker's Workflow names it the way that
  // Worker's own binding does, class included: Cloudflare looks the Workflow
  // up by name and runs it as its Worker defined it.
  for (const run of workflowRuns) {
    if (!names.has(run.target) || run.target === run.worker) continue; // Refused above.
    const name = upstreamWorkflowName(run.binding);
    const defined = workflowsDefined.get(name);
    if (defined === undefined || defined.worker !== run.target) {
      problems.push(
        `Workflow binding ${run.binding.name} of the Worker "${run.worker}" runs the Workflow "${name}" of the Worker "${run.target}", which defines no Workflow of that name.`,
      );
    } else if (
      run.binding.class_name !== undefined &&
      defined.className !== undefined &&
      run.binding.class_name !== defined.className
    ) {
      problems.push(
        `Workflow binding ${run.binding.name} of the Worker "${run.worker}" names the class ${String(run.binding.class_name)}, but the Worker "${run.target}" runs the Workflow "${name}" with ${String(defined.className)}.`,
      );
    }
  }
  for (const binding of Object.keys(manifest.d1)) {
    const bound = all.some((w) =>
      w.worker.bindings.some((b) => b.type === "d1" && b.name === binding),
    );
    if (!bound) problems.push(`D1 SQL is recorded for ${binding}, which no Worker binds.`);
  }
  const order = entryWorkerOrder(all);
  if (order.cycle !== null) {
    problems.push(
      `The Workers ${order.cycle.map((n) => `"${n}"`).join(", ")} name each other in a cycle; each Worker is deployed after the Workers it binds to, so one of them must not bind to the others.`,
    );
  }
  return problems;
}
