import { CloudflareApiError } from "./errors";
import { type ClientOptions, createHttpApi } from "./http";
import { createAccess } from "./namespaces/access";
import { createAnalyticsEngine } from "./namespaces/analytics-engine";
import { createBilling } from "./namespaces/billing";
import { createContainers } from "./namespaces/containers";
import { createEmailRouting } from "./namespaces/email-routing";
import { createR2 } from "./namespaces/r2";
import { createWorkers } from "./namespaces/workers";
import { createZones } from "./namespaces/zones";
import type { AccountSubscription } from "./types";

/**
 * What an account can do, read with a token: whether R2 is enabled, whether
 * Containers can be used, which Workers plan the account is on, whether the
 * token can see a zone (a domain on Cloudflare), whether it can read that
 * zone's Email Routing, and whether Analytics Engine is on. Each probe is one
 * read call and never changes anything. Shared by the manager (with its stored token) and the CLI (with
 * wrangler's credential), so both read the answers the same way.
 *
 * Also a separate entry (`@appflare/cf-api/capabilities`) that pulls in only
 * the HTTP layer and the namespaces the probes use.
 *
 * Answers recorded live (2026-09-24) against a Workers Free and a Workers Paid
 * account:
 * - `GET /r2/buckets?per_page=1` is 200 on an account with R2 enabled.
 *   Without R2, Cloudflare answers code 10042, "Please enable R2 through the
 *   Cloudflare Dashboard." (the error wrangler users report,
 *   cloudflare/workers-sdk#2877). A token without an R2 permission gets 403
 *   code 10000.
 * - `GET /containers/applications?name=` is 200 on Workers Paid. On Workers
 *   Free it is 401, code 1000, with the message "Unauthorized: You do not have
 *   access to Cloudflare Containers. Deploying containers requires the Workers
 *   Paid plan. …". A token without a Containers permission gets 403 code 10000
 *   on either plan: the permission is checked before the plan.
 * - `GET /subscriptions` lists `workers_paid` (product `prod_workers`) on
 *   Workers Paid and no Workers entry on Workers Free. A token without
 *   "Billing: Read" gets 403 code 10000. `per_page` above 50 is refused.
 * - `GET /zones?account.id=…&status=active&per_page=1` is 200 with one zone
 *   when the token can read an active one; the same call narrowed to a name
 *   the account does not have
 *   is 200 with an empty list (`total_count` 0). An account id the token does
 *   not belong to is 400 code 70503, "account with given Tag doesn't exist".
 *   Cloudflare's API schema files the list under "Zone Read" and it lists
 *   only zones the token may read, so an empty list also covers a token
 *   without that permission.
 * - `GET /zones/{zone_id}/email/routing` is 200 with `enabled` and `status`
 *   (`ready` on a zone with routing on). The API schema files it under "Zone
 *   Settings Read" (or Write). A zone the token may not read answers 403 code
 *   10000, "Authentication error".
 * - `GET /workers/subdomain` is 200 with `subdomain` on both accounts. An
 *   account with no workers.dev subdomain registered answers code 10007, and
 *   a token without a Workers permission code 10000: wrangler 4.136.2 reads
 *   the same two codes (`getWorkersDevSubdomain`, before it offers to
 *   register one). An account the token does not belong to is 403 code 10000.
 * - `GET /access/organizations` is 200 with `auth_domain` on both accounts
 *   (each has a Zero Trust organization). Without one Cloudflare answers 404
 *   (the manager's Access setting reads it the same way); a token without
 *   "Access: Organizations, Identity Providers, and Groups" is refused with a
 *   401 or 403.
 *
 * Recorded live (2026-09-26), Analytics Engine, with two tokens holding the
 * same permission groups (neither has "Account Analytics"):
 * - `POST /analytics_engine/sql` with the body `SHOW TABLES` is 200 with the
 *   SQL service's own JSON (`meta`, `data`, `rows`; no envelope) on an
 *   account with Analytics Engine on.
 * - On an account where it was never turned on, the same call is 403 with a
 *   plain-text body, "Authorization error": the SQL service's refusal, not
 *   the API gateway's JSON one. A token the gateway rejects gets JSON code
 *   10000 instead (401 "Authentication error" for an invalid token), so a
 *   Cloudflare error code in the answer means the token, not the account.
 * - Deploying a Worker with an `analytics_engine` binding to such an account
 *   fails with code 10089, `workers.api.error.no_access_to_analytics_engine`
 *   (cloudflare/workers-sdk#5940); the fix is the dashboard's Analytics
 *   Engine page, once per account.
 */

