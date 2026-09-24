import {
  type CapabilityClient,
  createCapabilityClient,
  type FetchLike,
  probeAccountCapabilities,
  probeAccountSetup,
  probeDomainCapabilities,
  type RequestLog,
} from "@appflare/cf-api";
import {
  type CfClientEnv,
  CfTokenNotConfiguredError,
  getCfClient,
} from "../cloudflare/client.server";
import type { Database } from "../db/client";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import {
  type CapabilitiesView,
  capabilitiesView,
  parseStoredCapabilities,
  type StoredCapabilities,
} from "./capabilities";

/**
 * Runs the account capability probes and keeps their answer in
 * `settings.account_capabilities`: at token save (with the new token), when an
 * admin chooses "Re-check", and once a UTC day from the cron. Each run is one
 * read call per probe, seven in all: R2, Containers, the Workers plan, one zone
 * of the account, Email Routing on that zone (skipped when there is no
 * zone), the workers.dev subdomain and the Zero Trust organization (both
 * for the onboarding checklist). The plan probe reads further subscription pages, up to 4, only on
 * accounts with more than 50 subscriptions and no Workers entry on the
 * first. A probe that cannot tell for lack of permission is stored as
 * such, so the manual plan applies; one that failed outright (network, 5xx)
 * keeps the last answer it gave.
 */

export async function readCapabilitiesView(db: Database): Promise<CapabilitiesView> {
  const row = await readSettings(db, [SETTING.accountPlan, SETTING.accountCapabilities]);
  return capabilitiesView(row.account_plan, parseStoredCapabilities(row.account_capabilities));
}

/** A probe that failed outright says nothing new: the previous answer stands. */
function keepOnFailure<T extends { state: string }>(next: T, previous: T | undefined): T {
  const failed = next.state === "unknown" && (next as { reason?: string }).reason === "error";
  return failed && previous !== undefined ? previous : next;
}

/**
 * Probes with `client` and stores the answer, with the new check time. A
 * probe that failed outright keeps the previous answer, so a network error
 * never replaces a detected plan. Never throws for a Cloudflare answer.
 */
export async function refreshCapabilities(
  db: Database,
  client: CapabilityClient,
  now: Date = new Date(),
): Promise<StoredCapabilities> {
  const [probed, domains, setup] = await Promise.all([
    probeAccountCapabilities(client),
    probeDomainCapabilities(client),
    probeAccountSetup(client),
  ]);
  const row = await readSettings(db, [SETTING.accountCapabilities]);
  const previous = parseStoredCapabilities(row.account_capabilities);
  const stored: StoredCapabilities = {
    checkedAt: now.toISOString(),
    r2: keepOnFailure(probed.r2, previous?.r2),
    containers: keepOnFailure(probed.containers, previous?.containers),
    workersPlan: keepOnFailure(probed.workersPlan, previous?.workersPlan),
    zone: keepOnFailure(domains.zone, previous?.zone),
    emailRouting: keepOnFailure(domains.emailRouting, previous?.emailRouting),
    workersDev: keepOnFailure(setup.workersDev, previous?.workersDev),
    zeroTrust: keepOnFailure(setup.zeroTrust, previous?.zeroTrust),
  };
  await writeSettings(db, { [SETTING.accountCapabilities]: JSON.stringify(stored) }, now);
  return stored;
}

export interface NewTokenProbe {
  accountId: string;
  /** The token just saved; the running version may still hold the previous one. */
  token: string;
  fetch?: FetchLike;
  onRequest?: (log: RequestLog) => void;
  baseUrl?: string;
}

/**
 * After a token save or rotation: probes with the new token. Best effort: the
 * token is already stored, so a failure here is logged (message only, never
 * the token) and the next check fills the values in.
 */
export async function refreshCapabilitiesForNewToken(
  db: Database,
  probe: NewTokenProbe,
  now: Date = new Date(),
): Promise<StoredCapabilities | null> {
  try {
    return await refreshCapabilities(db, createCapabilityClient(probe), now);
  } catch (error) {
    console.error("capability check after token save failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface StoredTokenOptions {
  now?: Date;
  /** Injectable for tests; the global fetch otherwise. */
  fetch?: FetchLike;
}

/** With the manager's stored token; throws when setup has not stored one yet. */
export async function refreshCapabilitiesWithStoredToken(
  env: CfClientEnv,
  db: Database,
  opts: StoredTokenOptions = {},
): Promise<StoredCapabilities> {
  const client = await getCfClient(env, opts.fetch === undefined ? {} : { fetch: opts.fetch });
  return refreshCapabilities(db, client, opts.now);
}

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The cron's daily check: runs when the last one was on an earlier UTC day
 * (or never ran) and a token is configured. Returns whether it ran.
 */
export async function refreshCapabilitiesDaily(
  env: CfClientEnv,
  db: Database,
  opts: StoredTokenOptions = {},
): Promise<"checked" | "fresh" | "no-token"> {
  const now = opts.now ?? new Date();
  const row = await readSettings(db, [SETTING.accountCapabilities]);
  const stored = parseStoredCapabilities(row.account_capabilities);
  if (stored !== null && utcDay(stored.checkedAt) === utcDay(now.toISOString())) return "fresh";
  try {
    await refreshCapabilitiesWithStoredToken(env, db, { ...opts, now });
    return "checked";
  } catch (error) {
    if (error instanceof CfTokenNotConfiguredError) return "no-token";
    throw error;
  }
}
