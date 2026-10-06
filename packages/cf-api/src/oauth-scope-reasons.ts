/**
 * Why Appflare asks for each permission, in plain words, for the people who
 * approve it: the deploy page lists them before Cloudflare's consent page,
 * and Appflare's own settings can show the same reasons. Keyed by the same
 * permission group keys as {@link MANAGER_OAUTH_SCOPE_BY_GROUP}. Data only:
 * each reader draws it its own way.
 *
 * A reason is about apps or about a feature of Appflare itself. An app
 * reason names the catalog service (`SERVICE_IDS` in `@appflare/schema`)
 * whose apps use the permission, so a reader that has the catalog can name
 * a few of them; the names are never written here, because the catalog
 * changes and an example must be an app that really uses the permission.
 * `withApps` is the sentence with `{apps}` where those names go ("A and B");
 * `text` is the sentence without them.
 *
 * Every reason was checked against what the manager does with the
 * permission (its token permission groups list each group's calls).
 */

import type { ManagerOAuthGroupKey } from "./oauth-scopes";

export interface ScopeReason {
  /** The permission's name, as Cloudflare and Appflare show it. */
  label: string;
  /** One or two sentences, without example apps. */
  text: string;
  /** The catalog service whose apps illustrate the permission; absent for a feature of Appflare. */
  service?: string;
  /** With `service`: the sentence with `{apps}` where two or three app names go. */
  withApps?: string;
}

/** Every permission group Appflare requests; Billing has no OAuth scope, so it is never requested. */
export type RequestedGroupKey = Exclude<ManagerOAuthGroupKey, "billing">;

