import {
  CloudflareApiError,
  type CloudflareClient,
  CUSTOM_HOSTNAMES_NOT_ENABLED,
  FALLBACK_ORIGIN_NOT_GRANTED,
  FALLBACK_ORIGIN_NOT_SET,
  type FallbackOrigin,
  type FetchLike,
  type ScriptMetadata,
  type Zone,
} from "@appflare/cf-api";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  EXTERNAL_DOMAINS_FEATURE,
  permissionName,
  splitPermissionGroups,
} from "../cloudflare/token-template";
import { createDb, type Database } from "../db/client";
import { resources } from "../db/schema";
import { deleteSettings, readSettings, SETTING, writeSettings } from "../db/settings";
import { isPermissionError, listAccountZones } from "../installs/custom-domains.server";
import { CUSTOM_HOSTNAME_KIND } from "../installs/resource-kinds";
import {
  GATEWAY_CODE_VERSION,
  GATEWAY_KV_TITLE,
  GATEWAY_ROUTE_PATTERN,
  GATEWAY_ROUTES_BINDING,
  GATEWAY_WORKER_NAME,
  gatewayHostname,
  saasCheckMessage,
  saasDashboardUrl,
  type ZoneSaasCheck,
} from "./gateway";
import gatewaySource from "./gateway-worker.js?raw";

export { saasCheckMessage, type ZoneSaasCheck } from "./gateway";

/**
 * The external domains gateway (Settings > Domains): one zone of the account
 * with Cloudflare for SaaS on, and what Appflare puts there so that custom
 * hostnames on it reach app Workers:
 *
 * 1. a proxied `AAAA appflare-gateway.<zone> 100::` record (originless: the
 *    gateway Worker answers everything, so the address is never contacted),
 *    which external domains point their CNAME at;
 * 2. that name as the zone's fallback origin, unless the zone has one already
 *    (Cloudflare needs one before custom hostnames go active);
 * 3. the KV namespace `appflare-gateway-routes` (hostname -> binding name);
 * 4. the Worker `appflare-gateway` (gateway-worker.js) with that namespace,
 *    the zone's name, and one service binding per install it serves;
 * 5. the route that matches every request of the zone, to that Worker.
 *
 * Setting up and turning off run in the request, one call at a time, and
 * record each piece in the `external_domains_gateway` setting as it is made,
 * so an attempt that failed half way continues where it stopped and turning
 * off removes exactly what Appflare made (a record or fallback origin that
 * was there before is left alone).
 */

export class GatewayError extends Error {
  override name = "GatewayError";
}

/** The compatibility date the gateway Worker is uploaded with. */
export const GATEWAY_COMPATIBILITY_DATE = "2026-09-01";

/** The gateway Worker's module name. */
export const GATEWAY_MODULE = "gateway.js";

/** The annotation of every version a binding change creates. */
export const GATEWAY_BINDING_MESSAGE = "Appflare: external domains changed";

/** "SSL and Certificates: Edit", the permission every custom hostname call needs. */
export const SSL_PERMISSION = permissionName(
  splitPermissionGroups().optional.find((g) => g.onlyFor === EXTERNAL_DOMAINS_FEATURE) ?? {
    key: "ssl_and_certificates",
    type: "edit",
    label: "SSL and Certificates",
  },
);

export const gatewayStateSchema = z.object({
  zoneId: z.string().min(1),
  zoneName: z.string().min(1),
  /** The DNS record at the gateway's hostname. */
  recordId: z.string().nullable().default(null),
  /** Appflare created that record (turning off deletes it). */
  recordCreated: z.boolean().default(false),
  /** Appflare set the zone's fallback origin (turning off removes it). */
  fallbackSet: z.boolean().default(false),
  kvId: z.string().nullable().default(null),
  /** The gateway Worker was uploaded by this setup. */
  workerUploaded: z.boolean().default(false),
  routeId: z.string().nullable().default(null),
  /** ISO 8601; set once every piece exists. */
  readyAt: z.string().nullable().default(null),
});
export type GatewayState = z.infer<typeof gatewayStateSchema>;

/** A gateway whose every piece exists. */
export type ReadyGateway = GatewayState & { kvId: string; readyAt: string };

