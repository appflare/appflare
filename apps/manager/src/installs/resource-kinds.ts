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
 * An external domain: a hostname in someone else's DNS that serves the
 * Worker through a Cloudflare for SaaS custom hostname on the gateway zone
 * (gateway/). `name` is the hostname, `cf_id` is `<zone id>/<custom
 * hostname id>` (see `externalDomainRef`), `binding` the gateway's service
 * binding to the Worker. It holds no data, so an uninstall always removes
 * it, before the Worker: the custom hostname, its routing entry, and, with
 * the install's last one, the gateway's binding.
 */
export const CUSTOM_HOSTNAME_KIND = "custom_hostname" as const;

/**
 * A wildcard domain: a hostname in one of the account's zones (the base,
 * `tunnels.example.com`) whose every name serves the Worker, for an app
 * whose catalog manifest sets `install.wildcardHostname`. Workers custom
 * domains match one exact hostname, so the base is served through Workers
 * routes instead (`WILDCARD_PARTS_KINDS`). `name` is the base, `cf_id` the
 * zone id. It holds no data, so an uninstall always removes it, with its
 * routes and records, before the Worker.
 */
export const WILDCARD_DOMAIN_KIND = "wildcard_domain" as const;

/**
 * A proxied DNS record Appflare created for a wildcard domain (the base, and
 * `*.<base>`), so requests for those names reach Cloudflare and its routes.
 * `name` is the record's name, `cf_id` `<zone id>/<record id>`, `binding`
 * the wildcard domain's base hostname.
 */
export const DNS_RECORD_KIND = "dns_record" as const;

/**
 * A Workers route Appflare created for a wildcard domain (`<base>/*` and
 * `*.<base>/*`), sending those names to the Worker. `name` is the pattern,
 * `cf_id` `<zone id>/<route id>`, `binding` the wildcard domain's base.
 */
export const WORKER_ROUTE_KIND = "worker_route" as const;

/** What serves a wildcard domain; removed with it, never kept. */
export const WILDCARD_PARTS_KINDS = [DNS_RECORD_KIND, WORKER_ROUTE_KIND] as const;

/** The kinds that give an install an address besides workers.dev, oldest first by id. */
export const ADDRESS_KINDS = [
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  WILDCARD_DOMAIN_KIND,
] as const;

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

/**
 * The Cloudflare Access service token the manager's health checks of a
 * protected install sign in with (access/install-access.server.ts): `name`
 * is the token's name, `cf_id` its id. One per install, never shared. It
 * holds no data; it goes when the install stops being protected, after the
 * install's Access application (whose policy names it).
 */
export const ACCESS_SERVICE_TOKEN_KIND = "access_service_token" as const;

/**
 * A Hyperdrive configuration: the install's connection to a database that
 * lives outside Cloudflare, made from the connection string the admin
 * entered. It holds no data (the database is the admin's), but it holds the
 * database's credentials, so an uninstall always deletes it, with a call of
 * its own after the Worker that binds it. `cf_id` is the configuration's id.
 */
export const HYPERDRIVE_KIND = "hyperdrive" as const;

/**
 * A Hyperdrive configuration a settings change replaced: the serving version
 * binds a newer one, but the version the change's snapshot recorded still
 * binds this one, so it is kept while that snapshot is the latest and a
 * rollback to it still reaches the database. `binding` stays the binding it
 * served. The next successful update or settings change deletes it (its
 * snapshot is no longer the latest then), and so does an uninstall; a
 * rollback to a version that binds it makes it the bound one again.
 */
export const HYPERDRIVE_SUPERSEDED_KIND = "hyperdrive_superseded" as const;

/** Both Hyperdrive kinds: what an uninstall deletes after the Worker. */
export const HYPERDRIVE_KINDS = [HYPERDRIVE_KIND, HYPERDRIVE_SUPERSEDED_KIND] as const;

/**
 * A Pipelines stream: what a Worker's Pipelines binding sends events to.
 * `binding` is the binding, `cf_id` the stream's id (what the binding
 * carries). It buffers events only until the pipeline has moved them to the
 * sink, so it holds no data of its own.
 */
export const PIPELINE_STREAM_KIND = "pipeline_stream" as const;

/**
 * A Pipelines sink: writes the stream's events to an Iceberg table of an R2
 * bucket's Data Catalog. No binding. It holds the API token the admin gave for
 * it (Cloudflare keeps it), never data: the table lives in the bucket.
 */
export const PIPELINE_SINK_KIND = "pipeline_sink" as const;

/** A pipeline: the SQL that moves a stream's events into its sink. No binding, no data. */
export const PIPELINE_KIND = "pipeline" as const;

/**
 * Everything of a Pipelines binding, in the order an uninstall deletes it,
 * always and after the Worker: the pipeline first (it reads the stream and
 * writes the sink), then the sink, then the stream. Events already written
 * stay in the bucket, which is a data resource of its own.
 */
export const PIPELINE_KINDS = [PIPELINE_KIND, PIPELINE_SINK_KIND, PIPELINE_STREAM_KIND] as const;

/**
 * An R2 bucket's Data Catalog, turned on for a Pipelines sink: `name` is the
 * bucket's name. It goes with its bucket: an uninstall that deletes the bucket
 * removes the catalog first, with its tables' records (Cloudflare keeps them
 * after the bucket is gone otherwise, and a sink cannot create a table of the
 * same name again), and one that keeps the bucket keeps the catalog, so the
 * table stays readable.
 */
export const R2_CATALOG_KIND = "r2_catalog" as const;

export function isDataResourceKind(kind: string): kind is DataResourceKind {
  return (DATA_RESOURCE_KINDS as readonly string[]).includes(kind);
}
