import {
  CloudflareApiError,
  type CloudflareClient,
  DOMAIN_DNS_RECORD_CONFLICT,
  DOMAIN_ORIGIN_CONFLICT,
  type FetchLike,
  type Zone,
} from "@appflare/cf-api";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import {
  CUSTOM_DOMAINS_FEATURE,
  permissionName,
  splitPermissionGroups,
} from "../cloudflare/token-template";
import { createDb } from "../db/client";
import { type HealthStatus, installs, resources } from "../db/schema";
import { healthCheckOfManifest, probeHealth, settleHealthProbe } from "../jobs/install/health";
import { checkHostnameInZone } from "./custom-domain-input";
import { CUSTOM_DOMAIN_KIND, WILDCARD_DOMAIN_KIND } from "./resource-kinds";
import {
  NO_VARS_REFRESH,
  type RefreshVars,
  refreshSettings,
  type VarsRefresh,
} from "./vars-refresh.server";
import { wildcardOfManifest } from "./wildcard-domain-input";
import {
  applyDomainLive,
  beforeDomainRemoval,
  domainIsLive,
  recordDomainLive,
  WorkersDevError,
} from "./workers-dev.server";

/**
 * Custom domains of an install: a hostname in one of the account's zones that
 * serves the install's Worker, attached through the Workers custom domains API
 * and recorded as a resource of kind `domain` (name = hostname, cf_id = the
 * domain's id). Adding, removing, and a one-off check run in the request, not
 * as a job: each is one or two API calls.
 *
 * The permissions these calls need are optional for the rest of the manager,
 * so a token without them fails only here, with a message that names them.
 */

export class CustomDomainError extends Error {
  override name = "CustomDomainError";
}

export interface CustomDomainDeps {
  db: D1Database;
  api: CloudflareClient;
  now?: () => Date;
  newId?: () => string;
  /** Deploys the settings again when they use the app's address; without it nothing is. */
  refreshVars?: RefreshVars;
}

/** The permission groups by the dashboard's names, for messages. */
const PERMISSION = {
  zone: "Zone: Read",
  dns: "DNS: Edit",
  routes: "Workers Routes: Edit",
} as const;

const ALL_PERMISSIONS = splitPermissionGroups()
  .optional.filter((g) => g.onlyFor === CUSTOM_DOMAINS_FEATURE)
  .map(permissionName)
  .join(", ");

/** Whether Cloudflare refused a call for lack of permission (403, or code 10000/9109). */
export function isPermissionError(error: unknown): boolean {
  return (
    error instanceof CloudflareApiError &&
    (error.status === 403 || error.errors.some((e) => e.code === 10000 || e.code === 9109))
  );
}

function hasCode(error: unknown, code: number): boolean {
  return error instanceof CloudflareApiError && error.errors.some((e) => e.code === code);
}

/** Runs a read; null when the token lacks the permission for it. */
export async function unlessForbidden<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    if (isPermissionError(error)) return null;
    throw error;
  }
}

export interface ZoneOption {
  id: string;
  name: string;
}

export interface DomainOptions {
  /** Active zones the token can see, by name. */
  zones: ZoneOption[];
  /** Zones the token can see that are not active yet, which cannot serve a Worker. */
  inactiveZones: string[];
  /**
   * Permission groups the token lacks, by the dashboard's names. When the token
   * sees no zone at all this lists all three: without Zone: Read the zone list
   * is empty rather than refused, so the two cases look the same.
   */
  missing: string[];
  /** The token sees no zone, active or not. */
  noZones: boolean;
}

/**
 * The zones of this account the token can see, active ones first split out and
 * sorted by name; null when the token may not list zones. A token without
 * Zone: Read gets an empty list rather than a refusal, so an empty result can
 * mean either. Shared with Email Routing, which offers the same zones.
 */
export async function listAccountZones(
  api: CloudflareClient,
): Promise<{ active: Zone[]; inactive: Zone[] } | null> {
  const listed = await unlessForbidden(() => api.zones.listZones({ accountId: api.accountId }));
  if (listed === null) return null;
  // A user token can see zones of other accounts; only this account's can serve its Workers.
  const own = listed.filter((z) => z.account?.id === api.accountId);
  return {
    active: own.filter(isActiveZone).sort((a, b) => a.name.localeCompare(b.name)),
    inactive: own.filter((z) => !isActiveZone(z)),
  };
}

