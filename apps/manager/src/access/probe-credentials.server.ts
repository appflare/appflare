import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { type CfClientEnv, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import type { InstallProbeHeaders } from "../jobs/install/health";
import { readInstallAccess } from "./install-access.server";
import { openServiceTokenSecret } from "./service-token-secret";

/**
 * An install's service token for the manager's own health checks of that
 * install (install-access.server.ts), so an app protected with Cloudflare
 * Access answers them instead of Access's sign-in page. A token is sent
 * only when all of these hold:
 *
 * - the install is protected by Appflare (its Access application is
 *   recorded), and the token is that install's own, never another's;
 * - the host is one of that install's addresses: its workers.dev name, the
 *   preview of its serving version or of the version a running job of it
 *   uploaded (`<first 8 hex>-<name>`), one of its custom domains, or
 *   a name under one of its wildcard domains. External domains never
 *   count: their owner can point the DNS at a server of their own and would
 *   capture the token;
 * - the host is one the account itself controls, checked again apart from
 *   the records: a name under the account's own `<subdomain>.workers.dev`,
 *   or a hostname in one of its own active zones;
 * - https on the default port, with no credentials in the URL.
 *
 * The probes do not follow redirects (`probeHealth`), so the headers never
 * reach another host; and they are sent only in a second probe, after the
 * first one without them got Access's sign-in for that very host
 * (`probeHealthThroughAccess`), so Access, which strips them, is in front
 * of it right then.
 */

export interface ProbeCredentialsDeps {
  db: D1Database;
  /** `BETTER_AUTH_SECRET`, to open the sealed client secret. */
  authSecret: string | undefined;
  /**
   * The names of the account's active zones, lower-cased; null when they
   * cannot be read. Called only for a protected install's custom or
   * wildcard domain.
   */
  zoneNames: () => Promise<readonly string[] | null>;
}

const SUBDOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** The host of `url` when it may ever carry credentials: https, default port, no userinfo. */
export function probeHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.port !== "") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0 || host.endsWith(".") || host.startsWith("[")) return null;
  return host;
}

/** `host` is a name under the account's own `<subdomain>.workers.dev` (never the bare subdomain). */
export function isAccountWorkersDevHost(
  host: string,
  subdomain: string | null | undefined,
): boolean {
  const sub = (subdomain ?? "").toLowerCase();
  if (!SUBDOMAIN.test(sub)) return false;
  const suffix = `.${sub}.workers.dev`;
  return host.length > suffix.length && host.endsWith(suffix);
}

/** `host` is one of `zones` or a name under one of them. */
export function isInAccountZone(host: string, zones: readonly string[]): boolean {
  return zones.some((zone) => {
    const z = zone.toLowerCase();
    return z.includes(".") && (host === z || host.endsWith(`.${z}`));
  });
}

/** An install's own addresses, as recorded: what its token may be sent to. */
export interface InstallAddresses {
  workerName: string;
  /** First 8 hex digits of the versions whose preview address counts (serving, or being checked). */
  versionPrefixes: readonly string[];
  /** Custom domains (exact hostnames). */
  domains: readonly string[];
  /** Wildcard domain bases: the base and every name under it. */
  wildcardBases: readonly string[];
}

/** `host` is one of the install's own addresses (see {@link InstallAddresses}). */
export function isInstallAddress(
  host: string,
  subdomain: string | null | undefined,
  install: InstallAddresses,
): boolean {
  const name = install.workerName.toLowerCase();
  if (isAccountWorkersDevHost(host, subdomain)) {
    const label = host.slice(0, host.length - `.${subdomain}.workers.dev`.length);
    return label === name || install.versionPrefixes.some((p) => label === `${p}-${name}`);
  }
  if (install.domains.some((d) => d.toLowerCase() === host)) return true;
  return install.wildcardBases.some((b) => {
    const base = b.toLowerCase();
    return host === base || host.endsWith(`.${base}`);
  });
}

async function installAddresses(
  d1: D1Database,
  installId: string,
): Promise<InstallAddresses | null> {
  const orm = createDb(d1);
  const [install] = await orm
    .select({ workerName: installs.worker_name, currentVersionId: installs.current_version_id })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) return null;
  // An update or settings change records its version before checking its preview.
  const running = await orm
    .select({ versionId: jobs.worker_version_id })
    .from(jobs)
    .where(and(eq(jobs.install_id, installId), eq(jobs.status, "running")));
  const versionPrefixes = [install.currentVersionId, ...running.map((j) => j.versionId)]
    .filter((v): v is string => v !== null && v.length > 0)
    .map((v) => v.replace(/-/g, "").slice(0, 8).toLowerCase());
  const rows = await orm
    .select({ kind: resources.kind, name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        inArray(resources.kind, ["domain", "wildcard_domain"]),
        isNull(resources.deleted_at),
      ),
    );
  return {
    workerName: install.workerName,
    versionPrefixes,
    domains: rows.filter((r) => r.kind === "domain").map((r) => r.name),
    wildcardBases: rows.filter((r) => r.kind === "wildcard_domain").map((r) => r.name),
  };
}