/** Why a probe could not tell. */
export type CapabilityUnknownReason =
  /** The token lacks the permission the probe's call needs (401/403 without a plan answer). */
  | "no-permission"
  /** The answer was not one the probe recognises (an Enterprise contract, for example). */
  | "unrecognised"
  /** Network failure, 5xx, or any other error. */
  | "error";

export interface CapabilityUnknown {
  state: "unknown";
  reason: CapabilityUnknownReason;
  /** Method, path, status and Cloudflare's own error text; never a token. */
  detail: string;
}

export type R2Capability = { state: "enabled" } | { state: "not-enabled" } | CapabilityUnknown;

export type ContainersCapability =
  | { state: "available" }
  | { state: "needs-workers-paid" }
  | CapabilityUnknown;

export type WorkersPlanCapability = { state: "paid" } | { state: "free" } | CapabilityUnknown;

/**
 * Whether Workers Analytics Engine is turned on for the account. It is off
 * until someone opens its page in the dashboard once, and until then every
 * deploy of a Worker that binds a dataset is refused.
 */
export type AnalyticsEngineCapability =
  | { state: "enabled" }
  | { state: "not-enabled" }
  | CapabilityUnknown;

export interface AccountCapabilities {
  r2: R2Capability;
  containers: ContainersCapability;
  workersPlan: WorkersPlanCapability;
}

/**
 * Whether the token can see an active zone of the account (custom domains
 * and Email Routing need one; a pending zone does not serve traffic yet).
 * `none` is an empty list: no active zone in the account, or the token lacks
 * Zone: Read (Cloudflare answers both the same way).
 */
export type ZoneCapability = { state: "available" } | { state: "none" } | CapabilityUnknown;

/**
 * Whether the token can read Email Routing on an active zone of the account (the
 * first one the zone list names); `no-zone` when the list is empty. Routing
 * need not be on yet: an install turns it on itself.
 */
export type EmailRoutingCapability =
  | { state: "available" }
  | { state: "no-zone" }
  | CapabilityUnknown;

/**
 * The account's workers.dev subdomain (`<subdomain>.workers.dev`): every app
 * answers on `<app>.<subdomain>.workers.dev` unless it is given a domain, so
 * an account needs one registered.
 */
export type WorkersDevCapability =
  | { state: "registered"; subdomain: string }
  | { state: "not-registered" }
  | CapabilityUnknown;

/**
 * Whether the account has a Zero Trust organization, which Cloudflare Access
 * (a sign-in in front of Appflare or an app) needs first.
 */
export type ZeroTrustCapability =
  | { state: "exists"; teamDomain: string }
  | { state: "none" }
  | CapabilityUnknown;

/**
 * Whether the token can read Access service tokens ("Access: Service
 * Tokens"), which protecting installed apps with Cloudflare Access needs
 * (each app gets one its health checks sign in with). A listing proves Read
 * only (`readable`), not Edit; a refusal (`no-permission`) proves the token
 * has neither, which is what the probe is for.
 */
export type AccessServiceTokensCapability = { state: "readable" } | CapabilityUnknown;

/**
 * The account-wide setup read besides the capabilities: workers.dev, Zero
 * Trust, Analytics Engine, Access service tokens.
 */
export interface AccountSetupCapabilities {
  workersDev: WorkersDevCapability;
  zeroTrust: ZeroTrustCapability;
  analyticsEngine: AnalyticsEngineCapability;
  accessServiceTokens: AccessServiceTokensCapability;
}

/** What the token can do with the account's domains. */
export interface DomainCapabilities {
  zone: ZoneCapability;
  emailRouting: EmailRoutingCapability;
}

/** Cloudflare's code for "no workers.dev subdomain registered" on `GET /workers/subdomain`. */
export const WORKERS_DEV_NOT_REGISTERED_CODE = 10007;