export function isGatewayReady(state: GatewayState | null): state is ReadyGateway {
  return state !== null && state.kvId !== null && state.readyAt !== null;
}

export async function readGateway(orm: Database): Promise<GatewayState | null> {
  const row = await readSettings(orm, [SETTING.externalDomainsGateway]);
  const raw = row.external_domains_gateway;
  if (raw === undefined) return null;
  try {
    const parsed = gatewayStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function saveGateway(orm: Database, state: GatewayState, now: Date): Promise<void> {
  await writeSettings(orm, { [SETTING.externalDomainsGateway]: JSON.stringify(state) }, now);
}

function codes(error: unknown): number[] {
  return error instanceof CloudflareApiError ? error.errors.map((e) => e.code) : [];
}

/**
 * Why Cloudflare refused a custom hostname call: Cloudflare for SaaS is off
 * for the zone (code 1404, or 1456 from the fallback origin), or the token
 * lacks SSL and Certificates (403 code 10000); null for anything else.
 */
export function saasRefusal(error: unknown): "saas-off" | "missing-permission" | null {
  if (!(error instanceof CloudflareApiError)) return null;
  const found = codes(error);
  if (found.includes(CUSTOM_HOSTNAMES_NOT_ENABLED) || found.includes(FALLBACK_ORIGIN_NOT_GRANTED)) {
    return "saas-off";
  }
  if (isPermissionError(error)) return "missing-permission";
  return null;
}

/**
 * Whether Cloudflare for SaaS is on for the zone and the token may use it:
 * one read of the zone's custom hostname quota. That call is the only signal
 * the API gives; neither the zone's plan nor its subscriptions mention SaaS.
 */
export async function checkZoneSaas(
  api: CloudflareClient,
  zone: { id: string; name: string },
): Promise<ZoneSaasCheck> {
  try {
    const quota = await api.customHostnames.quota(zone.id);
    return { kind: "ready", used: quota.used ?? null, allocated: quota.allocated ?? null };
  } catch (error) {
    const refusal = saasRefusal(error);
    if (refusal === "saas-off") {
      return { kind: "saas-off", dashboardUrl: saasDashboardUrl(api.accountId, zone.name) };
    }
    if (refusal === "missing-permission") {
      return { kind: "missing-permission", permission: SSL_PERMISSION };
    }
    return {
      kind: "error",
      message: `Cloudflare could not say whether ${zone.name} can serve external domains: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The zone, if it belongs to this account and serves traffic. */
export async function readGatewayZone(api: CloudflareClient, zoneId: string): Promise<Zone> {
  let zone: Zone;
  try {
    zone = await api.zones.getZone(zoneId);
  } catch (error) {
    if (isPermissionError(error) || (error instanceof CloudflareApiError && error.status === 404)) {
      throw new GatewayError(
        "The Cloudflare token cannot see that domain. It needs Zone: Read, DNS: Edit and Workers Routes: Edit on it.",
      );
    }
    throw error;
  }
  if (zone.account?.id !== api.accountId) {
    throw new GatewayError(
      `${zone.name} belongs to another Cloudflare account, not the one Appflare runs in.`,
    );
  }
  if (zone.status !== "active" || zone.paused === true) {
    throw new GatewayError(
      `${zone.name} is not active on Cloudflare yet (${zone.status}), so it cannot be the gateway.`,
    );
  }
  return zone;
}

/** Runs a zone call; a permission refusal becomes a message naming what is missing. */
async function needing<T>(permission: string, zoneName: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (saasRefusal(error) === "saas-off") {
      throw new GatewayError(
        saasCheckMessage({ kind: "saas-off", dashboardUrl: "" }, zoneName) ?? "",
      );
    }
    if (isPermissionError(error)) {
      throw new GatewayError(
        `Cloudflare refused a call on ${zoneName}: the token needs ${permission} on it. Edit the token in the Cloudflare dashboard to add it, then try again.`,
      );
    }
    throw error;
  }
}

async function readFallbackOrigin(
  api: CloudflareClient,
  zoneId: string,
): Promise<FallbackOrigin | null> {
  try {
    return await api.customHostnames.getFallbackOrigin(zoneId);
  } catch (error) {
    if (
      codes(error).includes(FALLBACK_ORIGIN_NOT_SET) ||
      (error instanceof CloudflareApiError && error.status === 404)
    ) {
      return null;
    }
    throw error;
  }
}

/** A service binding of the gateway Worker: its name, and the app Worker it reaches. */
export interface GatewayService {
  binding: string;
  service: string;
}

interface GatewayBindings {
  /** The Worker exists. */
  exists: boolean;
  services: GatewayService[];
  /** `GATEWAY_VERSION` of the running code; null when unknown. */
  codeVersion: string | null;
}

async function readGatewayBindings(api: CloudflareClient): Promise<GatewayBindings> {
  let raw: unknown[];
  try {
    raw = await api.workers.getBindings(GATEWAY_WORKER_NAME);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return { exists: false, services: [], codeVersion: null };
    }
    throw error;
  }
  const services: GatewayService[] = [];
  let codeVersion: string | null = null;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const b = entry as Record<string, unknown>;
    if (b.type === "service" && typeof b.name === "string" && typeof b.service === "string") {
      services.push({ binding: b.name, service: b.service });
    }
    if (b.type === "plain_text" && b.name === "GATEWAY_VERSION" && typeof b.text === "string") {
      codeVersion = b.text;
    }
  }
  return { exists: true, services, codeVersion };
}

/** The gateway Worker's upload metadata: its routing table, its zone, and its services. */
export function gatewayMetadata(
  state: Pick<GatewayState, "zoneName"> & { kvId: string },
  services: readonly GatewayService[],
): ScriptMetadata {
  return {
    main_module: GATEWAY_MODULE,
    compatibility_date: GATEWAY_COMPATIBILITY_DATE,
    // No `global_fetch_strictly_public`: a pass-through `fetch(request)` must
    // reach the zone's origin, not come back to the zone and this Worker.
    compatibility_flags: [],
    bindings: [
      { type: "kv_namespace", name: GATEWAY_ROUTES_BINDING, namespace_id: state.kvId },
      { type: "plain_text", name: "ZONE_NAME", text: state.zoneName },
      { type: "plain_text", name: "CNAME_TARGET", text: gatewayHostname(state.zoneName) },
      { type: "plain_text", name: "GATEWAY_VERSION", text: GATEWAY_CODE_VERSION },
      ...services.map((s) => ({ type: "service", name: s.binding, service: s.service })),
    ],
  };
}

/** Uploads and deploys the gateway Worker with exactly these services. */
async function uploadGateway(
  api: CloudflareClient,
  state: Pick<GatewayState, "zoneName"> & { kvId: string },
  services: readonly GatewayService[],
): Promise<void> {
  await api.workers.uploadScript(GATEWAY_WORKER_NAME, {
    metadata: gatewayMetadata(state, services),
    modules: [{ name: GATEWAY_MODULE, type: "esm", content: gatewaySource }],
    excludeScript: true,
  });
}

/**
 * Makes the gateway reach `service` through `binding`. A binding it already
 * has is left alone. Otherwise a new version is made from the latest one
 * with a JSON merge patch that adds only this binding (code, routing table
 * and the other services are inherited) and deployed. A gateway running
 * older code is uploaded again instead, with its services and this one.
 */
export async function bindGatewayService(
  api: CloudflareClient,
  state: ReadyGateway,
  wanted: GatewayService,
): Promise<"unchanged" | "patched" | "uploaded"> {
  const current = await readGatewayBindings(api);
  const same = current.services.find((s) => s.binding === wanted.binding);
  const fresh = current.exists && current.codeVersion === GATEWAY_CODE_VERSION;
  if (fresh && same?.service === wanted.service) return "unchanged";
  if (!fresh) {
    const others = current.services.filter((s) => s.binding !== wanted.binding);
    await uploadGateway(api, state, [...others, wanted]);
    return "uploaded";
  }
  await patchGateway(api, { [wanted.binding]: { type: "service", service: wanted.service } });
  return "patched";
}

/** Removes the gateway's binding, if it has it (the same way {@link bindGatewayService} adds one). */
export async function unbindGatewayService(
  api: CloudflareClient,
  state: ReadyGateway,
  binding: string,
): Promise<"unchanged" | "patched" | "uploaded"> {
  const current = await readGatewayBindings(api);
  if (!current.exists || !current.services.some((s) => s.binding === binding)) return "unchanged";
  if (current.codeVersion !== GATEWAY_CODE_VERSION) {
    await uploadGateway(
      api,
      state,
      current.services.filter((s) => s.binding !== binding),
    );
    return "uploaded";
  }
  await patchGateway(api, { [binding]: null });
  return "patched";
}

async function patchGateway(
  api: CloudflareClient,
  env: Record<string, { type: string; service: string } | null>,
): Promise<void> {
  const created = await api.versions.patchLatestVersion(GATEWAY_WORKER_NAME, {
    env,
    annotations: { "workers/message": GATEWAY_BINDING_MESSAGE },
  });
  await api.versions.createDeployment(GATEWAY_WORKER_NAME, {
    versions: [{ version_id: created.id, percentage: 100 }],
    annotations: { "workers/message": GATEWAY_BINDING_MESSAGE },
  });
}

/** Points `hostname` at `binding` in the gateway's routing table. */
export async function putGatewayRoute(
  api: CloudflareClient,
  state: ReadyGateway,
  hostname: string,
  binding: string,
): Promise<void> {
  await api.kv.putValue(state.kvId, hostname, binding);
}

/** Removes `hostname` from the gateway's routing table (a missing key is fine). */
export async function deleteGatewayRoute(
  api: CloudflareClient,
  kvId: string,
  hostname: string,
): Promise<void> {
  try {
    await api.kv.deleteValue(kvId, hostname);
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
  }
}

export interface GatewayDeps {
  db: D1Database;
  api: CloudflareClient;
  /** For the check that the gateway answers on its hostname. */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** Tries at deleting the gateway's DNS record, 2 seconds apart, while its fallback origin goes. */
export const RECORD_DELETE_ATTEMPTS = 6;

/** Fallback origin reads while it is not active yet, 2 seconds apart (it took 6 s live). */
export const FALLBACK_POLLS = 5;

/**
 * Sets the gateway up on `zoneId`, or finishes an earlier attempt. Refuses a
 * zone without Cloudflare for SaaS or without the permissions, a zone whose
 * every request already goes to another Worker, and a gateway hostname that
 * already has a DNS record which is not proxied through Cloudflare.
 */
export async function setUpGatewayCore(
  deps: GatewayDeps,
  request: { zoneId: string },
): Promise<GatewayState> {
  const orm = createDb(deps.db);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const api = deps.api;
  const stored = await readGateway(orm);
  if (stored !== null && stored.zoneId !== request.zoneId) {
    throw new GatewayError(
      `The gateway is on ${stored.zoneName}. Turn it off before moving it to another domain.`,
    );
  }
  const zone = await readGatewayZone(api, request.zoneId);
  const check = await checkZoneSaas(api, zone);
  const refusal = saasCheckMessage(check, zone.name);
  if (refusal !== null) throw new GatewayError(refusal);

  const host = gatewayHostname(zone.name);
  let state: GatewayState =
    stored ?? gatewayStateSchema.parse({ zoneId: zone.id, zoneName: zone.name });
  const save = () => saveGateway(orm, state, now());

  // The route first, as a read: a zone that already sends every request to
  // another Worker is refused before anything is created.
  const routes = await needing("Workers Routes: Edit", zone.name, () =>
    api.zones.listWorkerRoutes(zone.id),
  );
  const catchAll = routes.find((r) => r.pattern === GATEWAY_ROUTE_PATTERN);
  if (catchAll !== undefined && catchAll.script !== GATEWAY_WORKER_NAME) {
    throw new GatewayError(
      `Every request of ${zone.name} already goes to ${catchAll.script ? `the Worker "${catchAll.script}"` : "no Worker (an exclusion route)"} through the route ${GATEWAY_ROUTE_PATTERN}. Remove that route in the Cloudflare dashboard, or choose another domain.`,
    );
  }
  await save();

  if (state.recordId === null) {
    const records = await needing("DNS: Edit", zone.name, () =>
      api.zones.listDnsRecords(zone.id, { name: host }),
    );
    if (records.length > 0) {
      const proxied = records.find(
        (r) => ["A", "AAAA", "CNAME"].includes(r.type) && r.proxied === true,
      );
      if (proxied === undefined || records.some((r) => r.proxied !== true)) {
        throw new GatewayError(
          `${host} already has DNS records that are not proxied through Cloudflare (${records.map((r) => r.type).join(", ")}). Delete them in the Cloudflare dashboard, then set up the gateway again.`,
        );
      }
      state = { ...state, recordId: proxied.id, recordCreated: false };
    } else {
      const created = await needing("DNS: Edit", zone.name, () =>
        api.zones.createDnsRecord(zone.id, {
          type: "AAAA",
          name: host,
          content: "100::",
          proxied: true,
          comment: "Appflare gateway for external domains",
        }),
      );
      state = { ...state, recordId: created.id, recordCreated: true };
    }
    await save();
  }

  let fallback = await needing(SSL_PERMISSION, zone.name, () => readFallbackOrigin(api, zone.id));
  if (fallback === null) {
    fallback = await needing(SSL_PERMISSION, zone.name, () =>
      api.customHostnames.setFallbackOrigin(zone.id, host),
    );
    state = { ...state, fallbackSet: true };
    await save();
  }
  for (let poll = 0; fallback?.status !== "active" && poll < FALLBACK_POLLS; poll++) {
    await sleep(2000);
    fallback = await readFallbackOrigin(api, zone.id);
  }

  if (state.kvId === null) {
    const found = (await api.kv.listNamespaces()).find((ns) => ns.title === GATEWAY_KV_TITLE);
    const kvId = found?.id ?? (await api.kv.createNamespace(GATEWAY_KV_TITLE)).id;
    state = { ...state, kvId };
    await save();
  }
  const kvId = state.kvId as string;

  // Uploaded every time: an earlier gateway's services are kept, and its code
  // is brought up to date.
  const current = await readGatewayBindings(api);
  await uploadGateway(api, { zoneName: zone.name, kvId }, current.services);
  if (!state.workerUploaded) {
    state = { ...state, workerUploaded: true };
    await save();
  }

  if (state.routeId === null) {
    const routeId =
      catchAll?.id ??
      (
        await needing("Workers Routes: Edit", zone.name, () =>
          api.zones.createWorkerRoute(zone.id, {
            pattern: GATEWAY_ROUTE_PATTERN,
            script: GATEWAY_WORKER_NAME,
          }),
        )
      ).id;
    state = { ...state, routeId };
    await save();
  }

  state = { ...state, readyAt: state.readyAt ?? now().toISOString() };
  await save();
  return state;
}

/** The hostnames of external domains recorded on any install and not removed. */
export async function liveExternalDomains(orm: Database): Promise<string[]> {
  const rows = await orm
    .select({ name: resources.name })
    .from(resources)
    .where(and(eq(resources.kind, CUSTOM_HOSTNAME_KIND), isNull(resources.deleted_at)));
  return rows.map((r) => r.name);
}

function gone(error: unknown): boolean {
  return (
    (error instanceof CloudflareApiError && error.status === 404) ||
    codes(error).includes(FALLBACK_ORIGIN_NOT_SET)
  );
}

async function unlessGone(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (!gone(error)) throw error;
  }
}

/**
 * Removes the gateway: the route first (the zone's requests stop running the
 * Worker), then the Worker, the fallback origin and the DNS record when
 * Appflare set them, and the routing table. Refused while an app still has
 * an external domain. What is gone already counts as removed, so running it
 * again after a failure finishes the job.
 */
export async function turnOffGatewayCore(deps: GatewayDeps): Promise<void> {
  const orm = createDb(deps.db);
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let state = await readGateway(orm);
  if (state === null) return;
  const live = await liveExternalDomains(orm);
  if (live.length > 0) {
    throw new GatewayError(
      `Apps still use external domains (${live.join(", ")}). Remove them on the apps' Domains and email tabs first.`,
    );
  }
  const api = deps.api;
  const zone = state.zoneName;
  const zoneId = state.zoneId;
  const save = (next: GatewayState) => saveGateway(orm, next, now());
  if (state.routeId !== null) {
    const routeId = state.routeId;
    await needing("Workers Routes: Edit", zone, () =>
      unlessGone(() => api.zones.deleteWorkerRoute(zoneId, routeId)),
    );
    state = { ...state, routeId: null, readyAt: null };
    await save(state);
  }
  await unlessGone(() => api.workers.deleteScript(GATEWAY_WORKER_NAME, { force: true }));
  state = { ...state, workerUploaded: false };
  await save(state);
  if (state.fallbackSet) {
    await needing(SSL_PERMISSION, zone, async () => {
      // Only the fallback origin Appflare set, and only while it still points at the gateway.
      const current = await readFallbackOrigin(api, zoneId);
      if (current?.origin === gatewayHostname(zone)) {
        await unlessGone(() => api.customHostnames.deleteFallbackOrigin(zoneId));
      }
    });
    state = { ...state, fallbackSet: false };
    await save(state);
  }
  if (state.recordCreated && state.recordId !== null) {
    const recordId = state.recordId;
    // Cloudflare refuses (400) to delete the record while a fallback origin
    // that names it is still being deleted (seen live, about a second after
    // the fallback origin's delete): the record is deleted once it is gone.
    for (let attempt = 1; ; attempt++) {
      try {
        await needing("DNS: Edit", zone, () =>
          unlessGone(() => api.zones.deleteDnsRecord(zoneId, recordId)),
        );
        break;
      } catch (error) {
        const refused = error instanceof CloudflareApiError && error.status === 400;
        if (!refused || attempt >= RECORD_DELETE_ATTEMPTS) throw error;
        await sleep(2000);
      }
    }
  }
  state = { ...state, recordId: null, recordCreated: false };
  await save(state);
  if (state.kvId !== null) {
    const kvId = state.kvId;
    await unlessGone(() => api.kv.deleteNamespace(kvId));
  }
  await deleteSettings(orm, [SETTING.externalDomainsGateway]);
}

export interface GatewayView {
  /** The gateway, when one is set up or half set up. */
  gateway: {
    zoneId: string;
    zoneName: string;
    /** Where external domains point their CNAME. */
    hostname: string;
    ready: boolean;
    readyAt: string | null;
    /** Cloudflare for SaaS on the zone, as checked now. */
    check: ZoneSaasCheck;
    /** Whether the gateway answered on its hostname just now; null when not asked. */
    answering: boolean | null;
    /** External domains recorded on apps. */
    domains: string[];
  } | null;
  /** Active zones of the account to choose from; null when the token may not list them. */
  zones: Array<{ id: string; name: string }> | null;
  accountId: string;
}

/** Settings > Domains: the gateway and its health, or the zones to put it on. */
export async function getGatewayViewCore(deps: GatewayDeps): Promise<GatewayView> {
  const orm = createDb(deps.db);
  const state = await readGateway(orm);
  const api = deps.api;
  if (state === null) {
    const listed = await listAccountZones(api);
    return {
      gateway: null,
      zones: listed === null ? null : listed.active.map((z) => ({ id: z.id, name: z.name })),
      accountId: api.accountId,
    };
  }
  const hostname = gatewayHostname(state.zoneName);
  const [check, domains, answering] = await Promise.all([
    checkZoneSaas(api, { id: state.zoneId, name: state.zoneName }),
    liveExternalDomains(orm),
    isGatewayReady(state) && deps.fetch !== undefined
      ? gatewayAnswers(deps.fetch, hostname)
      : Promise.resolve(null),
  ]);
  return {
    gateway: {
      zoneId: state.zoneId,
      zoneName: state.zoneName,
      hostname,
      ready: isGatewayReady(state),
      readyAt: state.readyAt,
      check,
      answering,
      domains,
    },
    zones: null,
    accountId: api.accountId,
  };
}

/** Whether the gateway Worker answers on its own hostname (one request, 10 s at most). */
export async function gatewayAnswers(fetchImpl: FetchLike, hostname: string): Promise<boolean> {
  try {
    const response = await fetchImpl(`https://${hostname}/`, {
      signal: AbortSignal.timeout(10_000),
      headers: { "user-agent": "Appflare gateway check" },
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { service?: unknown };
    return body.service === GATEWAY_WORKER_NAME;
  } catch {
    return false;
  }
}

/** Settings > Domains, before setting up: whether the chosen zone can be the gateway. */
export async function checkGatewayZoneCore(
  deps: GatewayDeps,
  request: { zoneId: string },
): Promise<ZoneSaasCheck & { zoneName: string }> {
  const zone = await readGatewayZone(deps.api, request.zoneId);
  return { ...(await checkZoneSaas(deps.api, zone)), zoneName: zone.name };
}
