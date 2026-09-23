import type { CloudflareClient } from "@appflare/cf-api";
import type { ResourceBindingPlan } from "./bindings";

/**
 * Finding and creating the backing resources of an install.
 * `findResource` is used before creating (a name that exists is never adopted)
 * and by a retried create step, to pick up what its own failed attempt made.
 */

export const RESOURCE_LABEL: Record<ResourceBindingPlan["kind"], string> = {
  kv: "KV namespace",
  d1: "D1 database",
  r2: "R2 bucket",
  queue: "queue",
  vectorize: "Vectorize index",
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
  }
}

/** Creates the resource and returns its id. */
export async function createResource(
  api: CloudflareClient,
  res: ResourceBindingPlan,
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
    case "vectorize": {
      if (res.vectorize === undefined) throw new Error("missing Vectorize dimensions and metric");
      await api.vectorize.createIndex({ name: res.name, config: res.vectorize });
      return res.name;
    }
  }
}