/** Cloudflare's code for "Please enable R2 through the Cloudflare Dashboard." */
export const R2_NOT_ENABLED_CODE = 10042;

/**
 * Cloudflare's code for a Worker upload that binds an Analytics Engine
 * dataset on an account where Analytics Engine is off
 * (`workers.api.error.no_access_to_analytics_engine`).
 */
export const ANALYTICS_ENGINE_NOT_ENABLED_CODE = 10089;

/** The statement the Analytics Engine probe runs: lists datasets, changes nothing. */
export const ANALYTICS_ENGINE_PROBE_QUERY = "SHOW TABLES";

/** The container application name the Containers probe filters on (it need not exist). */
export const CONTAINERS_PROBE_NAME = "appflare-sandbox-standard-1";

/**
 * Most subscription pages the plan probe reads. Nearly every account fits on
 * the first (50 entries: one per product plus one per zone); the Workers
 * entry ends the search as soon as it is found.
 */
export const SUBSCRIPTION_PAGES_MAX = 4;

/** Subscription states in which the plan is in force. */
const ACTIVE_STATES = new Set(["paid", "trial", "provisioned", "awaitingpayment"]);

/** The namespaces the probes use; `createClient`'s client has them too. */
export interface CapabilityClient {
  r2: Pick<ReturnType<typeof createR2>, "listBucketsPage">;
  containers: Pick<ReturnType<typeof createContainers>, "listApplications">;
  billing: Pick<ReturnType<typeof createBilling>, "listSubscriptionsPage">;
  zones: Pick<ReturnType<typeof createZones>, "listAccountZonesPage">;
  emailRouting: Pick<ReturnType<typeof createEmailRouting>, "getSettings">;
  workers: Pick<ReturnType<typeof createWorkers>, "getAccountSubdomain">;
  access: Pick<ReturnType<typeof createAccess>, "getOrganization" | "listServiceTokens">;
  analyticsEngine: Pick<ReturnType<typeof createAnalyticsEngine>, "sql">;
}

/** A client with only what the probes need, for callers that do not need the full one. */
export function createCapabilityClient(options: ClientOptions): CapabilityClient {
  const http = createHttpApi(options);
  return {
    r2: createR2(http),
    containers: createContainers(http),
    billing: createBilling(http),
    zones: createZones(http),
    emailRouting: createEmailRouting(http),
    workers: createWorkers(http),
    access: createAccess(http),
    analyticsEngine: createAnalyticsEngine(http),
  };
}

/**
 * What went wrong, from the HTTP status and Cloudflare's error codes only:
 * error messages carry request paths, and those carry the account id.
 */
export function failureDetail(error: unknown): string {
  if (error instanceof CloudflareApiError) {
    const codes = [...new Set(error.errors.map((e) => e.code))];
    return codes.length === 0
      ? `HTTP ${error.status}`
      : `HTTP ${error.status}, Cloudflare code ${codes.join(", ")}`;
  }
  return `no usable answer (${error instanceof Error ? error.name : typeof error})`;
}

/** `why` is a fixed sentence, or the error the probe caught. */
function unknown(reason: CapabilityUnknownReason, why: unknown): CapabilityUnknown {
  return { state: "unknown", reason, detail: typeof why === "string" ? why : failureDetail(why) };
}

/** A 401 or 403, the way Cloudflare refuses a token a permission. */
function isRefusal(error: unknown): error is CloudflareApiError {
  return error instanceof CloudflareApiError && (error.status === 401 || error.status === 403);
}

function hasCode(error: CloudflareApiError, code: number): boolean {
  return error.errors.some((e) => e.code === code);
}

/** R2: one bucket from the list. */
export async function probeR2(client: CapabilityClient): Promise<R2Capability> {
  try {
    await client.r2.listBucketsPage({ perPage: 1 });
    return { state: "enabled" };
  } catch (error) {
    if (error instanceof CloudflareApiError && hasCode(error, R2_NOT_ENABLED_CODE)) {
      return { state: "not-enabled" };
    }
    return unknown(isRefusal(error) ? "no-permission" : "error", error);
  }
}

/**
 * Containers: the container application list, filtered to one name, the same
 * read wrangler's deploy makes first. Cloudflare's plan refusal names Workers
 * Paid in its message; any other refusal is the token's permissions.
 */
