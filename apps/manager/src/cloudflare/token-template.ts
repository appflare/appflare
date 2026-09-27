/**
 * Dashboard template links for Cloudflare API tokens: the one Appflare asks for in
 * the setup wizard, and the ones an app needs for itself (its catalog manifest's
 * `tokenPermissions`). Client-safe: no server imports.
 *
 * URL format and permission keys: Cloudflare's "API token template URLs" page,
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 * (`permissionGroupKeys` = URL-encoded JSON array of `{ key, type }`). That page's
 * key table omits `vectorize` and `workers_tail`; both are the keys the dashboard
 * itself uses for those groups (seen in public template links using them). The
 * same page's "Access full management" template pairs `access` (the "Access:
 * Apps and Policies" group) with `access_acct` ("Access: Organizations,
 * Identity Providers, and Groups").
 *
 * The Email Routing keys (`email_routing_rule`, `email_routing_address`) are
 * not in that page's table either. A template key is the dashboard's
 * permission label without its `_read`/`_write` suffix, which holds for every
 * key the page does list (`zone_read` is `zone`, `zone_settings_write` is
 * `zone_settings`, `access_acct_read` is `access_acct`); the dashboard labels
 * these groups `email_routing_rule_write` and `email_routing_address_read`.
 */

import type { TokenPermission } from "@appflare/schema";
import { dashboardUrl } from "./dashboard-links";

export type PermissionType = "read" | "edit";

export interface PermissionGroup {
  /** Dashboard template key. */
  key: string;
  type: PermissionType;
  /** The group's name in the dashboard's permission picker. */
  label: string;
  /**
   * Set when only one optional feature uses the group: the feature's name.
   * The token works without it; that feature then says what is missing.
   */
  onlyFor?: string;
  /**
   * The group has no confirmed template key, so the dashboard form is not
   * prefilled with it: it is left out of the template links, and its name
   * says to add it by hand. `key` is then only an id within Appflare.
   */
  manual?: true;
}

/** The settings feature that puts the manager behind Cloudflare Access. */
export const ACCESS_FEATURE = "Protect with Cloudflare Access";

/**
 * The install page feature that serves an app on a hostname in one of the
 * account's zones, and an app that needs every name under one hostname on a
 * wildcard domain there (proxied DNS records and Workers routes, since
 * custom domains match one exact name). Both need the same three groups.
 */
export const CUSTOM_DOMAINS_FEATURE = "Custom domains";

/**
 * Serving an app on a hostname in someone else's DNS ("external domain"),
 * through Cloudflare for SaaS custom hostnames on one zone of the account
 * (the gateway zone, chosen in Settings > Domains). It also needs Zone: Read,
 * DNS: Edit and Workers Routes: Edit on that zone, listed under custom
 * domains: a group names one feature.
 */
export const EXTERNAL_DOMAINS_FEATURE = "External domains";

/**
 * The install page feature that delivers a zone's email to an app's Worker.
 * It also needs Zone: Read and DNS: Edit, listed under custom domains: a
 * group names one feature, and those two are already in the token.
 */
export const EMAIL_ROUTING_FEATURE = "Email Routing";

/**
 * The Settings feature that reads the account's Workers plan instead of
 * asking an admin. Cloudflare's Billing: Read also covers the billing
 * profile and invoices; Appflare only lists the subscriptions, for the plan
 * names.
 */
export const PLAN_DETECTION_FEATURE = "Workers plan detection";

/**
 * Settings > Building apps > Build in your account: Appflare deploys,
 * updates and removes the sandbox Worker's container applications itself
 * (Workers Paid only). Kept on the token after enabling, because every
 * sandbox update rolls the applications to a new image and disabling
 * deletes them.
 */
export const SANDBOX_BUILDS_FEATURE = "Sandbox builds";

/**
 * Installing an app that keeps its data in a database outside Cloudflare
 * (its catalog manifest's `resources.hyperdrive`): Appflare creates a
 * Hyperdrive configuration per database from the connection string the
 * admin enters, replaces it when the string changes, and deletes it on
 * uninstall.
 */
export const DATABASE_ELSEWHERE_FEATURE = "Apps with a database elsewhere";

/**
 * Installing an app that streams events into R2 (its catalog manifest's
 * `resources.pipelines`): Appflare creates a Pipelines stream, sink and
 * pipeline per stream the app binds, and deletes them on uninstall. The
 * sink's R2 Data Catalog calls use a token the admin creates for the app,
 * not this one.
 */
export const PIPELINES_FEATURE = "Apps that stream events";

