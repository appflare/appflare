import type { CloudflareClient } from "@appflare/cf-api";
import type { HyperdriveOrigin } from "@appflare/schema";
import type { ResourceBindingPlan } from "./bindings";

/**
 * Finding, creating, and deleting the backing resources of an install.
 * `findResource` is used before creating (a name that exists is never adopted)
 * by a retried create step, to pick up what its own failed attempt made, and
 * by a delete of a resource recorded by name only, before its create.
 */

export const RESOURCE_LABEL: Record<ResourceBindingPlan["kind"], string> = {
  kv: "KV namespace",
  d1: "D1 database",
  r2: "R2 bucket",
  queue: "queue",
  vectorize: "Vectorize index",
  hyperdrive: "Hyperdrive configuration",
  pipeline_stream: "Pipelines stream",
};

/** The id of the resource with this name, or null when there is none. */
export async function findResource(
  api: CloudflareClient,
  res: Pick<ResourceBindingPlan, "type" | "name">,
): Promise<string | null> {
  switch (res.type) {
    case "kv_namespace":
      return (await api.kv.listNamespaces()).find((n) => n.title === res.name)?.id ?? null;
    case "d1":
      return (await api.d1.listDatabases()).find((d) => d.name === res.name)?.uuid ?? null;
    case "r2_bucket":
      return (
        (await api.r2.listBuckets({ nameContains: res.name })).find((b) => b.name === res.name)
          ?.name ?? null
      );
    case "queue":
      return (
        (await api.queues.listQueues()).find((q) => q.queue_name === res.name)?.queue_id ?? null
      );
    case "vectorize":
      return (await api.vectorize.listIndexes()).find((i) => i.name === res.name)?.name ?? null;
    case "hyperdrive":
      return (await api.hyperdrive.listConfigs()).find((c) => c.name === res.name)?.id ?? null;
    case "pipelines":
      return (await api.pipelines.listStreams()).find((s) => s.name === res.name)?.id ?? null;
  }
}

/**
 * Creates the resource and returns its id. A Hyperdrive configuration needs
 * `origin`, read from the connection string the admin entered (never
 * stored by the manager); without it this throws before any call.
 */
export async function createResource(
  api: CloudflareClient,
  res: ResourceBindingPlan,
  origin?: HyperdriveOrigin,
): Promise<string> {
  switch (res.type) {
    case "kv_namespace":
      return (await api.kv.createNamespace(res.name)).id;
    case "d1":
      return (await api.d1.createDatabase(res.name)).uuid;
    case "r2_bucket":
      return (await api.r2.createBucket({ name: res.name })).name ?? res.name;
    case "queue":
      return (await api.queues.createQueue(res.name)).queue_id;
    case "vectorize":
      // `POST /vectorize/v2/indexes` with `{ name, config: { dimensions, metric } }`;
      // an index is addressed by its name, so the name is its id.
      await api.vectorize.createIndex({ name: res.name, config: res.vectorize });
      return res.name;
    case "hyperdrive":
      if (origin === undefined) {
        throw new Error(`no connection string was given for the Hyperdrive binding ${res.binding}`);
      }
      // `POST /hyperdrive/configs` with `{ name, origin }`; Cloudflare
      // connects to the database before it answers. Query caching keeps its
      // default (on), as `wrangler hyperdrive create` leaves it.
      return (await api.hyperdrive.createConfig({ name: res.name, origin })).id;
    case "pipelines":
      // A stream comes with its sink and pipeline, and the sink needs the
      // admin's token: `provisionPipelinePhase` (./pipelines.ts) creates all three.
      throw new Error(`the stream of ${res.binding} is created with its sink and pipeline`);
  }
}

/** A recorded resource with its own delete call (`resources` row fields). */
export interface DeletableResource {
  kind: ResourceBindingPlan["kind"];
  name: string;
  /** Namespace, database, or queue id; bucket and index names are their ids. */
  cfId: string | null;
}

/** The plan type {@link findResource} looks each kind of resource up by. */
const TYPE_OF_KIND = {
  kv: "kv_namespace",
  d1: "d1",
  r2: "r2_bucket",
  queue: "queue",
  vectorize: "vectorize",
  hyperdrive: "hyperdrive",
  pipeline_stream: "pipelines",
} as const satisfies Record<ResourceBindingPlan["kind"], ResourceBindingPlan["type"]>;

/**
 * Deletes the resource with one API call and returns true, or returns false
 * without deleting anything when there is nothing to address. Throws
 * `CloudflareApiError` as is (a 404 means it is already gone; the caller
 * decides what that means).
 *
 * A row with no Cloudflare id is one whose name was recorded before its
 * create (see `provisionResourcePhase`): the resource of that name, if any,
 * is the one that create made, since the name was checked free just before.
 * It is looked up by name first; false when there is none, as the create
 * never finished. A Pipelines stream is never recorded that way, so one
 * without an id cannot be addressed (false).
 */
export async function deleteResource(
  api: CloudflareClient,
  res: DeletableResource,
): Promise<boolean> {
  const id =
    res.cfId ??
    (res.kind === "r2" || res.kind === "vectorize" || res.kind === "pipeline_stream"
      ? null
      : await findResource(api, { type: TYPE_OF_KIND[res.kind], name: res.name }));
  switch (res.kind) {
    case "kv":
      if (id === null) return false;
      await api.kv.deleteNamespace(id);
      return true;
    case "d1":
      if (id === null) return false;
      await api.d1.deleteDatabase(id);
      return true;
    case "r2":
      await api.r2.deleteBucket(id ?? res.name);
      return true;
    case "queue":
      if (id === null) return false;
      await api.queues.deleteQueue(id);
      return true;
    case "vectorize":
      await api.vectorize.deleteIndex(id ?? res.name);
      return true;
    case "hyperdrive":
      if (id === null) return false;
      await api.hyperdrive.deleteConfig(id);
      return true;
    case "pipeline_stream":
      if (id === null) return false;
      await api.pipelines.deleteStream(id);
      return true;
  }
}