export async function probeContainers(
  client: CapabilityClient,
  name: string = CONTAINERS_PROBE_NAME,
): Promise<ContainersCapability> {
  try {
    await client.containers.listApplications({ name });
    return { state: "available" };
  } catch (error) {
    if (isRefusal(error)) {
      return error.errors.some((e) => /workers paid/i.test(e.message))
        ? { state: "needs-workers-paid" }
        : unknown("no-permission", error);
    }
    return unknown("error", error);
  }
}

/** Whether one subscription is a Workers plan above Free, in force. */
function isWorkersPaid(sub: AccountSubscription): boolean {
  const plan = sub.rate_plan?.id ?? "";
  const workers = /^workers_/.test(plan) || sub.product?.name === "prod_workers";
  if (!workers || plan === "workers_free") return false;
  return sub.state === undefined || ACTIVE_STATES.has(sub.state.toLowerCase());
}

/** A contract or externally managed plan, where Workers may be included without its own entry. */
function isContract(sub: AccountSubscription): boolean {
  return sub.rate_plan?.is_contract === true || sub.rate_plan?.externally_managed === true;
}

/**
 * The Workers plan from the account's subscriptions (needs "Billing: Read").
 * An entry for Workers Paid means paid; none means free, unless the account
 * has a contract plan, where Workers may be part of the contract without an
 * entry of its own, so the probe cannot tell.
 */
export async function probeWorkersPlan(client: CapabilityClient): Promise<WorkersPlanCapability> {
  try {
    let contract = false;
    for (let page = 1; page <= SUBSCRIPTION_PAGES_MAX; page++) {
      const { items, totalPages } = await client.billing.listSubscriptionsPage({ page });
      if (items.some(isWorkersPaid)) return { state: "paid" };
      contract ||= items.some(isContract);
      if (page >= totalPages || items.length === 0) {
        return contract
          ? unknown("unrecognised", "the account has a contract plan without a Workers entry")
          : { state: "free" };
      }
    }
    return unknown(
      "unrecognised",
      `no Workers entry in the first ${SUBSCRIPTION_PAGES_MAX} pages of subscriptions`,
    );
  } catch (error) {
    return unknown(isRefusal(error) ? "no-permission" : "error", error);
  }
}

/**
 * The account-level probes (R2, Containers, Workers plan), concurrently.
 * Never throws. The domain probes are separate
 * ({@link probeDomainCapabilities}): sandbox builds need none of them.
 */
export async function probeAccountCapabilities(
  client: CapabilityClient,
): Promise<AccountCapabilities> {
  const [r2, containers, workersPlan] = await Promise.all([
    probeR2(client),
    probeContainers(client),
    probeWorkersPlan(client),
  ]);
  return { r2, containers, workersPlan };
}

/**
 * Email Routing on one zone: its settings, read only. A refusal is the
 * token's permissions (Zone Settings: Read); whether routing is on does not
 * matter, since an install turns it on.
 */
export async function probeEmailRouting(
  client: Pick<CapabilityClient, "emailRouting">,
  zoneId: string,
): Promise<EmailRoutingCapability> {
  try {
    await client.emailRouting.getSettings(zoneId);
    return { state: "available" };
  } catch (error) {
    return unknown(isRefusal(error) ? "no-permission" : "error", error);
  }
}

/**
 * The domain probes: one active zone from the account's zone list, then Email
 * Routing on that zone. Two read calls at most, one when the list is empty
 * or cannot be read. Never throws.
 */
export async function probeDomainCapabilities(
  client: Pick<CapabilityClient, "zones" | "emailRouting">,
): Promise<DomainCapabilities> {
  let first: string | undefined;
  try {
    const { items } = await client.zones.listAccountZonesPage({ status: "active", perPage: 1 });
    first = items[0]?.id;
  } catch (error) {
    const zone = unknown(isRefusal(error) ? "no-permission" : "error", error);
    return { zone, emailRouting: unknown(zone.reason, `no zone could be listed: ${zone.detail}`) };
  }
  if (first === undefined) return { zone: { state: "none" }, emailRouting: { state: "no-zone" } };
  return { zone: { state: "available" }, emailRouting: await probeEmailRouting(client, first) };
}

