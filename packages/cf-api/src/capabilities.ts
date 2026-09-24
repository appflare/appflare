import { CloudflareApiError } from "./errors";
import { type ClientOptions, createHttpApi } from "./http";
import { createBilling } from "./namespaces/billing";
import { createContainers } from "./namespaces/containers";
import { createEmailRouting } from "./namespaces/email-routing";
import { createR2 } from "./namespaces/r2";
import { createZones } from "./namespaces/zones";
import type { AccountSubscription } from "./types";

/**
 * What an account can do, read with a token: whether R2 is enabled, whether
 * Containers can be used, which Workers plan the account is on, whether the
 * token can see a zone (a domain on Cloudflare), and whether it can read that
 * zone's Email Routing. Each probe is one read call and never changes
 * anything. Shared by the manager (with its stored token) and the CLI (with
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

/** What the token can do with the account's domains. */
export interface DomainCapabilities {
  zone: ZoneCapability;
  emailRouting: EmailRoutingCapability;
}

/** Cloudflare's code for "Please enable R2 through the Cloudflare Dashboard." */
export const R2_NOT_ENABLED_CODE = 10042;

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
