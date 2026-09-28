import { z } from "zod";
import type { ServiceId } from "./services";

/**
 * The permissions an app needs on the Cloudflare API token the admin creates
 * for it (the catalog manifest's `tokenPermissions`), never the manager's own.
 * Each names one Cloudflare permission group from a fixed list, its scope
 * (account or zone), the access level, and why the app needs it. The manager
 * prefills the dashboard's token form from the list, so a group is only on
 * the list when its template key is known.
 *
 * Template keys: Cloudflare's "API token template URLs" page
 * (developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)
 * for `dns`, `zone`, `zone_settings`, `analytics`, `firewall_services`,
 * `page_rules`, `ssl_and_certificates`, `account_settings`,
 * `account_analytics`, `billing`, `workers_scripts`, `workers_kv_storage`,
 * `workers_routes`, `workers_r2`, `d1`, `queues`, `logs`, `access`,
 * `access_acct`; the dashboard's own group labels (`<key>_read` /
 * `<key>_write`) for `email_routing_rule`, `email_routing_address`,
 * `query_cache` (Hyperdrive), `pipelines`, `vectorize`, `workers_tail`,
 * `load_balancers`, `account_logs`, `magic_transit`; public template links
 * for `email_sending`, `secrets_store`, `r2_catalog`, `r2_catalog_sql` and
 * `containers`.
 *
 * This module imports nothing at run time but zod: `catalog.ts` imports it,
 * and the JSON Schema export runs `catalog.ts` directly under Node's type
 * stripping.
 */

/** Where a permission group applies: the whole account, or the zones the token covers. */
export const TOKEN_PERMISSION_SCOPES = ["account", "zone"] as const;
export type TokenPermissionScope = (typeof TOKEN_PERMISSION_SCOPES)[number];

/** The access level of a permission: read only, or read and edit. */
export const TOKEN_PERMISSION_ACCESS = ["read", "edit"] as const;
export type TokenPermissionAccess = (typeof TOKEN_PERMISSION_ACCESS)[number];

/** One permission group an app's token may ask for. */
export interface AppTokenPermissionGroup {
  scope: TokenPermissionScope;
  /** The group's name in the dashboard's permission picker. */
  group: string;
  /** The dashboard template key that selects the group. */
  templateKey: string;
  /** The Cloudflare service the group reaches, when it is one the catalog lists. */
  service?: ServiceId;
}

/** Every permission group an app's token may ask for, by scope, in the dashboard's wording. */
export const APP_TOKEN_PERMISSION_GROUPS = [
  { scope: "zone", group: "DNS", templateKey: "dns", service: "zone" },
  { scope: "zone", group: "Zone", templateKey: "zone", service: "zone" },
  { scope: "zone", group: "Zone Settings", templateKey: "zone_settings", service: "zone" },
  { scope: "zone", group: "Analytics", templateKey: "analytics", service: "zone" },
  { scope: "zone", group: "Page Rules", templateKey: "page_rules", service: "zone" },
  {
    scope: "zone",
    group: "SSL and Certificates",
    templateKey: "ssl_and_certificates",
    service: "zone",
  },
  { scope: "zone", group: "Firewall Services", templateKey: "firewall_services", service: "zone" },
  { scope: "zone", group: "Load Balancers", templateKey: "load_balancers", service: "zone" },
  { scope: "zone", group: "Logs", templateKey: "logs", service: "zone" },
  { scope: "zone", group: "Workers Routes", templateKey: "workers_routes", service: "zone" },
  {
    scope: "zone",
    group: "Email Routing Rules",
    templateKey: "email_routing_rule",
    service: "email-routing",
  },
  { scope: "account", group: "Account Settings", templateKey: "account_settings" },
  { scope: "account", group: "Account Analytics", templateKey: "account_analytics" },
  { scope: "account", group: "Billing", templateKey: "billing" },
  { scope: "account", group: "Logs", templateKey: "account_logs" },
  { scope: "account", group: "Magic Transit", templateKey: "magic_transit" },
  { scope: "account", group: "Workers Scripts", templateKey: "workers_scripts" },
  {
    scope: "account",
    group: "Workers KV Storage",
    templateKey: "workers_kv_storage",
    service: "kv",
  },
  { scope: "account", group: "Workers R2 Storage", templateKey: "workers_r2", service: "r2" },
  { scope: "account", group: "Workers R2 Data Catalog", templateKey: "r2_catalog", service: "r2" },
  { scope: "account", group: "Workers R2 SQL", templateKey: "r2_catalog_sql", service: "r2" },
  { scope: "account", group: "Workers Tail", templateKey: "workers_tail" },
  {
    scope: "account",
    group: "Workers Containers",
    templateKey: "containers",
    service: "containers",
  },
  { scope: "account", group: "D1", templateKey: "d1", service: "d1" },
  { scope: "account", group: "Queues", templateKey: "queues", service: "queues" },
  { scope: "account", group: "Vectorize", templateKey: "vectorize", service: "vectorize" },
  { scope: "account", group: "Hyperdrive", templateKey: "query_cache", service: "hyperdrive" },
  { scope: "account", group: "Pipelines", templateKey: "pipelines", service: "pipelines" },
  { scope: "account", group: "Secrets Store", templateKey: "secrets_store" },
  { scope: "account", group: "Email Sending", templateKey: "email_sending" },
  {
    scope: "account",
    group: "Email Routing Addresses",
    templateKey: "email_routing_address",
    service: "email-routing",
  },
  {
    scope: "account",
    group: "Access: Apps and Policies",
    templateKey: "access",
    service: "access",
  },
  {
    scope: "account",
    group: "Access: Organizations, Identity Providers, and Groups",
    templateKey: "access_acct",
    service: "access",
  },
] as const satisfies readonly AppTokenPermissionGroup[];

