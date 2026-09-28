import type { ArtifactWorker } from "./artifact";
import type { CatalogManifest } from "./catalog";
import { appTokenPermissionGroup } from "./token-permissions";

/**
 * The Cloudflare services an app uses, worked out from its manifests. The
 * catalog publishes the result on each index row, so a manager can show it
 * without fetching a manifest, and a manager that has read a manifest works it
 * out the same way; both call {@link appServices}.
 */

/** Every service id, in display order: storage, compute, then account-level services. */
export const SERVICE_IDS = [
  "kv",
  "d1",
  "r2",
  "durable-objects",
  "hyperdrive",
  "vectorize",
  "analytics-engine",
  "queues",
  "pipelines",
  "workflows",
  "cron",
  "workers-ai",
  "browser-rendering",
  "images",
  "containers",
  "email-routing",
  "zone",
  "access",
] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

const KNOWN_IDS: ReadonlySet<string> = new Set(SERVICE_IDS);

/** Whether `value` is a service id this version knows; newer catalogs may publish more. */
export function isServiceId(value: string): value is ServiceId {
  return KNOWN_IDS.has(value);
}

/** Binding types (wrangler's names, as the artifact records them) and the service each one is. */
const BINDING_SERVICES: Readonly<Record<string, ServiceId>> = {
  kv_namespace: "kv",
  d1: "d1",
  r2_bucket: "r2",
  durable_object_namespace: "durable-objects",
  hyperdrive: "hyperdrive",
  vectorize: "vectorize",
  analytics_engine: "analytics-engine",
  queue: "queues",
  pipelines: "pipelines",
  workflow: "workflows",
  ai: "workers-ai",
  browser: "browser-rendering",
  images: "images",
  // Sending from a Worker delivers only to addresses verified in Email Routing.
  send_email: "email-routing",
};

/** Catalog `requires` values and the service each one is. */
const REQUIREMENT_SERVICES: Readonly<Record<string, ServiceId>> = {
  r2: "r2",
  zone: "zone",
  "email-routing": "email-routing",
  "workers-ai": "workers-ai",
  "browser-rendering": "browser-rendering",
  containers: "containers",
  "analytics-engine": "analytics-engine",
};

/** The service a catalog `requires` value is, or null for one this version does not know. */
export function requirementService(requirement: string): ServiceId | null {
  return REQUIREMENT_SERVICES[requirement] ?? null;
}

/** The parts of an artifact and catalog manifest the services come from; every field optional. */
export interface ServiceSources {
  bindings?: ReadonlyArray<{ type: string }>;
  /** Durable Object migrations, wrangler's shape. */
  migrations?: ReadonlyArray<Record<string, unknown>>;
  crons?: readonly string[];
  /** Queue consumers: the Worker receives messages from a queue. */
  queueConsumers?: readonly unknown[];
  requires?: readonly string[];
  tokenPermissions?: ReadonlyArray<{ scope: string; group: string }>;
  /** The manifest sets `install.emailRouting`: the install routes a domain's mail to the app. */
  emailRouting?: boolean;
  /** Vectorize indexes the catalog manifest sizes (`resources.vectorize`), by binding name. */
  vectorizeIndexes?: readonly string[];
  /** Databases the catalog manifest declares behind Hyperdrive (`resources.hyperdrive`), by binding name. */
  hyperdriveBindings?: readonly string[];
  /**
   * Streams the catalog manifest describes (`resources.pipelines`), by
   * binding name. Each sink writes to an R2 bucket, so R2 comes with them.
   */
  pipelineBindings?: readonly string[];
}

/** What an app uses, as {@link deriveServices} works it out. */
export interface AppServices {
  /** In {@link SERVICE_IDS} order, each once. */
  ids: ServiceId[];
  /**
   * The app declares key-value backed Durable Objects (`new_classes`), which
   * need Workers Paid; SQLite-backed ones run on every plan.
   */
  keyValueDurableObjects: boolean;
}

function declaresKeyValueClasses(migration: Record<string, unknown>): boolean {
  const added = migration.new_classes;
  return Array.isArray(added) && added.length > 0;
}

/** What an app uses, from whichever of its manifests' parts are known. */
export function deriveServices(sources: ServiceSources): AppServices {
  const found = new Set<ServiceId>();
  for (const binding of sources.bindings ?? []) {
    const id = BINDING_SERVICES[binding.type];
    if (id !== undefined) found.add(id);
  }
  if ((sources.queueConsumers ?? []).length > 0) found.add("queues");
  if ((sources.crons ?? []).length > 0) found.add("cron");
  if ((sources.vectorizeIndexes ?? []).length > 0) found.add("vectorize");
  if ((sources.hyperdriveBindings ?? []).length > 0) found.add("hyperdrive");
  if ((sources.pipelineBindings ?? []).length > 0) {
    found.add("pipelines");
    found.add("r2");
  }
  for (const requirement of sources.requires ?? []) {
    const id = REQUIREMENT_SERVICES[requirement];
    if (id !== undefined) found.add(id);
  }
  if (sources.emailRouting === true) {
    found.add("email-routing");
    found.add("zone");
  }
  for (const permission of sources.tokenPermissions ?? []) {
    if (permission.scope === "zone") found.add("zone");
    const service = appTokenPermissionGroup(permission.scope, permission.group)?.service;
    if (service !== undefined) found.add(service);
  }
  const keyValueDurableObjects = (sources.migrations ?? []).some(declaresKeyValueClasses);
  if (keyValueDurableObjects) found.add("durable-objects");
  return { ids: SERVICE_IDS.filter((id) => found.has(id)), keyValueDurableObjects };
}

/** The parts of a catalog manifest {@link appServices} reads. */
export type ServiceCatalogFacts = Pick<CatalogManifest, "requires" | "tokenPermissions"> & {
  install: Pick<CatalogManifest["install"], "emailRouting">;
  resources?:
    | Partial<
        Pick<NonNullable<CatalogManifest["resources"]>, "vectorize" | "hyperdrive" | "pipelines">
      >
    | undefined;
};

/** The parts of an artifact's Worker {@link appServices} reads. */
export type ServiceWorkerFacts = Pick<
  ArtifactWorker,
  "bindings" | "migrations" | "crons" | "queueConsumers"
>;

/**
 * What an app uses, from its catalog manifest and, for an artifact tier app,
 * its artifact's Worker. Without a Worker (a `sandbox` or `self-deploying`
 * entry, whose bindings exist only once it runs) the answer is what the
 * catalog manifest declares: `requires`, `install.emailRouting`, the Vectorize
 * indexes it sizes, the databases it reaches through Hyperdrive, the streams
 * it describes and its token's permissions.
 */
export function appServices(
  catalog: ServiceCatalogFacts,
  worker: ServiceWorkerFacts | null,
): AppServices {
  return deriveServices({
    bindings: worker?.bindings ?? [],
    migrations: worker?.migrations ?? [],
    crons: worker?.crons ?? [],
    queueConsumers: worker?.queueConsumers ?? [],
    requires: catalog.requires,
    tokenPermissions: catalog.tokenPermissions,
    emailRouting: catalog.install.emailRouting !== undefined,
    vectorizeIndexes: Object.keys(catalog.resources?.vectorize ?? {}),
    hyperdriveBindings: Object.keys(catalog.resources?.hyperdrive ?? {}),
    pipelineBindings: Object.keys(catalog.resources?.pipelines ?? {}),
  });
}
