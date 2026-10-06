/**
 * The Cloudflare OAuth scopes Appflare's manager asks for, one per permission
 * group of its API token (the manager's `TOKEN_PERMISSION_GROUPS`, keyed by
 * the same dashboard template keys). A browser install and an OAuth reconnect
 * both request the whole list, every time: one connection covers every
 * manager feature, so enabling a feature later never needs another consent.
 *
 * Scope ids come from Cloudflare's scope catalog, `GET /oauth/scopes` (read
 * on 2026-10-05; 392 scopes). OAuth scope ids are not the token template keys
 * with dashes: each was matched by its group in the catalog, never derived by
 * string replacement. A group's level carries over (Edit is `.write`, Read is
 * `.read`).
 *
 * Client-safe and dependency-free, so the manager, the hosted installer and
 * the deploy page can all import it.
 */

/**
 * Manager permission group key -> OAuth scope id, or `null` for a group the
 * OAuth catalog has no scope for. Every manager group must appear here; the
 * manager's tests fail when one is added without a decision.
 */
export const MANAGER_OAUTH_SCOPE_BY_GROUP = {
  workers_scripts: "workers-scripts.write",
  workers_kv_storage: "workers-kv-storage.write",
  d1: "d1.write",
  workers_r2: "workers-r2.write",
  queues: "queues.write",
  vectorize: "vectorize.write",
  // The account-level Access scope: Appflare's Access applications, policies
  // and reusable policies are all account resources. The catalog's separate
  // `zone-access.write` covers zone-level Access applications, which Appflare
  // does not create.
  access: "access.write",
  access_acct: "access-acct.read",
  access_service_token: "access-service-token.write",
  zone: "zone.read",
  dns: "dns.write",
  workers_routes: "workers-routes.write",
  ssl_and_certificates: "ssl-and-certificates.write",
  zone_settings: "zone-settings.write",
  email_routing_rule: "email-routing-rule.write",
  email_routing_address: "email-routing-address.read",
  // No Billing scope exists in the OAuth catalog, and an OAuth grant got
  // HTTP 403 (code 10000) from `GET /subscriptions` when tried. Over
  // OAuth the manager cannot detect the Workers plan; it keeps its other
  // ways (capability probes, an admin's saved choice, Free limits otherwise).
  billing: null,
  // "Workers Containers Write" in the catalog.
  containers: "containers.write",
  // Hyperdrive.
  query_cache: "query-cache.write",
  pipelines: "pipelines.write",
  workers_r2_data_catalog: "r2-catalog.write",
  account_settings: "account-settings.read",
  workers_tail: "workers-tail.read",
} as const satisfies Record<string, string | null>;

/** A manager permission group key that has a scope decision. */
export type ManagerOAuthGroupKey = keyof typeof MANAGER_OAUTH_SCOPE_BY_GROUP;

/**
 * The protocol scope that makes the token endpoint issue a refresh token.
 *
 * Cloudflare adds `offline_access` to a client's *allowed* scopes when the
 * client is registered with the `refresh_token` grant type (the OAuth client
 * registration API's `scopes` field), so asking for it is always accepted.
 * That registration does not put it into each authorization request, and
 * wrangler's own login appends it to every request it makes
 * (cloudflare/workers-sdk, `packages/workers-auth/src/generate-auth-url.ts`).
 * Appflare asks for it explicitly too: without a refresh token, the manager
 * would lose Cloudflare access an hour after it is connected.
 */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

function uniqueScopes(): string[] {
  const scopes: string[] = [];
  for (const scope of Object.values(MANAGER_OAUTH_SCOPE_BY_GROUP)) {
    if (scope !== null && !scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

/**
 * The Cloudflare API scopes a manager connection needs, in group order,
 * without the protocol scope. Compare a grant's scopes with this list.
 */
export const MANAGER_OAUTH_API_SCOPES: readonly string[] = Object.freeze(uniqueScopes());

/** Every scope to request when connecting a manager: the API scopes plus `offline_access`. */
export const MANAGER_OAUTH_SCOPES: readonly string[] = Object.freeze([
  ...MANAGER_OAUTH_API_SCOPES,
  OFFLINE_ACCESS_SCOPE,
]);

/**
 * The manager API scopes a grant lacks, in {@link MANAGER_OAUTH_API_SCOPES}
 * order; empty when the grant covers them all. `offline_access` is not
 * checked here: a refresh token in the token response is the proof of it.
 */
export function missingManagerScopes(granted: readonly string[]): string[] {
  const have = new Set(granted);
  return MANAGER_OAUTH_API_SCOPES.filter((scope) => !have.has(scope));
}
