/**
 * The Cloudflare API token Appflare asks for in the setup wizard, as a dashboard
 * template link. Client-safe: no server imports.
 *
 * URL format and permission keys: Cloudflare's "API token template URLs" page,
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
 * (`permissionGroupKeys` = URL-encoded JSON array of `{ key, type }`). That page's
 * key table omits `vectorize` and `workers_tail`; both are the keys the dashboard
 * itself uses for those groups (seen in public template links using them).
 */

export type PermissionType = "read" | "edit";

export interface PermissionGroup {
  /** Dashboard template key. */
  key: string;
  type: PermissionType;
  /** The group's name in the dashboard's permission picker. */
  label: string;
}

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
  // The optional Cloudflare Access toggle for the manager.
  { key: "access", type: "edit", label: "Access: Apps and Policies" },
  // Find the account id and name the token belongs to (`GET /accounts`).
  { key: "account_settings", type: "read", label: "Account Settings" },
  // Stream a Worker's live logs while diagnosing an install or update.
  { key: "workers_tail", type: "read", label: "Workers Tail" },
] as const satisfies readonly PermissionGroup[];

/** The token name the dashboard form is prefilled with. */
export const TOKEN_NAME = "Appflare";

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
): string {
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodedGroups(groups)}&accountId=%2A&zoneId=all&name=${encodeURIComponent(TOKEN_NAME)}`;
}
