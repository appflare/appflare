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
 *
 * An app's own permissions take their keys from the catalog schema's list of
 * the groups an app may ask for (`APP_TOKEN_PERMISSION_GROUPS`), which says
 * where each key comes from.
 */

import {
  appTokenPermissionGroup,
  type TokenPermission,
  type TokenPermissionAccess,
  type TokenPermissionScope,
} from "@appflare/schema";
import { dashboardUrl } from "./dashboard-links";

/** The template's `type`: `purge` selects the one level of Cache Purge. */
export type PermissionType = "read" | "edit" | "purge";

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

/**
 * Cloudflare Access, for both of its uses: putting Appflare itself behind a
 * sign-in ("Protect with Cloudflare Access" in Settings), and protecting
 * installed apps, which share one reusable policy and each have their own
 * service token the manager's health checks sign in with
 * (access/install-access.server.ts). One feature name, so the token form
 * lists the Access groups together.
 */
export const ACCESS_FEATURE = "Cloudflare Access";

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
  // Create, update, and delete the self-hosted Access applications (and their
  // policies) that put the manager or an installed app behind Cloudflare
  // Access, and the reusable policies protected apps share.
  { key: "access", type: "edit", label: "Access: Apps and Policies", onlyFor: ACCESS_FEATURE },
  // Read the account's Zero Trust organization: its team domain issues and
  // signs the Access tokens the manager verifies.
  {
    key: "access_acct",
    type: "read",
    label: "Access: Organizations, Identity Providers, and Groups",
    onlyFor: ACCESS_FEATURE,
  },
  // Create, refresh, rotate and delete each protected app's own service
  // token, which the manager's health checks of that app sign in with; only
  // protecting apps uses it. Not in the template page's table: the dashboard labels the group
  // `access_service_token_write` ("Access: Service Tokens Write" in the
  // published list Hyperdrive's key comes from, below), so the key is
  // `access_service_token` by the label rule above.
  {
    key: "access_service_token",
    type: "edit",
    label: "Access: Service Tokens",
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

/** The dashboard picker's word for each level. */
export const LEVEL_WORDS: Record<PermissionType, string> = {
  read: "Read",
  edit: "Edit",
  purge: "Purge",
};

/** `Label: Edit` / `Label: Read` / `Label: Purge`, the wording of the dashboard's picker. */
export function permissionName(group: PermissionGroup): string {
  const name = `${group.label}: ${LEVEL_WORDS[group.type]}`;
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
 * Why the token link cannot select a permission (one line, next to it on the
 * app's page): its group has no template key this version of Appflare
 * knows. The catalog schema lists only groups whose keys are known
 * (`APP_TOKEN_PERMISSION_GROUPS`), so this is for a manifest written for a
 * later version with a group added since.
 */
export const UNMAPPED_PERMISSION_REASON =
  "Not selected for you: Cloudflare's token link has no way to select it. Add it in the form.";

/** One entry of an app's `tokenPermissions`, with the template group that selects it. */
export interface AppTokenPermission {
  scope: TokenPermissionScope;
  /** The group's name in the dashboard's permission picker, such as "DNS". */
  groupName: string;
  access: TokenPermissionAccess;
  /** Why the app needs it, in the catalog's words. */
  reason: string;
  /**
   * The template group, `label` in the dashboard's wording ("Zone: DNS");
   * null when the group has no known template key (see
   * {@link UNMAPPED_PERMISSION_REASON}).
   */
  group: PermissionGroup | null;
}

/**
 * The group's label as the dashboard's token form shows a permission row:
 * the scope, then the group (`Zone: DNS`, `Account: D1`). The Access groups
 * carry their product in their name already (`Access: Apps and Policies`).
 */
function groupLabel(scope: TokenPermissionScope, group: string): string {
  if (group.startsWith("Access:")) return group;
  return `${scope === "zone" ? "Zone" : "Account"}: ${group}`;
}

/**
 * The app's `tokenPermissions` (with the permissions Appflare adds for a
 * Pipelines sink's token, `appTokenPermissions`), each with the template
 * group that selects it: the scope and group give the key from the schema's
 * group list, the access its level.
 */
export function resolveAppTokenPermissions(
  permissions: readonly TokenPermission[],
): AppTokenPermission[] {
  return permissions.map((p) => {
    const known = appTokenPermissionGroup(p.scope, p.group);
    return {
      scope: p.scope,
      groupName: p.group,
      access: p.access,
      reason: p.reason,
      group:
        known === null
          ? null
          : {
              key: known.templateKey,
              type: known.onlyLevel ?? p.access,
              label: groupLabel(p.scope, p.group),
            },
    };
  });
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