export const TOKEN_PERMISSION_GROUPS = [
  // Upload, version, deploy, and delete app Workers and the manager itself; their
  // secrets, cron triggers, workers.dev routes, and static assets.
  { key: "workers_scripts", type: "edit", label: "Workers Scripts" },
  // Create and delete KV namespaces for apps that bind KV.
  { key: "workers_kv_storage", type: "edit", label: "Workers KV Storage" },
  // Create D1 databases, apply app migrations, Time Travel restore.
  { key: "d1", type: "edit", label: "D1" },
  // Create and delete R2 buckets for apps that bind R2.
  { key: "workers_r2", type: "edit", label: "Workers R2 Storage" },
  // Create and delete Queues for apps with producers or consumers.
  { key: "queues", type: "edit", label: "Queues" },
  // Create and delete Vectorize indexes for apps that bind them.
  { key: "vectorize", type: "edit", label: "Vectorize" },
  // Create, update, and delete the self-hosted Access application (and its
  // policy) that puts the manager behind Cloudflare Access.
  { key: "access", type: "edit", label: "Access: Apps and Policies", onlyFor: ACCESS_FEATURE },
  // Read the account's Zero Trust organization: its team domain issues and
  // signs the Access tokens the manager verifies.
  {
    key: "access_acct",
    type: "read",
    label: "Access: Organizations, Identity Providers, and Groups",
    onlyFor: ACCESS_FEATURE,
  },
  // List the zones a custom domain's hostname can be in.
  { key: "zone", type: "read", label: "Zone", onlyFor: CUSTOM_DOMAINS_FEATURE },
  // Read the DNS records a new custom domain would replace, and replace them
  // when the admin agrees; create and delete a wildcard domain's proxied
  // records (its base and every name under it).
  { key: "dns", type: "edit", label: "DNS", onlyFor: CUSTOM_DOMAINS_FEATURE },
  // What Cloudflare requires on a zone to attach a Worker to one of its
  // hostnames; also creates and deletes a wildcard domain's two Workers routes.
  { key: "workers_routes", type: "edit", label: "Workers Routes", onlyFor: CUSTOM_DOMAINS_FEATURE },
  // Create and remove custom hostnames and set the fallback origin on the
  // gateway zone (Cloudflare for SaaS). Key `ssl_and_certificates` is in the
  // template page's key table.
  {
    key: "ssl_and_certificates",
    type: "edit",
    label: "SSL and Certificates",
    onlyFor: EXTERNAL_DOMAINS_FEATURE,
  },
  // Read whether Email Routing is on for the zone an email app uses, and turn
  // it on (Cloudflare then adds its MX, SPF and DKIM records) or off again.
  // Cloudflare's API files these calls under Zone Settings.
  { key: "zone_settings", type: "edit", label: "Zone Settings", onlyFor: EMAIL_ROUTING_FEATURE },
  // Create and remove the routing rules, and set the catch-all, that deliver
  // a zone's email to an app's Worker.
  {
    key: "email_routing_rule",
    type: "edit",
    label: "Email Routing Rules",
    onlyFor: EMAIL_ROUTING_FEATURE,
  },
  // List the account's verified destination addresses: an app with a
  // send_email binding can send to those for free on every plan.
  {
    key: "email_routing_address",
    type: "read",
    label: "Email Routing Addresses",
    onlyFor: EMAIL_ROUTING_FEATURE,
  },
  // List the account's subscriptions (`GET /accounts/{id}/subscriptions`) to
  // read which Workers plan it is on; nothing else of the billing data is read.
  // Key `billing` is in the template page's key table.
  { key: "billing", type: "read", label: "Billing", onlyFor: PLAN_DETECTION_FEATURE },
  // Create, roll out and delete the sandbox Worker's two container
  // applications ("Workers Containers Write" in the API's group list). The
  // template key is not in the template page's table and does not follow the
  // label rule above (that would give `workers_containers`): the dashboard's
  // own key is `containers`, as published tables of the keys read from the
  // dashboard's code and public template links for this group both use.
  { key: "containers", type: "edit", label: "Containers", onlyFor: SANDBOX_BUILDS_FEATURE },
  // Create, list and delete Hyperdrive configurations for apps whose database
  // lives elsewhere ("Hyperdrive Write" in the API's group list). The
  // template key is not in the template page's table and is not the
  // product's name: Hyperdrive began as "query cache", and the dashboard
  // labels the group `query_cache_write` (its permission group list, as
  // published by Cloudflare-Mining/Cloudflare-Datamining's
  // `token_permission_groups_dash.json`), so the key is `query_cache` by the
  // label rule above.
  { key: "query_cache", type: "edit", label: "Hyperdrive", onlyFor: DATABASE_ELSEWHERE_FEATURE },
  // Create, list and delete the Pipelines streams, sinks and pipelines of
  // apps that stream events into R2 ("Pipelines Write" in the API's group
  // list; every `/pipelines/v1` call Appflare makes needs it or its Read
  // half). Not in the template page's table either: the dashboard labels the
  // group `pipelines_write` (the same published list as Hyperdrive's), so the
  // key is `pipelines` by the label rule above.
  { key: "pipelines", type: "edit", label: "Pipelines", onlyFor: PIPELINES_FEATURE },
  // Remove the R2 Data Catalog of a bucket such an app wrote to when an
  // uninstall deletes the bucket (`POST /r2-catalog/{bucket}/delete` needs
  // "Workers R2 Data Catalog Write" in the API's group list); without it the
  // bucket is still deleted and the catalog's records stay until a bucket of
  // that name is made again. Neither the template page's table nor the
  // dashboard's published group list has a key for it, so it is added by hand.
  // (Public template links use `r2_catalog`; app token links use it, but it
  // stays out of Appflare's own link until the dashboard is seen to take it.)
  {
    key: "workers_r2_data_catalog",
    type: "edit",
    label: "Workers R2 Data Catalog",
    onlyFor: PIPELINES_FEATURE,
    manual: true,
  },
  // Find the account id and name the token belongs to (`GET /accounts`).
  { key: "account_settings", type: "read", label: "Account Settings" },
  // Stream a Worker's live logs while diagnosing an install or update.
  { key: "workers_tail", type: "read", label: "Workers Tail" },
] as const satisfies readonly PermissionGroup[];