type GroupEntry = (typeof APP_TOKEN_PERMISSION_GROUPS)[number];
export type TokenPermissionGroupName = GroupEntry["group"];

/** The group names of one scope, in the list's order. */
export function tokenPermissionGroupNames(scope: TokenPermissionScope): string[] {
  return APP_TOKEN_PERMISSION_GROUPS.filter((g) => g.scope === scope).map((g) => g.group);
}

const GROUP_NAMES = [...new Set(APP_TOKEN_PERMISSION_GROUPS.map((g) => g.group))] as [
  TokenPermissionGroupName,
  ...TokenPermissionGroupName[],
];

/** The list entry of a scope and group, or null when the scope has no such group. */
export function appTokenPermissionGroup(
  scope: string,
  group: string,
): AppTokenPermissionGroup | null {
  return APP_TOKEN_PERMISSION_GROUPS.find((g) => g.scope === scope && g.group === group) ?? null;
}

/** The longest `reason`. */
export const MAX_TOKEN_PERMISSION_REASON_LENGTH = 300;

/** One permission the app's own Cloudflare API token needs. */
export const tokenPermissionSchema = z
  .object({
    group: z
      .enum(GROUP_NAMES, {
        error: (issue) =>
          `${JSON.stringify(issue.input)} is not a permission group Appflare can select in a token link; ` +
          'use the name the dashboard\'s token form shows, such as "DNS" or "Workers Scripts"',
      })
      .describe(
        "The permission group, as the Cloudflare dashboard's token form names it, for example " +
          '`"DNS"` or `"Workers Scripts"`. Zone groups: ' +
          tokenPermissionGroupNames("zone").join(", ") +
          ". Account groups: " +
          tokenPermissionGroupNames("account").join(", ") +
          ".",
      ),
    scope: z
      .enum(TOKEN_PERMISSION_SCOPES)
      .describe('`"account"` or `"zone"`: where the group applies, as the token form groups it.'),
    access: z
      .enum(TOKEN_PERMISSION_ACCESS)
      .describe('`"read"` or `"edit"`: the access level the app needs.'),
    reason: z
      .string()
      .trim()
      .min(1)
      .max(MAX_TOKEN_PERMISSION_REASON_LENGTH)
      .describe(
        "Why the app needs the permission, in one plain sentence shown next to it, for example " +
          '"Lists your zones." Say "Optional:" first when the app works without it.',
      ),
  })
  .superRefine((permission, ctx) => {
    if (appTokenPermissionGroup(permission.scope, permission.group) === null) {
      ctx.addIssue({
        code: "custom",
        path: ["group"],
        message: `"${permission.group}" is not a ${permission.scope} permission group; ${permission.scope} groups are ${tokenPermissionGroupNames(permission.scope).join(", ")}`,
      });
    }
  })
  // The refinement does not reach the JSON Schema; `anyOf` states the pairs there.
  .meta({
    description:
      "A permission the app's own Cloudflare API token needs (never Appflare's). The manager " +
      "links to the dashboard's token form with these prefilled.",
    anyOf: TOKEN_PERMISSION_SCOPES.map((scope) => ({
      properties: {
        scope: { const: scope },
        group: { enum: tokenPermissionGroupNames(scope) },
      },
    })),
  });
export type TokenPermission = z.infer<typeof tokenPermissionSchema>;

/** `tokenPermissions`: each scope and group once. */
export const tokenPermissionsSchema = z.array(tokenPermissionSchema).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((p, i) => {
    const key = `${p.scope}\n${p.group}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: [i, "group"],
        message: `the ${p.scope} group "${p.group}" is listed twice; list it once with the access the app needs`,
      });
    }
    seen.add(key);
  });
});

/** How the dashboard's token form words a permission: `Zone: DNS: Edit`. */
export function tokenPermissionName(
  p: Pick<TokenPermission, "scope" | "group" | "access">,
): string {
  const scope = p.scope === "zone" ? "Zone" : "Account";
  return `${scope}: ${p.group}: ${p.access === "edit" ? "Edit" : "Read"}`;
}

/**
 * `permissions` with each scope and group once, keeping the stronger access
 * (edit covers read) and the first reason, in first-seen order.
 */
export function mergeTokenPermissions<T extends TokenPermission>(permissions: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const p of permissions) {
    const key = `${p.scope}\n${p.group}`;
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, p);
    else if (seen.access === "read" && p.access === "edit")
      byKey.set(key, { ...seen, access: "edit" });
  }
  return [...byKey.values()];
}