export const MANAGER_SCOPE_REASONS = {
  workers_scripts: {
    label: "Workers Scripts",
    text: "Workers Scripts lets Appflare install, update and remove apps, and update itself: their code, settings, secrets and schedules.",
  },
  workers_kv_storage: {
    label: "Workers KV Storage",
    service: "kv",
    text: "Workers KV Storage lets Appflare create and remove the key-value storage apps keep their data in.",
    withApps:
      "Workers KV Storage lets Appflare create and remove the key-value storage of apps like {apps}.",
  },
  d1: {
    label: "D1",
    service: "d1",
    text: "D1 lets Appflare create the databases apps keep their data in, update them with each app version, and restore them if you ask.",
    withApps:
      "D1 lets Appflare create the databases of apps like {apps}, update them with each app version, and restore them if you ask.",
  },
  workers_r2: {
    label: "Workers R2 Storage",
    service: "r2",
    text: "Workers R2 Storage lets Appflare create and remove the file storage apps keep files in.",
    withApps:
      "Workers R2 Storage lets Appflare create and remove the file storage of apps like {apps}.",
  },
  queues: {
    label: "Queues",
    service: "queues",
    text: "Queues lets Appflare create and remove the queues apps use to do work in the background.",
    withApps:
      "Queues lets Appflare create and remove the queues that apps like {apps} use to do work in the background.",
  },
  vectorize: {
    label: "Vectorize",
    service: "vectorize",
    text: "Vectorize lets Appflare create and remove the search indexes apps use to find things by meaning.",
    withApps:
      "Vectorize lets Appflare create and remove the search indexes that apps like {apps} use to find things by meaning.",
  },
  access: {
    label: "Access: Apps and Policies",
    text: "Access: Apps and Policies lets Appflare put a Cloudflare sign-in in front of Appflare itself, or in front of an app you install, when you ask for it.",
  },
  access_acct: {
    label: "Access: Organizations, Identity Providers, and Groups",
    text: "Access: Organizations, Identity Providers, and Groups lets Appflare read your Zero Trust team's details, which it needs to check the Cloudflare sign-in in front of Appflare or an app.",
  },
  access_service_token: {
    label: "Access: Service Tokens",
    text: "Access: Service Tokens lets Appflare give each app behind a Cloudflare sign-in a key of its own, so Appflare can still check that the app is working.",
  },
  zone: {
    label: "Zone",
    text: "Zone lets Appflare list the domains in your account, so you can put Appflare or an app on one of them.",
  },
  dns: {
    label: "DNS",
    text: "DNS lets Appflare check a domain's records before Appflare or an app moves onto it, and change them when you agree.",
  },
  workers_routes: {
    label: "Workers Routes",
    text: "Workers Routes lets Appflare connect one of your domains to Appflare or to an app.",
  },
  ssl_and_certificates: {
    label: "SSL and Certificates",
    text: "SSL and Certificates lets Appflare put an app on a domain whose DNS is kept outside Cloudflare, with a certificate Cloudflare issues.",
  },
  zone_settings: {
    label: "Zone Settings",
    service: "email-routing",
    text: "Zone Settings lets Appflare turn on Email Routing for a domain, so apps can receive its email.",
    withApps:
      "Zone Settings lets Appflare turn on Email Routing for a domain, so apps like {apps} can receive its email.",
  },
  email_routing_rule: {
    label: "Email Routing Rules",
    service: "email-routing",
    text: "Email Routing Rules lets Appflare send a domain's email to the apps that handle email.",
    withApps: "Email Routing Rules lets Appflare send a domain's email to apps like {apps}.",
  },
  email_routing_address: {
    label: "Email Routing Addresses",
    service: "email-routing",
    text: "Email Routing Addresses lets Appflare see the addresses you have verified, which apps can send email to.",
    withApps:
      "Email Routing Addresses lets Appflare see the addresses you have verified, which apps like {apps} can send email to.",
  },
  containers: {
    label: "Containers",
    service: "containers",
    text: "Containers lets Appflare build apps from their source code inside your account, on the Workers Paid plan.",
    withApps:
      "Containers lets Appflare build apps like {apps} from their source code inside your account, on the Workers Paid plan.",
  },
  query_cache: {
    label: "Hyperdrive",
    service: "hyperdrive",
    text: "Hyperdrive lets Appflare connect apps to a database you run outside Cloudflare.",
    withApps:
      "Hyperdrive lets Appflare connect apps like {apps} to a database you run outside Cloudflare.",
  },
  pipelines: {
    label: "Pipelines",
    service: "pipelines",
    text: "Pipelines lets Appflare set up the streams apps use to save events into file storage.",
    withApps:
      "Pipelines lets Appflare set up the streams that apps like {apps} use to save events into file storage.",
  },
  workers_r2_data_catalog: {
    label: "Workers R2 Data Catalog",
    service: "pipelines",
    text: "Workers R2 Data Catalog lets Appflare clear the records an app's event streams left in file storage, when you remove the app.",
    withApps:
      "Workers R2 Data Catalog lets Appflare clear the records that event streams of apps like {apps} leave in file storage, when you remove the app.",
  },
  account_settings: {
    label: "Account Settings",
    text: "Account Settings lets Appflare read which Cloudflare account it is in and that account's name.",
  },
  workers_tail: {
    label: "Workers Tail",
    // No version of Appflare reads live logs yet: asked for now so that a
    // later one can, without a new sign-in.
    text: "Workers Tail lets Appflare read a Worker's live logs. Appflare asks for it now so a later version can show them without asking you to sign in again.",
  },
} as const satisfies Record<RequestedGroupKey, ScopeReason>;

/**
 * Why Appflare asks for `offline_access`, the protocol scope that keeps a
 * sign-in working after its first hour.
 */
export const OFFLINE_ACCESS_REASON: ScopeReason = {
  label: "Offline access",
  text: "Offline access lets Appflare stay connected after you close this page, renewing its own access to Cloudflare.",
};

/**
 * The reason's sentence, naming `apps` when it is about apps and some are
 * given ("A", "A and B", "A, B and C"); otherwise its plain text.
 */
export function scopeReasonText(reason: ScopeReason, apps: readonly string[] = []): string {
  if (reason.withApps === undefined || apps.length === 0) return reason.text;
  const names =
    apps.length === 1
      ? (apps[0] ?? "")
      : `${apps.slice(0, -1).join(", ")} and ${apps[apps.length - 1] ?? ""}`;
  return reason.withApps.replace("{apps}", names);
}
