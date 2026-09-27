import {
  CloudflareApiError,
  type CloudflareClient,
  type DnsRecord,
  type Zone,
} from "@appflare/cf-api";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { createDb, type Database } from "../db/client";
import { installs, resources } from "../db/schema";
import { CustomDomainError, isPermissionError, readZone } from "./custom-domains.server";
import {
  ADDRESS_KINDS,
  DNS_RECORD_KIND,
  WILDCARD_DOMAIN_KIND,
  WILDCARD_PARTS_KINDS,
  WORKER_ROUTE_KIND,
} from "./resource-kinds";
import {
  type AddWildcardDomainInput,
  checkWildcardBase,
  wholeDomainWarning,
  wildcardOfManifest,
  wildcardPattern,
  wildcardRecordNames,
  wildcardRoutePatterns,
} from "./wildcard-domain-input";
import { beforeDomainRemoval, WorkersDevError } from "./workers-dev.server";

/**
 * Wildcard domains of an install: a base hostname in one of the account's
 * zones whose every name serves the install's Worker, for an app whose
 * catalog manifest sets `install.wildcardHostname`.
 *
 * Workers custom domains do not support wildcards (Cloudflare's custom
 * domains docs: "An incoming request must exactly match the domain or
 * subdomain your Custom Domain is registered to"), so the base is served the
 * way Workers routes are: two proxied DNS records (the base and `*.<base>`,
 * AAAA `100::`, an address that only means "proxied by Cloudflare") and two
 * routes to the Worker (`<base>/*`, and `*.<base>/*`, which per the routes
 * docs matches every name under the base but not the base itself). Proxied
 * wildcard records exist on every plan. A route that names another Worker, a
 * custom domain at the base (which takes the name before any route), and
 * address records Appflare did not make are refused rather than replaced.
 *
 * Recorded as one `wildcard_domain` resource (name = base, cf_id = zone id,
 * an address like a custom domain) plus one `dns_record` or `worker_route`
 * resource per object created (cf_id `<zone id>/<id>`, binding = base).
 * Records carry a comment naming the Worker, so a retried attach finds its
 * own records and takes them over instead of refusing them.
 */

export class WildcardDomainError extends Error {
  override name = "WildcardDomainError";
}

/** The record every name of a wildcard domain gets: Cloudflare's placeholder for Worker-only names. */
export const WILDCARD_RECORD = { type: "AAAA", content: "100::" } as const;

/** The comment on the records Appflare creates, which is how a retry recognizes them. */
export function wildcardRecordComment(workerName: string): string {
  return `Appflare: serves the Worker ${workerName}`;
}

/** Address records a wildcard domain's record would sit beside and fight with. */
const ADDRESS_RECORD_TYPES = new Set(["A", "AAAA", "CNAME"]);

const PERMISSION = { dns: "DNS: Edit", routes: "Workers Routes: Edit" } as const;

/** One Cloudflare object that serves a wildcard domain. */
export interface WildcardPart {
  kind: typeof DNS_RECORD_KIND | typeof WORKER_ROUTE_KIND;
  /** The record's name, or the route's pattern. */
  name: string;
  /** The record's or route's id. */
  id: string;
  /** Created now (false: found from an earlier attempt). */
  created: boolean;
}

export interface AttachedWildcardDomain {
  hostname: string;
  zoneId: string;
  /** The records, then the routes. */
  parts: WildcardPart[];
}

/** `<zone id>/<id>`, the `cf_id` of a record or route. */
export function wildcardPartRef(zoneId: string, id: string): string {
  return `${zoneId}/${id}`;
}