/**
 * What the add dialog offers: the active zones, and which of the permissions
 * custom domains need the token lacks. Workers Routes and DNS are probed with
 * a read on the first active zone (a token can be narrowed to some zones, so
 * this is a hint, and adding still reports a refusal precisely).
 */
export async function getDomainOptionsCore(deps: CustomDomainDeps): Promise<DomainOptions> {
  const listed = await listAccountZones(deps.api);
  if (listed === null) {
    return { zones: [], inactiveZones: [], missing: [PERMISSION.zone], noZones: true };
  }
  const { active } = listed;
  const inactiveZones = listed.inactive.map((z) => z.name);
  if (active.length === 0 && inactiveZones.length === 0) {
    return {
      zones: [],
      inactiveZones: [],
      missing: [PERMISSION.zone, PERMISSION.dns, PERMISSION.routes],
      noZones: true,
    };
  }
  const missing: string[] = [];
  const [first] = active;
  if (first !== undefined) {
    const [routes, dns] = await Promise.all([
      unlessForbidden(() => deps.api.zones.listWorkerRoutes(first.id)),
      unlessForbidden(() => deps.api.zones.listDnsRecords(first.id, { name: first.name })),
    ]);
    if (dns === null) missing.push(PERMISSION.dns);
    if (routes === null) missing.push(PERMISSION.routes);
  }
  return {
    zones: active.map((z) => ({ id: z.id, name: z.name })),
    inactiveZones,
    missing,
    noZones: false,
  };
}

/** Whether a zone serves traffic: active on Cloudflare and not paused. */
export function isActiveZone(zone: Zone): boolean {
  return zone.status === "active" && zone.paused !== true;
}

/** Address records a custom domain's own record replaces. */
const ADDRESS_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);

export interface ConflictingRecord {
  type: string;
  content: string | null;
}

export type AddCustomDomainResult =
  | { ok: true; resourceId: string; hostname: string }
  | {
      ok: false;
      /** The hostname has DNS records the domain would replace; ask before replacing them. */
      reason: "dns-conflict";
      hostname: string;
      /** Empty when the records could not be read (the attach call reported them). */
      records: ConflictingRecord[];
    };

export interface AddCustomDomainRequest {
  installId: string;
  zoneId: string;
  hostname: string;
  overrideExistingDnsRecord?: boolean;
}

/**
 * Attaches `hostname` in zone `zoneId` to the install's Worker and records it.
 * Refuses a hostname that serves another Worker (it never moves a domain away
 * from one), and without the admin's explicit agreement one that has DNS
 * address records of its own: it then answers `dns-conflict` with the
 * records, and the admin may retry with `overrideExistingDnsRecord`.
 */
