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
  type CapabilitiesStaleness,
  type CapabilitiesView,
  capabilitiesStaleness,
  capabilitiesView,
  parseStoredCapabilities,
  type StoredCapabilities,
} from "./capabilities";

/**
 * Runs the account capability probes and keeps their answer in
 * `settings.account_capabilities`, with the Appflare version that ran them:
 * at token save (with the new token), when an admin chooses "Check again",
 * on the first request a new version serves when the answer is an older
 * version's (an update that added a probe, an Access permission say, must
 * not leave it unknown until the next day), and from the cron once a UTC
 * day or whenever the stored answer is stale that way. Each run is one
 * read call per probe, nine in all: R2, Containers, the Workers plan, one zone
 * of the account, Email Routing on that zone (skipped when there is no
 * zone), the workers.dev subdomain, the Zero
 * Trust organization, an Analytics Engine `SHOW TABLES` and the Access
 * service token list. The plan probe reads further subscription pages, up to 4, only on
 * accounts with more than 50 subscriptions and no Workers entry on the
 * first. A probe that cannot tell for lack of permission is stored as
 * such, so the manual plan applies; one that failed outright (network, 5xx)
 * keeps the last answer it gave.
 */

export async function readCapabilitiesView(db: Database): Promise<CapabilitiesView> {
  const row = await readSettings(db, [
    SETTING.accountPlan,
    SETTING.accountCapabilities,
    SETTING.accountId,
  ]);
  return capabilitiesView(
    row.account_plan,
    parseStoredCapabilities(row.account_capabilities),
    row.account_id,
  );
}

/** A probe that failed outright says nothing new: the previous answer stands. */
function keepOnFailure<T extends { state: string }>(next: T, previous: T | undefined): T {
  const failed = next.state === "unknown" && (next as { reason?: string }).reason === "error";
  return failed && previous !== undefined ? previous : next;
}

export interface RefreshOptions {
  now?: Date;
  /** The running Appflare version (`runningVersion`), stored with the answer. */
  version?: string;
}

/**
 * Probes with `client` and stores the answer, with the new check time. A
 * probe that failed outright keeps the previous answer, so a network error
 * never replaces a detected plan. Never throws for a Cloudflare answer.
 */
export async function refreshCapabilities(
  db: Database,
  client: CapabilityClient,
  opts: RefreshOptions = {},
): Promise<StoredCapabilities> {
  const now = opts.now ?? new Date();
  const [probed, domains, setup] = await Promise.all([
    probeAccountCapabilities(client),
    probeDomainCapabilities(client),
    probeAccountSetup(client),
  ]);
  const row = await readSettings(db, [SETTING.accountCapabilities]);
  const previous = parseStoredCapabilities(row.account_capabilities);
  const stored: StoredCapabilities = {
    checkedAt: now.toISOString(),
    ...(opts.version === undefined ? {} : { version: opts.version }),
    r2: keepOnFailure(probed.r2, previous?.r2),
    containers: keepOnFailure(probed.containers, previous?.containers),
    workersPlan: keepOnFailure(probed.workersPlan, previous?.workersPlan),
    zone: keepOnFailure(domains.zone, previous?.zone),
    emailRouting: keepOnFailure(domains.emailRouting, previous?.emailRouting),
    workersDev: keepOnFailure(setup.workersDev, previous?.workersDev),
    zeroTrust: keepOnFailure(setup.zeroTrust, previous?.zeroTrust),
    analyticsEngine: keepOnFailure(setup.analyticsEngine, previous?.analyticsEngine),
    accessServiceTokens: keepOnFailure(setup.accessServiceTokens, previous?.accessServiceTokens),
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
  /** The running Appflare version, stored with the answer. */
  version?: string;
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
    return await refreshCapabilities(db, createCapabilityClient(probe), {
      now,
      ...(probe.version === undefined ? {} : { version: probe.version }),
    });
  } catch (error) {
    console.error("capability check after token save failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export interface StoredTokenOptions extends RefreshOptions {
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
  return refreshCapabilities(db, client, opts);
}

/**
 * Probes again with the stored token when the stored answer is stale in one
 * of the `stale` ways (`capabilitiesStaleness`); every way unless given, as
 * the cron asks: never run, run on an earlier UTC day, by an older version,
 * or without a probe this version runs. Returns whether it ran: "fresh"
 * when the answer holds, "no-token" before setup stored a token.
 */
export async function refreshCapabilitiesIfStale(
  env: CfClientEnv,
  db: Database,
  opts: StoredTokenOptions & { stale?: readonly CapabilitiesStaleness[] } = {},
): Promise<"checked" | "fresh" | "no-token"> {
  const now = opts.now ?? new Date();
  const row = await readSettings(db, [SETTING.accountCapabilities]);
  const staleness = capabilitiesStaleness(parseStoredCapabilities(row.account_capabilities), {
    now,
    ...(opts.version === undefined ? {} : { version: opts.version }),
  });
  if (staleness === null || (opts.stale !== undefined && !opts.stale.includes(staleness))) {
    return "fresh";
  }
  try {
    await refreshCapabilitiesWithStoredToken(env, db, { ...opts, now });
    return "checked";
  } catch (error) {
    if (error instanceof CfTokenNotConfiguredError) return "no-token";
    throw error;
  }
}

/**
 * The first request a version serves: probes again only when the stored
 * answer is an older version's or lacks a probe this version runs, so an
 * update never leaves the install checks reading answers the running
 * version did not get. Never-run and earlier-day answers are left to setup
 * and the cron.
 */
export function refreshCapabilitiesAfterVersionChange(
  env: CfClientEnv,
  db: Database,
  opts: StoredTokenOptions & { version: string },
): Promise<"checked" | "fresh" | "no-token"> {
  return refreshCapabilitiesIfStale(env, db, {
    ...opts,
    stale: ["older-version", "missing-probe"],
  });
}
