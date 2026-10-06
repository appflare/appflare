import {
  type AccountCapabilities,
  type CapabilityClient,
  createCapabilityClient,
  type FetchLike,
  probeAccountCapabilities,
  probeAccountSetup,
  probeContainers,
  probeDomainCapabilities,
  probeR2,
  type RequestLog,
  signInCanProbe,
  type WorkersPlanCapability,
} from "@appflare/cf-api";
import {
  type CfClientEnv,
  CfTokenNotConfiguredError,
  getCfClient,
} from "../cloudflare/client.server";
import { readGrant } from "../cloudflare/grant-store.server";
import type { Database } from "../db/client";
import { cloudflare_grant } from "../db/schema";
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
 * keeps the last answer it gave. A Cloudflare sign-in has no permission for
 * the plan (Cloudflare's OAuth scopes include no Billing one), so with one
 * the plan probe is not asked and is stored as refused: eight calls.
 */

export async function readCapabilitiesView(db: Database): Promise<CapabilitiesView> {
  const [row, grants] = await Promise.all([
    readSettings(db, [SETTING.accountPlan, SETTING.accountCapabilities, SETTING.accountId]),
    // A stored grant is Cloudflare sign-in, as every client decides it.
    db.select({ id: cloudflare_grant.id }).from(cloudflare_grant).limit(1),
  ]);
  return capabilitiesView(
    row.account_plan,
    parseStoredCapabilities(row.account_capabilities),
    row.account_id,
    grants.length > 0 ? "oauth" : "api_token",
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
  /**
   * The scopes of the Cloudflare sign-in `client` calls with; absent or null
   * for an API token. The plan probe is not asked when they cannot cover it
   * (no Billing scope exists); every other probe is, and a refusal is stored
   * as such.
   */
  signInScopes?: readonly string[] | null;
}

/** The plan as a sign-in that may not read it finds it, without asking Cloudflare. */
export const SIGN_IN_PLAN: WorkersPlanCapability = {
  state: "unknown",
  reason: "no-permission",
  detail: "Cloudflare sign-in has no permission to read the plan",
};

/** R2, Containers and the plan; the plan only when the credential may read it. */
async function probeAccount(
  client: CapabilityClient,
  signInScopes: readonly string[] | null,
): Promise<AccountCapabilities> {
  if (signInScopes === null || signInCanProbe("workersPlan", signInScopes)) {
    return probeAccountCapabilities(client);
  }
  const [r2, containers] = await Promise.all([probeR2(client), probeContainers(client)]);
  return { r2, containers, workersPlan: SIGN_IN_PLAN };
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
    probeAccount(client, opts.signInScopes ?? null),
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
  // Read once: the client starts from it, and a sign-in's scopes decide the probes.
  const grant = await readGrant(env.DB);
  const client = await getCfClient(env, {
    grant,
    ...(opts.fetch === undefined ? {} : { fetch: opts.fetch }),
  });
  return refreshCapabilities(db, client, { ...opts, signInScopes: grant?.scopes ?? null });
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