export async function addCustomDomainCore(
  deps: CustomDomainDeps,
  request: AddCustomDomainRequest,
): Promise<AddCustomDomainResult> {
  const orm = createDb(deps.db);
  const now = deps.now ?? (() => new Date());
  const install = await readInstall(deps.db, request.installId);
  // An uninstall or update sets the status when it starts, in the same batch
  // that records its job.
  if (install.status !== "installed") {
    throw new CustomDomainError(
      `A custom domain can be added only to an installed app; this one is ${install.status}.`,
    );
  }

  // Such an app answers on every name under a base; one exact name would not do.
  if (wildcardOfManifest(install.manifestJson) !== null) {
    throw new CustomDomainError(
      "This app needs every name under its hostname. Add a wildcard domain instead.",
    );
  }

  const zone = await readZone(deps.api, request.zoneId);
  const checked = checkHostnameInZone(request.hostname, zone.name);
  if (!checked.ok) throw new CustomDomainError(checked.error);
  const { hostname } = checked;

  const [recorded] = await orm
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, install.id),
        eq(resources.kind, CUSTOM_DOMAIN_KIND),
        eq(resources.name, hostname),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  if (recorded !== undefined) {
    throw new CustomDomainError(`${hostname} is already a custom domain of this app.`);
  }

  const attached = await attachCheckedDomain(deps.api, {
    zone,
    hostname,
    workerName: install.workerName,
    overrideExistingDnsRecord: request.overrideExistingDnsRecord === true,
  });
  if (!attached.ok) return attached;
  const domainId = attached.domainId;

  const resourceId = `${install.id}:${CUSTOM_DOMAIN_KIND}:${(deps.newId ?? (() => ulid()))()}`;
  // Recorded only while the install is not being uninstalled: an uninstall that
  // started meanwhile reads the install's domains when it runs, and must not
  // miss this one.
  const inserted = await deps.db
    .prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       SELECT ?1, ?2, '${CUSTOM_DOMAIN_KIND}', NULL, ?3, ?4, ?5
       WHERE EXISTS (
         SELECT 1 FROM installs WHERE id = ?2 AND status NOT IN ('uninstalling', 'uninstalled')
       )`,
    )
    .bind(resourceId, install.id, hostname, domainId, now().getTime())
    .run();
  if (inserted.meta.changes !== 1) {
    const detached = await deps.api.workerDomains.detachDomain(domainId).then(
      () => true,
      (error: unknown) => (error instanceof CloudflareApiError && error.status === 404) || false,
    );
    throw new CustomDomainError(
      detached
        ? `The app started uninstalling while ${hostname} was being added, so Appflare removed the domain again.`
        : `The app started uninstalling while ${hostname} was being added, and Appflare could not remove the domain again. It is not recorded on this app, so the uninstall will not remove it; remove it from the Worker in the Cloudflare dashboard (Workers & Pages, the Worker, Domains).`,
    );
  }
  return { ok: true, resourceId, hostname };
}

export type AttachCustomDomainResult =
  | { ok: true; hostname: string; domainId: string }
  | Extract<AddCustomDomainResult, { ok: false }>;

/**
 * Attaches `hostname` in `zone` to the Worker `workerName`, or finds it
 * attached there already. Refuses a hostname that serves another Worker, and
 * without `overrideExistingDnsRecord` one with DNS address records of its
 * own (answered as `dns-conflict` with the records). Shared by adding a
 * domain on the app page and by the install job's domain step.
 */
export async function attachCheckedDomain(
  api: CloudflareClient,
  request: { zone: Zone; hostname: string; workerName: string; overrideExistingDnsRecord: boolean },
): Promise<AttachCustomDomainResult> {
  const { zone, hostname, workerName } = request;
  // The filter is applied again here: only an exact hostname match counts.
  const existing = (await api.workerDomains.listDomains({ hostname })).find(
    (d) => d.hostname.toLowerCase() === hostname,
  );
  if (existing !== undefined && existing.service !== workerName) {
    throw new CustomDomainError(otherWorkerMessage(hostname, existing.service));
  }
  // Attached to this Worker already (a request that failed after attaching,
  // a retried job step, or by hand): record it rather than attach it again.
  if (existing !== undefined) return { ok: true, hostname, domainId: existing.id };
  if (!request.overrideExistingDnsRecord) {
    const records = await unlessForbidden(() =>
      api.zones.listDnsRecords(zone.id, { name: hostname }),
    );
    const conflicting = (records ?? []).filter((r) => ADDRESS_RECORD_TYPES.has(r.type));
    if (conflicting.length > 0) {
      return {
        ok: false,
        reason: "dns-conflict",
        hostname,
        records: conflicting.map((r) => ({ type: r.type, content: r.content ?? null })),
      };
    }
  }
  try {
    const attached = await api.workerDomains.attachDomain({
      zoneId: zone.id,
      hostname,
      service: workerName,
      ...(request.overrideExistingDnsRecord ? { overrideExistingDnsRecord: true } : {}),
    });
    return { ok: true, hostname, domainId: attached.id };
  } catch (error) {
    if (hasCode(error, DOMAIN_DNS_RECORD_CONFLICT)) {
      if (!request.overrideExistingDnsRecord) {
        return { ok: false, reason: "dns-conflict", hostname, records: [] };
      }
      // Asked to replace them and still refused: some records cannot be
      // replaced this way.
      throw new CustomDomainError(
        `Cloudflare would not replace the DNS records at ${hostname}, even when asked to. Delete them in the Cloudflare dashboard (the domain's DNS records) and add the domain again.`,
      );
    }
    if (hasCode(error, DOMAIN_ORIGIN_CONFLICT)) {
      throw new CustomDomainError(otherWorkerMessage(hostname, null));
    }
    if (isPermissionError(error)) {
      throw new CustomDomainError(
        `Cloudflare refused to attach ${hostname}: the token needs ${PERMISSION.routes} on ${zone.name} (and ${PERMISSION.dns} to replace records). Add them to the token and try again.`,
      );
    }
    throw error;
  }
}

