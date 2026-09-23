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
 */

import type { TokenPermission } from "@appflare/schema";

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
}

/** The settings feature that puts the manager behind Cloudflare Access. */
export const ACCESS_FEATURE = "Protect with Cloudflare Access";

/** The install page feature that serves an app on a hostname in one of the account's zones. */
export const CUSTOM_DOMAINS_FEATURE = "Custom domains";

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
  // when the admin agrees.
  { key: "dns", type: "edit", label: "DNS", onlyFor: CUSTOM_DOMAINS_FEATURE },
  // What Cloudflare requires on a zone to attach a Worker to one of its hostnames.
  { key: "workers_routes", type: "edit", label: "Workers Routes", onlyFor: CUSTOM_DOMAINS_FEATURE },
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
  return `${group.label}: ${group.type === "edit" ? "Edit" : "Read"}`;
}

function encodedGroups(groups: readonly PermissionGroup[]): string {
  return encodeURIComponent(JSON.stringify(groups.map(({ key, type }) => ({ key, type }))));
}

/**
 * Account API token form (preferred): owned by the account, so it
 * keeps working when the person who created it leaves. `:account` makes the
 * dashboard ask which account when the user has several.
 */
export function accountTokenTemplateUrl(
  groups: readonly PermissionGroup[] = TOKEN_PERMISSION_GROUPS,
): string {
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${encodedGroups(groups)}&name=${encodeURIComponent(TOKEN_NAME)}`;
}

/**
 * User API token form (fallback for people who cannot create account tokens,
 * which needs Super Administrator). `accountId=*` because the manager does not know
 * its account before it has a token; the user narrows it in the form.
 */
export function userTokenTemplateUrl(
  groups: readonly PermissionGroup[] = TOKEN_PERMISSION_GROUPS,
  name: string = TOKEN_NAME,
): string {
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodedGroups(groups)}&accountId=%2A&zoneId=all&name=${encodeURIComponent(name)}`;
}

/** The dashboard's API tokens page, for permissions no template can prefill. */
export const USER_API_TOKENS_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * Permission names an app's catalog manifest may use, `<Scope>.<Group>` in the
 * dashboard's wording, mapped to template keys. Keys are from the permission
 * reference on Cloudflare's "API token template URLs" page (linked above).
 * Matching ignores case. Names not listed here are shown as text only.
 */
const APP_PERMISSION_KEYS: Readonly<Record<string, Omit<PermissionGroup, "type">>> = {
  "zone.dns": { key: "dns", label: "Zone: DNS" },
  "zone.zone": { key: "zone", label: "Zone: Zone" },
  "zone.zone settings": { key: "zone_settings", label: "Zone: Zone Settings" },
  "zone.analytics": { key: "analytics", label: "Zone: Analytics" },
  "zone.page rules": { key: "page_rules", label: "Zone: Page Rules" },
  "zone.ssl and certificates": { key: "ssl_and_certificates", label: "Zone: SSL and Certificates" },
  "account.account settings": { key: "account_settings", label: "Account: Account Settings" },
  "account.account analytics": { key: "account_analytics", label: "Account: Account Analytics" },
  "account.workers scripts": { key: "workers_scripts", label: "Account: Workers Scripts" },
  "account.workers kv storage": { key: "workers_kv_storage", label: "Account: Workers KV Storage" },
  "account.workers r2 storage": { key: "workers_r2", label: "Account: Workers R2 Storage" },
  "account.d1": { key: "d1", label: "Account: D1" },
  "account.queues": { key: "queues", label: "Account: Queues" },
};

/** One entry of an app's `tokenPermissions`, with the template group it maps to. */
export interface AppTokenPermission {
  name: string;
  description: string | null;
  scope: NonNullable<TokenPermission["scope"]> | null;
  /** Null when the name has no known template key; the user adds it by hand. */
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
 * form can narrow the token to one zone.
 */
export function appTokenTemplateUrl(
  appName: string,
  permissions: readonly AppTokenPermission[],
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
  return userTokenTemplateUrl([...groups.values()], appName);
}
