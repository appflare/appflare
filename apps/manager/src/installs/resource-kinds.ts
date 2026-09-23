/**
 * How an uninstall treats each `resources.kind`. Client-safe: the uninstall
 * dialog and the uninstall job share these lists.
 */

/**
 * Resources with their own delete call. The admin chooses, per resource,
 * whether the uninstall deletes it or keeps it in the account.
 */
export const DATA_RESOURCE_KINDS = ["kv", "d1", "r2", "queue", "vectorize"] as const;
export type DataResourceKind = (typeof DATA_RESOURCE_KINDS)[number];

/**
 * Resources that exist only as part of the Worker. Deleting the Worker with
 * `?force=true` removes its cron triggers, workers.dev route, secrets, Durable
 * Object namespaces (and their data), and the Workflows bound to it, so they
 * always go with the Worker and need no call of their own.
 */
export const WORKER_BOUND_KINDS = [
  "worker",
  "durable_object",
  "workflow",
  "cron",
  "secret",
  "subdomain",
] as const;

export function isDataResourceKind(kind: string): kind is DataResourceKind {
  return (DATA_RESOURCE_KINDS as readonly string[]).includes(kind);
}