/**
 * The `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers of the
 * install's own token for a health check of `url`, or undefined: the
 * install is not protected by Appflare (one D1 read, nothing else), `url`
 * is not one of its addresses or not the account's, its secret no longer
 * opens, or anything failed. Never throws and never logs the secret.
 */
export async function probeCredentials(
  deps: ProbeCredentialsDeps,
  installId: string,
  url: string,
): Promise<Record<string, string> | undefined> {
  try {
    const record = await readInstallAccess(deps.db, installId);
    if (record === null || record.accessAppId === null) return undefined;
    const host = probeHost(url);
    if (host === null) return undefined;
    const subdomain = (await readSettings(createDb(deps.db), [SETTING.accountSubdomain]))
      .account_subdomain;
    const addresses = await installAddresses(deps.db, installId);
    if (addresses === null || !isInstallAddress(host, subdomain, addresses)) return undefined;
    if (!isAccountWorkersDevHost(host, subdomain)) {
      const zones = await deps.zoneNames();
      if (zones === null || !isInAccountZone(host, zones)) return undefined;
    }
    const secret = await openServiceTokenSecret(
      deps.authSecret,
      { installId, tokenId: record.tokenId },
      record.sealedSecret,
    );
    if (secret === null) return undefined;
    return { "CF-Access-Client-Id": record.clientId, "CF-Access-Client-Secret": secret };
  } catch (error) {
    console.warn("access: health check sent without the app's service token", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** How long this isolate keeps the account's zone names. */
export const ZONE_NAMES_CACHE_MS = 5 * 60_000;

const zoneNamesHeld = new Map<string, { at: number; names: readonly string[] }>();

/** Forgets every account's zone names (tests). */
export function forgetZoneNames(): void {
  zoneNamesHeld.clear();
}

/**
 * The account's active zone names: from this isolate's copy while it is
 * fresh, else from `load` (kept when it answers). A zone that left the
 * account stops counting within {@link ZONE_NAMES_CACHE_MS}.
 */
export async function cachedZoneNames(
  accountId: string,
  load: () => Promise<readonly string[]>,
  now: number = Date.now(),
): Promise<string[]> {
  const copy = zoneNamesHeld.get(accountId);
  if (copy !== undefined && now >= copy.at && now - copy.at < ZONE_NAMES_CACHE_MS) {
    return [...copy.names];
  }
  const names = await load();
  zoneNamesHeld.set(accountId, { at: now, names: [...names] });
  return [...names];
}

/** `GET /zones?account.id=…&status=active`: this account's active zones, lower-cased names. */
export async function accountZoneNames(
  api: Pick<CloudflareClient, "zones" | "accountId">,
): Promise<string[]> {
  const zones = await api.zones.listZones({ accountId: api.accountId, status: "active" });
  // A user token can see other accounts' zones; only this account's count.
  return zones.filter((z) => z.account?.id === api.accountId).map((z) => z.name.toLowerCase());
}

/** Zone names through `api`, cached; null when they cannot be read (no Zone: Read, an error). */
export function zoneNamesVia(
  api: () => Promise<Pick<CloudflareClient, "zones" | "accountId">>,
): () => Promise<readonly string[] | null> {
  return async () => {
    try {
      const client = await api();
      return await cachedZoneNames(client.accountId, () => accountZoneNames(client));
    } catch {
      return null;
    }
  };
}

/** {@link probeCredentials} for server functions and units: the Worker's own bindings and token. */
export function probeHeadersFromEnv(
  env: CfClientEnv & { BETTER_AUTH_SECRET?: string },
  opts: { fetch?: FetchLike } = {},
): InstallProbeHeaders {
  const deps: ProbeCredentialsDeps = {
    db: env.DB,
    authSecret: env.BETTER_AUTH_SECRET,
    zoneNames: zoneNamesVia(() =>
      getCfClient(env, opts.fetch === undefined ? {} : { fetch: opts.fetch }),
    ),
  };
  return (installId, url) => probeCredentials(deps, installId, url);
}