/** The token name the dashboard form is prefilled with. */
export const TOKEN_NAME = "Appflare";

/** The groups every install needs, and the ones only an optional feature uses. */
export function splitPermissionGroups(
  groups: readonly PermissionGroup[] = TOKEN_PERMISSION_GROUPS,
): {
  required: PermissionGroup[];
  optional: PermissionGroup[];
} {
  return {
    required: groups.filter((g) => g.onlyFor === undefined),
    optional: groups.filter((g) => g.onlyFor !== undefined),
  };
}

/** The optional groups by the feature that uses them, in the order they are listed. */
export function optionalGroupsByFeature(
  groups: readonly PermissionGroup[] = TOKEN_PERMISSION_GROUPS,
): Array<{ feature: string; groups: PermissionGroup[] }> {
  const byFeature = new Map<string, PermissionGroup[]>();
  for (const g of groups) {
    if (g.onlyFor === undefined) continue;
    const list = byFeature.get(g.onlyFor) ?? [];
    list.push(g);
    byFeature.set(g.onlyFor, list);
  }
  return [...byFeature].map(([feature, list]) => ({ feature, groups: list }));
}

/** `Label: Edit` / `Label: Read`, the wording of the dashboard's picker. */
export function permissionName(group: PermissionGroup): string {
  const name = `${group.label}: ${group.type === "edit" ? "Edit" : "Read"}`;
  return group.manual === true ? `${name} (add by hand)` : name;
}

function encodedGroups(groups: readonly PermissionGroup[]): string {
  return encodeURIComponent(
    JSON.stringify(groups.filter((g) => g.manual !== true).map(({ key, type }) => ({ key, type }))),
  );
}

/**
 * Account API token form (preferred): owned by the account, so it
 * keeps working when the person who created it leaves. Opens the account
 * Appflare runs in once it is known; before the first token is saved
 * `:account` makes the dashboard ask which account when the user has several.
 */
export function accountTokenTemplateUrl(
  accountId: string | null = null,
  groups: readonly PermissionGroup[] = TOKEN_PERMISSION_GROUPS,
): string {
  return `${dashboardUrl(accountId, "api-tokens")}&permissionGroupKeys=${encodedGroups(groups)}&name=${encodeURIComponent(TOKEN_NAME)}`;
}

/**
 * User API token form (fallback for people who cannot create account tokens,
 * which needs Super Administrator). `accountId=*` while the manager does not
 * know its account (before it has a token), and the user narrows it in the
 * form; once known, the form starts on the account Appflare runs in.
 */
