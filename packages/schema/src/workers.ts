import type {
  ArtifactAssets,
  ArtifactManifest,
  ArtifactWorker,
  D1Migrations,
  WorkerBinding,
} from "./artifact";
import type { CatalogManifest, CatalogSecret, CatalogVar } from "./catalog";

/**
 * Apps that install as several Workers deployed together (a catalog entry's
 * `install.workers`, an artifact manifest of `format: 2`).
 *
 * One Worker is primary: it runs under the install's own Worker name, answers
 * the app's address and health check, and is described by the manifest's
 * `worker` and `assets`, exactly as the only Worker of a one-Worker app is.
 * Every other Worker is listed in the manifest's `workers` and runs as
 * `<install Worker name>-<name>`. Resources are the entry's, shared by binding
 * name: two Workers that bind `DB` use one D1 database, whose migrations are
 * the manifest's `d1Migrations`.
 *
 * Where a wrangler config names another Worker of the entry (a service
 * binding's `service`, a Durable Object binding's `script_name`), the packer
 * records `{{workerName:<name>}}` instead, and the manager puts the installed
 * Worker's name in its place. A Worker is deployed only after the Workers it
 * names, so the entry's Workers must not name each other in a cycle.
 *
 * Imports only types, so `artifact.ts` can use it without a cycle at load time.
 */