function otherWorkerMessage(hostname: string, worker: string | null): string {
  const which = worker === null ? "another Worker" : `the Worker "${worker}"`;
  return `${hostname} already serves ${which}. Remove it there first; Appflare does not move a domain away from another Worker.`;
}

export async function readZone(api: CloudflareClient, zoneId: string): Promise<Zone> {
  let zone: Zone;
  try {
    zone = await api.zones.getZone(zoneId);
  } catch (error) {
    if (isPermissionError(error) || (error instanceof CloudflareApiError && error.status === 404)) {
      throw new CustomDomainError(
        `The Cloudflare token cannot see that zone. It needs ${ALL_PERMISSIONS} on it.`,
      );
    }
    throw error;
  }
  // A user token can see zones of other accounts; a Worker can only be
  // attached to a hostname in its own account's zones.
  if (zone.account?.id !== api.accountId) {
    throw new CustomDomainError(
      `${zone.name} belongs to another Cloudflare account, not the one Appflare runs in.`,
    );
  }
  if (zone.status !== "active" || zone.paused === true) {
    throw new CustomDomainError(
      `${zone.name} is not active on Cloudflare yet (${zone.status}), so it cannot serve an app.`,
    );
  }
  return zone;
}

interface InstallRow {
  id: string;
  status: string;
  workerName: string;
  manifestJson: string | null;
}

/** Runs `run`, reporting a workers.dev refusal as a custom domain one. */
async function asCustomDomainError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkersDevError) throw new CustomDomainError(error.message);
    throw error;
  }
}

async function readInstall(db: D1Database, installId: string): Promise<InstallRow> {
  const [row] = await createDb(db)
    .select({
      id: installs.id,
      status: installs.status,
      workerName: installs.worker_name,
      manifestJson: installs.manifest_json,
    })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (row === undefined) throw new CustomDomainError("There is no such install.");
  return row;
}

/**
 * A custom domain of the install, or (with `wildcard`) its wildcard domain,
 * which is checked the same way: through its base hostname.
 */
async function readDomain(
  db: D1Database,
  request: { installId: string; resourceId: string },
  opts: { wildcard?: boolean } = {},
) {
  const kinds =
    opts.wildcard === true ? [CUSTOM_DOMAIN_KIND, WILDCARD_DOMAIN_KIND] : [CUSTOM_DOMAIN_KIND];
  const [row] = await createDb(db)
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.id, request.resourceId),
        eq(resources.install_id, request.installId),
        inArray(resources.kind, kinds),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  if (row === undefined) throw new CustomDomainError("That is not a custom domain of this app.");
  return row;
}

/**
 * Detaches the domain from the Worker and marks the resource deleted. A domain
 * already gone counts as removed. While an uninstall runs, the uninstall
 * removes the domains itself.
 */
export async function removeCustomDomainCore(
  deps: CustomDomainDeps,
  request: { installId: string; resourceId: string },
): Promise<{ hostname: string } & VarsRefresh> {
  const install = await readInstall(deps.db, request.installId);
  if (install.status === "uninstalling" || install.status === "uninstalled") {
    throw new CustomDomainError("The uninstall removes this app's custom domains.");
  }
  const domain = await readDomain(deps.db, request);
  // With workers.dev off, the last live domain is the app's only address.
  const removal = await asCustomDomainError(() =>
    beforeDomainRemoval(
      { db: deps.db, api: async () => deps.api },
      { installId: request.installId, resourceId: domain.id },
    ),
  );
  await detachCustomDomain(deps.api, {
    hostname: domain.name,
    cfId: domain.cf_id,
    workerName: install.workerName,
  });
  await createDb(deps.db)
    .update(resources)
    .set({ deleted_at: (deps.now ?? (() => new Date()))() })
    .where(eq(resources.id, domain.id));
  // The app's address moved: settings that use `{{appUrl}}` follow it.
  const refresh = removal.addressChanged
    ? await refreshSettings(deps.refreshVars, request.installId, ["appUrl"])
    : NO_VARS_REFRESH;
  return { hostname: domain.name, ...refresh };
}

/**
 * What detaching a recorded custom domain did: `detached`; `gone` (a 404, or
 * no domain with that hostname); `not-ours` (no id was recorded and the
 * hostname now serves another Worker, which is left alone).
 */