export function userTokenTemplateUrl(
  groups: readonly PermissionGroup[] = TOKEN_PERMISSION_GROUPS,
  name: string = TOKEN_NAME,
  accountId: string | null = null,
): string {
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodedGroups(groups)}&accountId=${encodeURIComponent(accountId || "*")}&zoneId=all&name=${encodeURIComponent(name)}`;
}

/** The dashboard's API tokens page, for permissions no template can prefill. */
export const USER_API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * The account's R2 API tokens page. Its account token with Admin Read &
 * Write carries R2 storage, R2 Data Catalog and R2 SQL; wrangler 4.136.2's
 * `pipelines setup` sends people to the same page for a sink's catalog token.
 */
export function r2ApiTokensUrl(accountId: string | null): string {
  return dashboardUrl(accountId, "r2/api-tokens");
}

/**
 * Permission names an app's catalog manifest may use, `<Scope>.<Group>` in the
 * dashboard's wording, mapped to template keys. Matching ignores case. Where
 * each key comes from:
 *
 * - The permission reference on Cloudflare's "API token template URLs" page
 *   (linked above): `dns`, `zone`, `zone_settings`, `analytics`,
 *   `firewall_services`, `page_rules`, `ssl_and_certificates`,
 *   `account_settings`, `account_analytics`, `billing`, `workers_scripts`,
 *   `workers_kv_storage`, `workers_routes`, `workers_r2`, `d1`, `queues`,
 *   `logs`, `access`, `access_acct`.
 * - The dashboard's own group labels (`<key>_read` / `<key>_write`, the rule
 *   described at the top of this file; Cloudflare-Mining/Cloudflare-Datamining's
 *   `token_permission_groups_dash.json`): `email_routing_rule`,
 *   `email_routing_address`, `query_cache` (Hyperdrive), `pipelines`,
 *   `vectorize`, `workers_tail`, `load_balancers`, `account_logs` (the
 *   account-scoped Logs group; `logs` is the zone one), `magic_transit`.
 * - Public template links for groups added after that list: Cloudflare's own
 *   cloudflare-prometheus-exporter README (`firewall_services`,
 *   `load_balancers`, `account_logs`, `magic_transit`), savvyagents/larasend
 *   (`email_sending`), pkishorez/monorepo's Alchemy console (`secrets_store`),
 *   shivamanupadi/traks (`r2_catalog`, `r2_catalog_sql`), and the manager's
 *   own `containers` (see TOKEN_PERMISSION_GROUPS above).
 *
 * A name not listed here is listed without a key: the token link cannot
 * select it, and the app's page says so next to it.
 */
const APP_PERMISSION_KEYS: Readonly<Record<string, Omit<PermissionGroup, "type">>> = {
  "zone.dns": { key: "dns", label: "Zone: DNS" },
  "zone.zone": { key: "zone", label: "Zone: Zone" },
  "zone.zone settings": { key: "zone_settings", label: "Zone: Zone Settings" },
  "zone.analytics": { key: "analytics", label: "Zone: Analytics" },
  "zone.page rules": { key: "page_rules", label: "Zone: Page Rules" },
  "zone.ssl and certificates": { key: "ssl_and_certificates", label: "Zone: SSL and Certificates" },
  "zone.firewall services": { key: "firewall_services", label: "Zone: Firewall Services" },
  "zone.load balancers": { key: "load_balancers", label: "Zone: Load Balancers" },
  "zone.logs": { key: "logs", label: "Zone: Logs" },
  "zone.workers routes": { key: "workers_routes", label: "Zone: Workers Routes" },
  "zone.email routing rules": { key: "email_routing_rule", label: "Zone: Email Routing Rules" },
  "account.account settings": { key: "account_settings", label: "Account: Account Settings" },
  "account.account analytics": { key: "account_analytics", label: "Account: Account Analytics" },
  "account.billing": { key: "billing", label: "Account: Billing" },
  "account.logs": { key: "account_logs", label: "Account: Logs" },
  "account.magic transit": { key: "magic_transit", label: "Account: Magic Transit" },
  "account.workers scripts": { key: "workers_scripts", label: "Account: Workers Scripts" },
  "account.workers kv storage": { key: "workers_kv_storage", label: "Account: Workers KV Storage" },
  "account.workers r2 storage": { key: "workers_r2", label: "Account: Workers R2 Storage" },
  "account.workers r2 data catalog": {
    key: "r2_catalog",
    label: "Account: Workers R2 Data Catalog",
  },
  "account.workers r2 sql": { key: "r2_catalog_sql", label: "Account: Workers R2 SQL" },
  "account.workers tail": { key: "workers_tail", label: "Account: Workers Tail" },
  "account.workers containers": { key: "containers", label: "Account: Workers Containers" },
  "account.d1": { key: "d1", label: "Account: D1" },
  "account.queues": { key: "queues", label: "Account: Queues" },
  "account.vectorize": { key: "vectorize", label: "Account: Vectorize" },
  "account.secrets store": { key: "secrets_store", label: "Account: Secrets Store" },
  "account.email sending": { key: "email_sending", label: "Account: Email Sending" },
  "account.email routing addresses": {
    key: "email_routing_address",
    label: "Account: Email Routing Addresses",
  },
  // The dashboard's key for Hyperdrive (see TOKEN_PERMISSION_GROUPS above).
  "account.hyperdrive": { key: "query_cache", label: "Account: Hyperdrive" },
  // The dashboard's key for Pipelines (see TOKEN_PERMISSION_GROUPS above).
  "account.pipelines": { key: "pipelines", label: "Account: Pipelines" },
  // The same two groups the manager asks for to put itself behind Access; apps
  // that create their own Access application (self-deploying ones) need them.
  "account.access: apps and policies": { key: "access", label: "Access: Apps and Policies" },
  "account.access: organizations, identity providers, and groups": {
    key: "access_acct",
    label: "Access: Organizations, Identity Providers, and Groups",
  },
};

/**
 * Why the token link cannot select a permission (one line, next to it on the
 * app's page): its name matches no dashboard group Appflare knows of, or it
 * names no scope to tell an account group from a zone one.
 */
export function unmappedPermissionReason(
  permission: Pick<AppTokenPermission, "name" | "scope">,
): string {
  const bare = !permission.name.includes(".") && permission.scope === null;
  return bare
    ? "Not selected for you: the app does not say whether it is an account or a zone permission. Add it in the form."
    : "Not selected for you: Cloudflare's token link has no way to select it. Add it in the form.";
}

/** One entry of an app's `tokenPermissions`, with the template group it maps to. */
export interface AppTokenPermission {
  name: string;
  description: string | null;
  scope: NonNullable<TokenPermission["scope"]> | null;
  /** Null when the name has no known template key: the token link cannot select it. */
  group: PermissionGroup | null;
}

/**
 * Maps a manifest permission to a template group. The name is `<Scope>.<Group>`
 * (`Zone.DNS`), or just `<Group>` when `scope` is set, with an optional `:Read`
 * or `:Edit` suffix. Without a suffix the level is Edit: the manifest lists what
 * the app must be able to do, and the dashboard form shows the level before the
 * token is created. A prefix that contradicts `scope` maps to nothing rather
 * than to a guess.
 */
function templateGroup(permission: TokenPermission): PermissionGroup | null {
  const match = /^(.*?)(?::(read|edit))?$/i.exec(permission.name.trim());
  if (match === null) return null;
  const base = (match[1] ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const type: PermissionType = match[2]?.toLowerCase() === "read" ? "read" : "edit";
  const dot = base.indexOf(".");
  let qualified = base;
  if (dot === -1) {
    if (permission.scope === undefined) return null;
    qualified = `${permission.scope}.${base}`;
  } else if (permission.scope !== undefined && base.slice(0, dot) !== permission.scope) {
    return null;
  }
  const known = APP_PERMISSION_KEYS[qualified];
  return known === undefined ? null : { ...known, type };
}

/** The app's `tokenPermissions`, each with the template group it maps to, if any. */
export function resolveAppTokenPermissions(
  permissions: readonly TokenPermission[],
): AppTokenPermission[] {
  return permissions.map((p) => ({
    name: p.name,
    description: p.description ?? null,
    scope: p.scope ?? null,
    group: templateGroup(p),
  }));
}

/**
 * The token form for an app's own token, prefilled with every permission that
 * maps to a template key and named after the app. Null when none maps. It is the
 * user token form because a user token passes `/user/tokens/verify`, the check
 * apps commonly run on their token (an account token fails it), and because the
 * form can narrow the token to one zone. With `accountId` the form starts on
 * the account Appflare runs in.
 */
export function appTokenTemplateUrl(
  appName: string,
  permissions: readonly AppTokenPermission[],
  accountId: string | null = null,
): string | null {
  // One entry per key; Edit covers Read.
  const groups = new Map<string, PermissionGroup>();
  for (const { group } of permissions) {
    if (group === null) continue;
    const seen = groups.get(group.key);
    if (seen === undefined || (seen.type === "read" && group.type === "edit")) {
      groups.set(group.key, group);
    }
  }
  if (groups.size === 0) return null;
  return userTokenTemplateUrl([...groups.values()], appName, accountId);
}