/** One Worker of an app, whatever the manifest's format. */
export interface AppWorker {
  /** The Worker's name within the entry (`install.workers[].name`); `null` for a one-Worker app. */
  name: string | null;
  primary: boolean;
  worker: ArtifactWorker;
  assets: ArtifactAssets;
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
 * Durable Object binding's `script_name`, when the packer recorded it as
 * `{{workerName:<name>}}`.
 */
export function bindingEntryRefs(binding: WorkerBinding): string[] {
  if (binding.type === "service") {
    const name = entryWorkerRefName(binding.service);
    return name === null ? [] : [name];
  }
  if (binding.type === "durable_object_namespace") {
    const name = entryWorkerRefName(binding.script_name);
    return name === null ? [] : [name];
  }
  return [];
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
  return catalog.install.workers?.find((w) => w.primary === true)?.name ?? null;
}

/** The Workers other than the primary one: the manifest's `workers`, empty for `format: 1`. */
export function secondaryWorkers(
  manifest: Pick<ArtifactManifest, "format"> & { workers?: readonly AppWorkerEntry[] },
): readonly AppWorkerEntry[] {
  return manifest.format === 2 ? (manifest.workers ?? []) : [];
}

/** One entry of a `format: 2` manifest's `workers`. */
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
    worker: manifest.worker,
    assets: manifest.assets,
  };
  return [
    primary,
    ...secondaryWorkers(manifest).map((w) => ({
      name: w.name,
      primary: false,
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
    names[w.name] = entryScriptName(installWorkerName, w.name, w.primary === true);
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

/** What the placeholders naming an entry's Workers are filled in with, by name within the entry. */
export type EntryWorkerPlaceholders = Readonly<
  Record<string, { workerName: string; workerUrl: string | null }>
>;

/**
 * What `{{workerUrl:<name>}}` and `{{workerName:<name>}}` become for an
 * install under `installWorkerName`: each Worker's installed name and its
 * workers.dev URL (null while the account's subdomain is unknown). The
 * primary Worker's URL is `appUrl` when given (the app's address, as
 * `{{workerUrl}}` is). Undefined for an app of one Worker.
 */
export function entryPlaceholderValues(
  catalog: Pick<CatalogManifest, "install">,
  installWorkerName: string,
  subdomain: string | null | undefined,
  appUrl?: string | null,
): EntryWorkerPlaceholders | undefined {
  const declared = catalog.install.workers;
  if (declared === undefined) return undefined;
  const values: Record<string, { workerName: string; workerUrl: string | null }> = {};
  for (const w of declared) {
    const primary = w.primary === true;
    const scriptName = entryScriptName(installWorkerName, w.name, primary);
    const workersDev = subdomain ? `https://${scriptName}.${subdomain}.workers.dev` : null;
    values[w.name] = {
      workerName: scriptName,
      workerUrl: primary && appUrl != null ? appUrl : workersDev,
    };
  }
  return values;
}

const ENTRY_PLACEHOLDER_PATTERN = new RegExp(
  `\\{\\{\\s*(workerUrl|workerName):(${ENTRY_NAME})\\s*\\}\\}`,
  "g",
);

/** Whether `text` holds `{{workerUrl:<name>}}` or `{{workerName:<name>}}`. */
export function hasEntryWorkerPlaceholder(text: string): boolean {
  return new RegExp(ENTRY_PLACEHOLDER_PATTERN.source).test(text);
}

/**
 * `text` with `{{workerUrl:<name>}}` and `{{workerName:<name>}}` filled in:
 * the workers.dev URL (no trailing slash) and the Worker name that entry
 * Worker was installed as. A placeholder naming a Worker the entry does not
 * have, or a URL not known yet, is left as written.
 */
export function renderEntryWorkerPlaceholders(
  text: string,
  workers: EntryWorkerPlaceholders,
): string {
  return text.replace(ENTRY_PLACEHOLDER_PATTERN, (match, key: string, name: string) => {
    const values = Object.hasOwn(workers, name) ? workers[name] : undefined;
    if (values === undefined) return match;
    return key === "workerName" ? values.workerName : (values.workerUrl ?? match);
  });
}

/**
 * The bindings, Durable Object migrations, crons and queue consumers of every
 * Worker of the app together, for what an app uses as a whole (`appServices`).
 */
export function combinedWorkerFacts(
  manifest: Pick<ArtifactManifest, "worker"> & {
    format?: number;
    workers?: readonly { worker: ArtifactWorker }[];
  },
): Pick<ArtifactWorker, "bindings" | "migrations" | "crons" | "queueConsumers"> {
  const others = manifest.format === 2 ? (manifest.workers ?? []) : [];
  const workers = [manifest.worker, ...others.map((w) => w.worker)];
  return {
    bindings: workers.flatMap((w) => w.bindings),
    migrations: workers.flatMap((w) => w.migrations),
    crons: workers.flatMap((w) => w.crons),
    queueConsumers: workers.flatMap((w) => w.queueConsumers ?? []),
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
 * What is wrong with the Workers of a `format: 2` manifest, as sentences;
 * empty when nothing is. The packer, the manifest schema and the manager all
 * hold an artifact to these.
 */
export function entryWorkerProblems(manifest: {
  worker: ArtifactWorker;
  workers: readonly AppWorkerEntry[];
  d1Migrations: D1Migrations;
  catalog: Pick<CatalogManifest, "install">;
}): string[] {
  const problems: string[] = [];
  const declared = manifest.catalog.install.workers;
  if (declared === undefined) {
    return ["The artifact lists several Workers, but its catalog manifest has no install.workers."];
  }
  const primaryName = declared.find((w) => w.primary === true)?.name;
  const others = declared.filter((w) => w.primary !== true).map((w) => w.name);
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
      if (binding.type === "workflow") {
        const owner = workflowOwners.get(binding.name);
        if (owner !== undefined) {
          problems.push(
            `The Workers "${owner}" and "${w.name}" both have the Workflow binding ${binding.name}; a Workflow belongs to one Worker.`,
          );
        }
        workflowOwners.set(binding.name, w.name);
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
  for (const binding of Object.keys(manifest.d1Migrations)) {
    const bound = all.some((w) =>
      w.worker.bindings.some((b) => b.type === "d1" && b.name === binding),
    );
    if (!bound) {
      problems.push(`D1 migrations are recorded for ${binding}, which no Worker binds.`);
    }
  }
  const order = entryWorkerOrder(all);
  if (order.cycle !== null) {
    problems.push(
      `The Workers ${order.cycle.map((n) => `"${n}"`).join(", ")} name each other in a cycle; each Worker is deployed after the Workers it binds to, so one of them must not bind to the others.`,
    );
  }
  return problems;
}