export type DetachOutcome = "detached" | "gone" | "not-ours";

/**
 * Detaches one recorded custom domain; shared with the uninstall job. Without
 * a recorded id the domain is found by hostname, and detached only if it
 * still serves this install's Worker.
 */
export async function detachCustomDomain(
  api: CloudflareClient,
  domain: { hostname: string; cfId: string | null; workerName: string },
): Promise<DetachOutcome> {
  let id = domain.cfId;
  if (id === null) {
    const found = (await api.workerDomains.listDomains({ hostname: domain.hostname })).find(
      (d) => d.hostname.toLowerCase() === domain.hostname,
    );
    if (found === undefined) return "gone";
    if (found.service !== domain.workerName) return "not-ours";
    id = found.id;
  }
  try {
    await api.workerDomains.detachDomain(id);
    return "detached";
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return "gone";
    throw error;
  }
}

/** One log line for a {@link DetachOutcome}. */
export function detachMessage(hostname: string, outcome: DetachOutcome): string {
  switch (outcome) {
    case "detached":
      return `Removed custom domain ${hostname}.`;
    case "gone":
      return `Custom domain ${hostname} was already gone.`;
    case "not-ours":
      return `Custom domain ${hostname} now serves another Worker, so it was left alone.`;
  }
}

export interface CustomDomainCheck extends VarsRefresh {
  hostname: string;
  url: string;
  status: HealthStatus;
  /** What the app answered ("HTTP 200", "connection failed (...)"). */
  detail: string;
  /**
   * Cloudflare Access answered with its sign-in page: the domain counts as
   * live (`domainIsLive`), but the app itself was not checked.
   */
  access?: true;
  /** ISO 8601 */
  checkedAt: string;
  /** The app answered through the domain, so this check turned workers.dev off. */
  workersDevTurnedOff: boolean;
}

/**
 * "Check" next to a custom domain (or a wildcard domain, through its base
 * hostname): one GET of `https://<hostname><health path>`, the same probe as the install's "Check now". The install's health
 * stays the check of its main address, and a new domain may take a while
 * before its certificate and DNS record are live. When the app answers, the
 * domain is recorded as live (an address the app is opened at) and, with
 * `api`, workers.dev may be turned off (`applyDomainLive`). So does
 * Cloudflare Access answering on the domain (`domainIsLive`).
 */
export async function checkCustomDomainCore(
  deps: {
    db: D1Database;
    fetch: FetchLike;
    /** For turning workers.dev off; without it a live domain is only recorded. */
    api?: () => Promise<Pick<CloudflareClient, "workers">>;
    now?: () => Date;
    /** Deploys the settings again once the domain serves them; without it nothing is. */
    refreshVars?: RefreshVars;
  },
  request: { installId: string; resourceId: string },
): Promise<CustomDomainCheck> {
  const install = await readInstall(deps.db, request.installId);
  if (install.status !== "installed") {
    throw new CustomDomainError(
      `Only an installed app can be checked; this one is ${install.status}.`,
    );
  }
  const domain = await readDomain(deps.db, request, { wildcard: true });
  const check = healthCheckOfManifest(install.manifestJson);
  const url = `https://${domain.name}${check.path}`;
  const probe = await probeHealth(deps.fetch, url);
  const settled = settleHealthProbe(probe, check.mode);
  let workersDevTurnedOff = false;
  let refresh: VarsRefresh = NO_VARS_REFRESH;
  if (domainIsLive(probe, check.mode)) {
    const live = { installId: install.id, resourceId: domain.id, hostname: domain.name };
    if (deps.api === undefined) {
      await recordDomainLive(deps.db, live.resourceId, deps.now);
    } else {
      const { api } = deps;
      const applied = await asCustomDomainError(() =>
        applyDomainLive(
          {
            db: deps.db,
            api,
            ...(deps.now === undefined ? {} : { now: deps.now }),
            ...(deps.refreshVars === undefined ? {} : { refreshVars: deps.refreshVars }),
          },
          live,
        ),
      );
      workersDevTurnedOff = applied.turnedOff;
      refresh = { settingsJobId: applied.settingsJobId, settingsNote: applied.settingsNote };
    }
  }
  return {
    hostname: domain.name,
    url,
    ...settled,
    checkedAt: (deps.now ?? (() => new Date()))().toISOString(),
    workersDevTurnedOff,
    ...refresh,
  };
}
