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
 * A rate limit binding's namespace id, assigned per install. Its counters exist
 * only while the Worker binds the id, so it goes with the Worker.
 */
export const RATE_LIMIT_KIND = "ratelimit" as const;

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
  RATE_LIMIT_KIND,
] as const;

/**
 * A custom domain (a hostname in one of the account's zones that serves the
 * Worker). It holds no data, so an uninstall always removes it, and does so
 * with its own call before deleting the Worker: Cloudflare does not document
 * that deleting a Worker removes its custom domains, and removing them first
 * holds either way.
 */
export const CUSTOM_DOMAIN_KIND = "domain" as const;

/**
 * A queue consumer: the link that delivers a queue's messages to the Worker.
 * It holds no data, so an uninstall always removes it, with its own call,
 * before the Worker and before any queue it reads.
 */
export const QUEUE_CONSUMER_KIND = "queue_consumer" as const;

/**
 * Something Appflare set up in Email Routing for the install: a routing rule
 * that delivers one address to the Worker, the zone's catch-all pointed at
 * the Worker, or Email Routing itself when Appflare turned it on for the
 * zone. None holds data, so an uninstall always undoes them, with calls of
 * their own and before deleting the Worker (a rule pointing at a deleted
 * Worker would bounce mail). `cf_id` says which one it is and on which zone
 * (see installs/email-routing.ts).
 */
export const EMAIL_ROUTE_KIND = "email_route" as const;

export function isDataResourceKind(kind: string): kind is DataResourceKind {
  return (DATA_RESOURCE_KINDS as readonly string[]).includes(kind);
}