/**
 * The account's workers.dev subdomain. Code 10007 is Cloudflare's "none
 * registered"; any other refusal is the token's permissions.
 */
export async function probeWorkersDev(
  client: Pick<CapabilityClient, "workers">,
): Promise<WorkersDevCapability> {
  try {
    const { subdomain } = await client.workers.getAccountSubdomain();
    return typeof subdomain === "string" && subdomain.length > 0
      ? { state: "registered", subdomain }
      : { state: "not-registered" };
  } catch (error) {
    if (error instanceof CloudflareApiError && hasCode(error, WORKERS_DEV_NOT_REGISTERED_CODE)) {
      return { state: "not-registered" };
    }
    return unknown(isRefusal(error) ? "no-permission" : "error", error);
  }
}

/**
 * The account's Zero Trust organization. A 404 is "none yet"; a 401 or 403
 * is the token's permissions.
 */
export async function probeZeroTrust(
  client: Pick<CapabilityClient, "access">,
): Promise<ZeroTrustCapability> {
  try {
    const org = await client.access.getOrganization();
    const teamDomain = typeof org?.auth_domain === "string" ? org.auth_domain : "";
    return teamDomain.length > 0 ? { state: "exists", teamDomain } : { state: "none" };
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return { state: "none" };
    return unknown(isRefusal(error) ? "no-permission" : "error", error);
  }
}

/**
 * Access service tokens: the list (never a secret). An answer means the
 * token may read them (not necessarily create them); a 401 or 403 means it
 * lacks the group.
 */
export async function probeAccessServiceTokens(
  client: Pick<CapabilityClient, "access">,
): Promise<AccessServiceTokensCapability> {
  try {
    await client.access.listServiceTokens();
    return { state: "readable" };
  } catch (error) {
    return unknown(isRefusal(error) ? "no-permission" : "error", error);
  }
}

/**
 * Whether the SQL service itself refused the query: a 403 whose body was not
 * the API's JSON envelope, so it carries no Cloudflare error code. The
 * gateway's refusals of a token always carry one (10000).
 */
function isSqlServiceRefusal(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    error.status === 403 &&
    error.errors.every((e) => e.code === 0)
  );
}

/**
 * Analytics Engine: `SHOW TABLES` through the SQL API, which reads the
 * account's dataset names and changes nothing. An answer means it is on; the
 * SQL service's plain-text 403 means it was never turned on; a refusal with a
 * Cloudflare error code is the token's permissions.
 */
export async function probeAnalyticsEngine(
  client: Pick<CapabilityClient, "analyticsEngine">,
): Promise<AnalyticsEngineCapability> {
  try {
    await client.analyticsEngine.sql(ANALYTICS_ENGINE_PROBE_QUERY);
    return { state: "enabled" };
  } catch (error) {
    if (isSqlServiceRefusal(error)) return { state: "not-enabled" };
    return unknown(isRefusal(error) ? "no-permission" : "error", error);
  }
}

/**
 * The workers.dev, Zero Trust, Analytics Engine and Access service token
 * probes, concurrently; one read call each. Never throws.
 */
export async function probeAccountSetup(
  client: Pick<CapabilityClient, "workers" | "access" | "analyticsEngine">,
): Promise<AccountSetupCapabilities> {
  const [workersDev, zeroTrust, analyticsEngine, accessServiceTokens] = await Promise.all([
    probeWorkersDev(client),
    probeZeroTrust(client),
    probeAnalyticsEngine(client),
    probeAccessServiceTokens(client),
  ]);
  return { workersDev, zeroTrust, analyticsEngine, accessServiceTokens };
}

/**
 * The Workers plan the probes show, or null when they cannot tell. Containers
 * answering proves Workers Paid (no other plan has them), so it wins over a
 * subscription list without a Workers entry. Then the subscriptions, then
 * Containers refused with a Workers Paid message.
 */
export function detectedWorkersPlan(
  capabilities: Pick<AccountCapabilities, "containers" | "workersPlan">,
): "free" | "paid" | null {
  const { workersPlan, containers } = capabilities;
  if (containers.state === "available") return "paid";
  if (workersPlan.state === "paid" || workersPlan.state === "free") return workersPlan.state;
  if (containers.state === "needs-workers-paid") return "free";
  return null;
}