function parsePartRef(ref: string | null): { zoneId: string; id: string } | null {
  const slash = ref?.indexOf("/") ?? -1;
  if (ref === null || slash <= 0 || slash === ref.length - 1) return null;
  return { zoneId: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function describeRecord(r: DnsRecord): string {
  return r.content === undefined ? r.type : `${r.type} ${r.content}`;
}

function refusedFor(permission: string, zone: Zone, hostname: string): WildcardDomainError {
  return new WildcardDomainError(
    `Cloudflare refused to set up ${wildcardPattern(hostname)}: the token needs ${permission} on ${zone.name}. Add it to the token and try again.`,
  );
}

/**
 * Serves `hostname` and every name under it in `zone` with the Worker
 * `workerName`: creates what is missing of the two records and two routes,
 * taking over those an earlier attempt created. Everything is checked before
 * anything is created, so a refusal leaves the zone as it was.
 */
export async function attachWildcardDomain(
  api: CloudflareClient,
  request: { zone: Zone; hostname: string; workerName: string },
): Promise<AttachedWildcardDomain> {
  const { zone, hostname, workerName } = request;
  const comment = wildcardRecordComment(workerName);

  // A custom domain answers its name before any route runs.
  const domain = (await api.workerDomains.listDomains({ hostname })).find(
    (d) => d.hostname.toLowerCase() === hostname,
  );
  if (domain !== undefined && domain.service !== workerName) {
    throw new WildcardDomainError(
      `${hostname} is a custom domain of the Worker "${domain.service}". Remove it there first; Appflare does not take a hostname from another Worker.`,
    );
  }

  let routes: Awaited<ReturnType<CloudflareClient["zones"]["listWorkerRoutes"]>>;
  try {
    routes = await api.zones.listWorkerRoutes(zone.id);
  } catch (error) {
    if (isPermissionError(error)) throw refusedFor(PERMISSION.routes, zone, hostname);
    throw error;
  }
  const routePlan = wildcardRoutePatterns(hostname).map((pattern) => {
    const found = routes.find((r) => r.pattern.toLowerCase() === pattern);
    if (found !== undefined && found.script !== workerName) {
      throw new WildcardDomainError(
        found.script
          ? `The route ${found.pattern} already sends requests to the Worker "${found.script}". Remove it there first, or choose another name.`
          : `The route ${found.pattern} keeps Workers off those names. Remove it in the Cloudflare dashboard (the domain's Workers Routes), or choose another name.`,
      );
    }
    return { pattern, existing: found?.id ?? null };
  });

  const recordPlan: Array<{ name: string; existing: string | null }> = [];
  for (const name of wildcardRecordNames(hostname)) {
    let records: DnsRecord[];
    try {
      records = await api.zones.listDnsRecords(zone.id, { name });
    } catch (error) {
      if (isPermissionError(error)) throw refusedFor(PERMISSION.dns, zone, hostname);
      throw error;
    }
    const ours = records.find(
      (r) =>
        r.type === WILDCARD_RECORD.type &&
        r.content === WILDCARD_RECORD.content &&
        r.comment === comment,
    );
    const others = records.filter((r) => r !== ours && ADDRESS_RECORD_TYPES.has(r.type));
    if (others.length > 0) {
      throw new WildcardDomainError(
        `${name} already has DNS records (${others.map(describeRecord).join(", ")}). Appflare does not replace them: delete them in the Cloudflare dashboard (the domain's DNS records), or choose another name.`,
      );
    }
    recordPlan.push({ name, existing: ours?.id ?? null });
  }

  const parts: WildcardPart[] = [];
  for (const record of recordPlan) {
    if (record.existing !== null) {
      parts.push({ kind: DNS_RECORD_KIND, name: record.name, id: record.existing, created: false });
      continue;
    }
    try {
      const created = await api.zones.createDnsRecord(zone.id, {
        type: WILDCARD_RECORD.type,
        name: record.name,
        content: WILDCARD_RECORD.content,
        proxied: true,
        comment,
      });
      parts.push({ kind: DNS_RECORD_KIND, name: record.name, id: created.id, created: true });
    } catch (error) {
      if (isPermissionError(error)) throw refusedFor(PERMISSION.dns, zone, hostname);
      throw error;
    }
  }
  for (const route of routePlan) {
    if (route.existing !== null) {
      parts.push({
        kind: WORKER_ROUTE_KIND,
        name: route.pattern,
        id: route.existing,
        created: false,
      });
      continue;
    }
    try {
      const created = await api.zones.createWorkerRoute(zone.id, {
        pattern: route.pattern,
        script: workerName,
      });
      parts.push({ kind: WORKER_ROUTE_KIND, name: route.pattern, id: created.id, created: true });
    } catch (error) {
      if (isPermissionError(error)) throw refusedFor(PERMISSION.routes, zone, hostname);
      throw error;
    }
  }
  return { hostname, zoneId: zone.id, parts };
}

/**
 * Records a wildcard domain and its parts on the install, in one batch, only
 * while the install is not being uninstalled (an uninstall reads the
 * install's domains when it runs, and must not miss one). Returns the
 * wildcard domain's resource id, or null when nothing was recorded.
 */
export async function recordWildcardDomain(
  db: D1Database,
  request: {
    installId: string;
    attached: AttachedWildcardDomain;
    at: Date;
    newId?: () => string;
  },
): Promise<string | null> {
  const newId = request.newId ?? (() => ulid());
  const { installId, attached } = request;
  const at = request.at.getTime();
  const insert = (kind: string, id: string, binding: string | null, name: string, cfId: string) =>
    db
      .prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE EXISTS (
           SELECT 1 FROM installs WHERE id = ?2 AND status NOT IN ('uninstalling', 'uninstalled')
         )`,
      )
      .bind(id, installId, kind, binding, name, cfId, at);
  const resourceId = `${installId}:${WILDCARD_DOMAIN_KIND}:${newId()}`;
  const results = await db.batch([
    insert(WILDCARD_DOMAIN_KIND, resourceId, null, attached.hostname, attached.zoneId),
    ...attached.parts.map((p) =>
      insert(
        p.kind,
        `${installId}:${p.kind}:${newId()}`,
        attached.hostname,
        p.name,
        wildcardPartRef(attached.zoneId, p.id),
      ),
    ),
  ]);
  return results[0]?.meta.changes === 1 ? resourceId : null;
}

/** A recorded record or route of a wildcard domain. */
export interface RecordedWildcardPart {
  kind: string;
  name: string;
  cfId: string | null;
}

/** What removing one record or route did. */
export type WildcardPartOutcome = "removed" | "gone" | "unrecorded";

/**
 * Deletes the routes, then the records, of a wildcard domain. One that is
 * already gone (404) counts as removed. Returns one outcome per part, in the
 * order they were removed.
 */
export async function detachWildcardParts(
  api: CloudflareClient,
  parts: readonly RecordedWildcardPart[],
): Promise<Array<{ part: RecordedWildcardPart; outcome: WildcardPartOutcome }>> {
  const ordered = [
    ...parts.filter((p) => p.kind === WORKER_ROUTE_KIND),
    ...parts.filter((p) => p.kind === DNS_RECORD_KIND),
  ];
  const done: Array<{ part: RecordedWildcardPart; outcome: WildcardPartOutcome }> = [];
  for (const part of ordered) {
    const ref = parsePartRef(part.cfId);
    if (ref === null) {
      done.push({ part, outcome: "unrecorded" });
      continue;
    }
    try {
      if (part.kind === WORKER_ROUTE_KIND) await api.zones.deleteWorkerRoute(ref.zoneId, ref.id);
      else await api.zones.deleteDnsRecord(ref.zoneId, ref.id);
      done.push({ part, outcome: "removed" });
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) {
        done.push({ part, outcome: "gone" });
        continue;
      }
      throw error;
    }
  }
  return done;
}

/** One log line for what `detachWildcardParts` did to a wildcard domain. */
export function wildcardDetachMessage(
  hostname: string,
  done: ReadonlyArray<{ part: RecordedWildcardPart; outcome: WildcardPartOutcome }>,
): string {
  const removed = done.filter((d) => d.outcome === "removed").map((d) => d.part.name);
  const gone = done.filter((d) => d.outcome !== "removed").map((d) => d.part.name);
  return (
    `Removed wildcard domain ${wildcardPattern(hostname)}` +
    (removed.length > 0 ? `: ${removed.join(", ")}` : "") +
    (gone.length > 0 ? `; already gone: ${gone.join(", ")}` : "") +
    "."
  );
}

/** The recorded records and routes of the install's wildcard domain `hostname`. */
export async function readWildcardParts(
  orm: Database,
  installId: string,
  hostname: string,
): Promise<Array<RecordedWildcardPart & { id: string }>> {
  const rows = await orm
    .select({ id: resources.id, kind: resources.kind, name: resources.name, cfId: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        inArray(resources.kind, [...WILDCARD_PARTS_KINDS]),
        eq(resources.binding, hostname),
        isNull(resources.deleted_at),
      ),
    );
  return rows;
}

export interface WildcardDomainDeps {
  db: D1Database;
  api: CloudflareClient;
  now?: () => Date;
  newId?: () => string;
  /**
   * Deploys the app's settings again when they use `{{wildcardHostname}}`
   * (`startVarsRefreshCore`): the job's id, or null when none uses it.
   * Without it nothing is deployed.
   */
  refreshVars?: (installId: string) => Promise<{ jobId: string } | null>;
}

/** What assigning or removing the wildcard domain did to the app's settings. */
export interface VarsRefresh {
  /** The settings change that fills `{{wildcardHostname}}` in again; null when none started. */
  settingsJobId: string | null;
  /** Why the settings could not be deployed again now; null when they were, or need not be. */
  settingsNote: string | null;
}

/** Starts the settings refresh, reporting a refusal (another job runs) instead of failing. */
async function refreshSettings(deps: WildcardDomainDeps, installId: string): Promise<VarsRefresh> {
  if (deps.refreshVars === undefined) return { settingsJobId: null, settingsNote: null };
  try {
    const started = await deps.refreshVars(installId);
    return { settingsJobId: started?.jobId ?? null, settingsNote: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      settingsJobId: null,
      settingsNote: `The app's settings use {{wildcardHostname}} and were not deployed again (${reason}). Save the app's settings once that is done to fill it in.`,
    };
  }
}

async function readInstall(db: D1Database, installId: string) {
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
  if (row === undefined) throw new WildcardDomainError("There is no such install.");
  return row;
}

/** Runs `run`, reporting a custom domain or workers.dev refusal as a wildcard domain one. */
async function asWildcardDomainError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CustomDomainError || error instanceof WorkersDevError) {
      throw new WildcardDomainError(error.message);
    }
    throw error;
  }
}

/**
 * Checks what a wildcard domain would be before anything is created: the
 * zone is this account's and active, the base is in it, and the whole zone
 * only with the admin's agreement. Shared by the app page and the install
 * job (which checks that no other app holds the name itself).
 */
export async function checkWildcardRequest(
  api: CloudflareClient,
  request: { zoneId: string; hostname: string; wholeDomain?: boolean },
): Promise<{ zone: Zone; hostname: string }> {
  const zone = await asWildcardDomainError(() => readZone(api, request.zoneId));
  const checked = checkWildcardBase(request.hostname, zone.name);
  if (!checked.ok) throw new WildcardDomainError(checked.error);
  if (checked.wholeDomain && request.wholeDomain !== true) {
    throw new WildcardDomainError(
      `${zone.name} is a whole domain. ${wholeDomainWarning(zone.name)} Agree to serve all of it, or enter a name under it.`,
    );
  }
  return { zone, hostname: checked.hostname };
}

/** Whether another install records `hostname` as one of its addresses. */
async function heldElsewhere(orm: Database, installId: string, hostname: string) {
  const [held] = await orm
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        inArray(resources.kind, [...ADDRESS_KINDS]),
        eq(resources.name, hostname),
        ne(resources.install_id, installId),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  return held !== undefined;
}

/**
 * "Add a wildcard domain" on the app page: sets up the base `hostname` in
 * zone `zoneId` for the install's Worker and records it. An install has at
 * most one wildcard domain, since the app knows its sessions' names by one
 * base. Settings that use `{{wildcardHostname}}` are then deployed again
 * with it.
 */
export async function addWildcardDomainCore(
  deps: WildcardDomainDeps,
  request: AddWildcardDomainInput,
): Promise<{ resourceId: string; hostname: string } & VarsRefresh> {
  const orm = createDb(deps.db);
  const install = await readInstall(deps.db, request.installId);
  if (install.status !== "installed") {
    throw new WildcardDomainError(
      `A wildcard domain can be added only to an installed app; this one is ${install.status}.`,
    );
  }
  if (wildcardOfManifest(install.manifestJson) === null) {
    throw new WildcardDomainError(
      "This app answers on exact hostnames; add a custom domain instead.",
    );
  }
  const [current] = await orm
    .select({ name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, install.id),
        eq(resources.kind, WILDCARD_DOMAIN_KIND),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  if (current !== undefined) {
    throw new WildcardDomainError(
      `This app already answers on ${wildcardPattern(current.name)}. Remove that first to use another name.`,
    );
  }
  const { zone, hostname } = await checkWildcardRequest(deps.api, request);
  if (await heldElsewhere(orm, install.id, hostname)) {
    throw new WildcardDomainError(
      `${hostname} is already a domain of another app. Remove it there first.`,
    );
  }
  const attached = await attachWildcardDomain(deps.api, {
    zone,
    hostname,
    workerName: install.workerName,
  });
  const resourceId = await recordWildcardDomain(deps.db, {
    installId: install.id,
    attached,
    at: (deps.now ?? (() => new Date()))(),
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  });
  if (resourceId === null) {
    // Nothing is recorded, so an uninstall that started meanwhile would not
    // find these: remove what this request created.
    const created = attached.parts
      .filter((p) => p.created)
      .map((p) => ({ kind: p.kind, name: p.name, cfId: wildcardPartRef(zone.id, p.id) }));
    const removed = await detachWildcardParts(deps.api, created).then(
      () => true,
      () => false,
    );
    throw new WildcardDomainError(
      removed
        ? `The app started uninstalling while ${hostname} was being added, so Appflare removed its records and routes again.`
        : `The app started uninstalling while ${hostname} was being added, and Appflare could not remove its records and routes again. Delete the routes and DNS records for ${hostname} and ${wildcardPattern(hostname)} in the Cloudflare dashboard.`,
    );
  }
  return { resourceId, hostname, ...(await refreshSettings(deps, install.id)) };
}

/**
 * Removes the install's wildcard domain: its routes, then its records, then
 * marks all of it deleted. When it is the app's last live address while
 * workers.dev is off, workers.dev is turned back on first (or the removal is
 * refused when an admin turned it off). While an uninstall runs, the
 * uninstall removes it. Settings that use `{{wildcardHostname}}` are then
 * deployed again, empty.
 */
export async function removeWildcardDomainCore(
  deps: WildcardDomainDeps,
  request: { installId: string; resourceId: string },
): Promise<{ hostname: string } & VarsRefresh> {
  const orm = createDb(deps.db);
  const install = await readInstall(deps.db, request.installId);
  if (install.status === "uninstalling" || install.status === "uninstalled") {
    throw new WildcardDomainError("The uninstall removes this app's wildcard domain.");
  }
  const [domain] = await orm
    .select({ id: resources.id, name: resources.name })
    .from(resources)
    .where(
      and(
        eq(resources.id, request.resourceId),
        eq(resources.install_id, request.installId),
        eq(resources.kind, WILDCARD_DOMAIN_KIND),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  if (domain === undefined) {
    throw new WildcardDomainError("That is not a wildcard domain of this app.");
  }
  await asWildcardDomainError(() =>
    beforeDomainRemoval(
      { db: deps.db, api: async () => deps.api },
      { installId: request.installId, resourceId: domain.id },
    ),
  );
  const parts = await readWildcardParts(orm, request.installId, domain.name);
  try {
    await detachWildcardParts(deps.api, parts);
  } catch (error) {
    if (isPermissionError(error)) {
      throw new WildcardDomainError(
        `Cloudflare refused to remove ${wildcardPattern(domain.name)}: the token needs ${PERMISSION.routes} and ${PERMISSION.dns} on its domain. Add them to the token and try again.`,
      );
    }
    throw error;
  }
  const at = (deps.now ?? (() => new Date()))();
  await orm
    .update(resources)
    .set({ deleted_at: at })
    .where(inArray(resources.id, [domain.id, ...parts.map((p) => p.id)]));
  return { hostname: domain.name, ...(await refreshSettings(deps, request.installId)) };
}
