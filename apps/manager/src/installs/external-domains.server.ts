import {
  CloudflareApiError,
  type CloudflareClient,
  CUSTOM_HOSTNAME_DUPLICATE,
  type CustomHostname,
  type FetchLike,
} from "@appflare/cf-api";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { ulid } from "ulidx";
import { createDb } from "../db/client";
import { installs, resources } from "../db/schema";
import {
  checkExternalHostname,
  GATEWAY_SETUP_PLACE,
  gatewayBindingName,
  gatewayHostname,
  type OwnerRecord,
  type ValidationMethod,
} from "../gateway/gateway";
import {
  bindGatewayService,
  deleteGatewayRoute,
  GatewayError,
  isGatewayReady,
  putGatewayRoute,
  type ReadyGateway,
  readGateway,
  SSL_PERMISSION,
  saasCheckMessage,
  saasRefusal,
  unbindGatewayService,
} from "../gateway/gateway.server";
import { healthCheckOfManifest, probeHealth, settleHealthProbe } from "../jobs/install/health";
import { listAccountZones } from "./custom-domains.server";
import type { ExternalDomainOptions, ExternalDomainStatus } from "./external-domain-input";
import { ADDRESS_KINDS, CUSTOM_HOSTNAME_KIND } from "./resource-kinds";
import {
  NO_VARS_REFRESH,
  type RefreshVars,
  refreshSettings,
  type VarsRefresh,
} from "./vars-refresh.server";
import { WILDCARD_EXTERNAL_REFUSAL, wildcardOfManifest } from "./wildcard-domain-input";
import {
  applyDomainLive,
  beforeDomainRemoval,
  domainIsLive,
  recordDomainLive,
  WorkersDevError,
} from "./workers-dev.server";

/**
 * External domains of an install (gateway/gateway.ts explains the path a
 * request takes). Adding one creates a custom hostname on the gateway zone,
 * gives the gateway a service binding to the install's Worker (one per
 * install, shared by its external domains), and points the hostname at that
 * binding in the gateway's routing table; it is recorded as a resource of
 * kind `custom_hostname` (name = hostname, cf_id = `<zone id>/<custom
 * hostname id>`, binding = the gateway's binding). Removing one undoes the
 * three, the binding only with the install's last external domain. Adding,
 * removing and reading the status run in the request (a few calls each).
 */

export class ExternalDomainError extends Error {
  override name = "ExternalDomainError";
}

export interface ExternalDomainDeps {
  db: D1Database;
  api: CloudflareClient;
  /** For the probe through the domain. */
  fetch?: FetchLike;
  now?: () => Date;
  newId?: () => string;
  /** Deploys the settings again when they use the app's address; without it nothing is. */
  refreshVars?: RefreshVars;
}

/** `cf_id` of an external domain: which zone the custom hostname is on, and its id. */
export function externalDomainRef(zoneId: string, customHostnameId: string): string {
  return `${zoneId}/${customHostnameId}`;
}

export function parseExternalDomainRef(
  cfId: string | null,
): { zoneId: string; customHostnameId: string } | null {
  if (cfId === null) return null;
  const [zoneId, customHostnameId, ...rest] = cfId.split("/");
  if (!zoneId || !customHostnameId || rest.length > 0) return null;
  return { zoneId, customHostnameId };
}

function isMethod(value: string | undefined): value is ValidationMethod {
  return value === "http" || value === "txt";
}

/**
 * The records the domain's owner adds, from Cloudflare's answer: with TXT
 * validation the ownership record and the certificate's `_acme-challenge`
 * records first, then the CNAME that moves traffic; with CNAME validation
 * only the CNAME, which also lets Cloudflare validate both.
 */
export function ownerRecords(ch: CustomHostname, target: string): OwnerRecord[] {
  const records: OwnerRecord[] = [];
  const method = ch.ssl?.method;
  if (method === "txt") {
    const own = ch.ownership_verification;
    if (ch.status !== "active" && own?.name && own.value) {
      records.push({
        type: "TXT",
        name: own.name,
        value: own.value,
        purpose: "Proves the name is yours before any traffic moves.",
      });
    }
    if (ch.ssl?.status !== "active") {
      for (const r of ch.ssl?.validation_records ?? []) {
        if (r.txt_name && r.txt_value) {
          records.push({
            type: "TXT",
            name: r.txt_name,
            value: r.txt_value,
            purpose: "Lets the certificate be issued before any traffic moves.",
          });
        }
      }
    }
    records.push({
      type: "CNAME",
      name: ch.hostname,
      value: target,
      purpose:
        "Sends visitors to the app. Change it once the domain shows Active; until then the name keeps serving what it serves now.",
    });
    return records;
  }
  records.push({
    type: "CNAME",
    name: ch.hostname,
    value: target,
    purpose:
      "Sends visitors to the app and lets Cloudflare validate the name and issue its certificate. DNS only is recommended; a proxied record from another Cloudflare account works too.",
  });
  return records;
}

/** What the app page shows of a custom hostname. */
export function externalDomainStatus(
  ch: CustomHostname,
  target: string,
  checkedAt: Date,
): ExternalDomainStatus {
  const sslStatus = ch.ssl?.status ?? null;
  const active = ch.status === "active" && sslStatus === "active";
  return {
    hostname: ch.hostname,
    status: ch.status,
    sslStatus,
    method: isMethod(ch.ssl?.method) ? ch.ssl.method : "http",
    active,
    records: active ? [] : ownerRecords(ch, target),
    errors: active
      ? []
      : [
          ...(ch.verification_errors ?? []),
          ...(ch.ssl?.validation_errors ?? []).map((e) => e.message),
        ],
    health: null,
    checkedAt: checkedAt.toISOString(),
  };
}

/** A refused custom hostname call, as a message that says what to do. */
function explainRefusal(error: unknown, zoneName: string): never {
  const refusal = saasRefusal(error);
  if (refusal === "saas-off") {
    throw new ExternalDomainError(
      saasCheckMessage({ kind: "saas-off", dashboardUrl: "" }, zoneName) ?? "",
    );
  }
  if (refusal === "missing-permission") {
    throw new ExternalDomainError(
      saasCheckMessage({ kind: "missing-permission", permission: SSL_PERMISSION }, zoneName) ?? "",
    );
  }
  throw error;
}

export interface AttachExternalDomainInput {
  gateway: ReadyGateway;
  installId: string;
  workerName: string;
  hostname: string;
  method: ValidationMethod;
  /**
   * When this install claimed the hostname (its `resources` row, epoch ms). A
   * custom hostname already on the gateway zone is taken over only when
   * Cloudflare made it after this, so it can only be an earlier attempt of
   * the same add; one that was there before is refused.
   */
  claimedAt: number;
}

export interface AttachedExternalDomain {
  hostname: string;
  zoneId: string;
  customHostnameId: string;
  binding: string;
  /** This call created the custom hostname (else an earlier attempt of the same add did). */
  created: boolean;
  customHostname: CustomHostname;
}

/** Clock skew allowed between the manager and Cloudflare when comparing creation times. */
export const CLAIM_SKEW_MS = 60_000;

/** Whether Cloudflare made the custom hostname after the install claimed the name. */
export function madeAfterClaim(ch: CustomHostname, claimedAt: number): boolean {
  const made = ch.created_at === undefined ? Number.NaN : Date.parse(ch.created_at);
  return !Number.isNaN(made) && made >= claimedAt - CLAIM_SKEW_MS;
}

/**
 * The names of every zone of the account, including the gateway zone. A token
 * that cannot list zones, or lists only some (the gateway zone is missing),
 * cannot tell whether a hostname belongs to the account, so the hostname is
 * refused rather than let through.
 */
async function accountZoneNames(
  api: CloudflareClient,
  gateway: ReadyGateway,
  hostname: string,
): Promise<string[]> {
  const zones = await listAccountZones(api);
  const all = zones === null ? [] : [...zones.active, ...zones.inactive];
  if (!all.some((z) => z.id === gateway.zoneId)) {
    throw new ExternalDomainError(
      `Appflare cannot list every domain of this account, so it cannot tell whether ${hostname} belongs to one of them (then it would be a custom domain). The token needs Zone: Read on all zones of the account; add it in the Cloudflare dashboard, then try again.`,
    );
  }
  return all.map((z) => z.name);
}

/**
 * Creates the custom hostname, binds the gateway to the Worker, and routes the
 * hostname to that binding. A custom hostname already on the gateway zone is
 * taken over only when it was made after this install claimed the name (a
 * retried attempt of the same add); otherwise, and when the routing table
 * already sends the hostname to another app, the hostname is refused. What
 * this call created is removed again when a later call fails. Shared by the
 * app page and the install job's domain step.
 */
export async function attachExternalDomain(
  api: CloudflareClient,
  input: AttachExternalDomainInput,
): Promise<AttachedExternalDomain> {
  const { gateway } = input;
  const format = checkExternalHostname(input.hostname, { gateway: gateway.zoneName, account: [] });
  if (!format.ok) throw new ExternalDomainError(format.error);
  const checked = checkExternalHostname(input.hostname, {
    gateway: gateway.zoneName,
    account: await accountZoneNames(api, gateway, format.hostname),
  });
  if (!checked.ok) throw new ExternalDomainError(checked.error);
  const hostname = checked.hostname;
  const binding = gatewayBindingName(input.installId);

  const routed = await api.kv.getValue(gateway.kvId, hostname);
  if (routed !== null && routed !== binding) {
    throw new ExternalDomainError(
      `${hostname} is already routed to another app by the gateway. Remove it from that app first.`,
    );
  }

  let existing: CustomHostname | undefined;
  try {
    existing = (await api.customHostnames.list(gateway.zoneId, { hostname })).find(
      (ch) => ch.hostname.toLowerCase() === hostname,
    );
  } catch (error) {
    explainRefusal(error, gateway.zoneName);
  }
  let customHostname: CustomHostname;
  let created = false;
  if (existing !== undefined) {
    if (!madeAfterClaim(existing, input.claimedAt)) {
      throw new ExternalDomainError(
        `${hostname} is already a custom hostname of ${gateway.zoneName}, made outside this app (in the Cloudflare dashboard, or by an app that no longer records it). Appflare does not take it over; delete it in the dashboard (${gateway.zoneName}, SSL/TLS, Custom Hostnames) or choose another name.`,
      );
    }
    customHostname = existing;
  } else {
    try {
      customHostname = await api.customHostnames.create(gateway.zoneId, {
        hostname,
        sslMethod: input.method,
      });
      created = true;
    } catch (error) {
      if (
        error instanceof CloudflareApiError &&
        error.errors.some((e) => e.code === CUSTOM_HOSTNAME_DUPLICATE)
      ) {
        throw new ExternalDomainError(
          `${hostname} is already an external domain of another Cloudflare zone (Cloudflare for SaaS on another account or domain). Remove it there first.`,
        );
      }
      explainRefusal(error, gateway.zoneName);
    }
  }

  try {
    await bindGatewayService(api, gateway, { binding, service: input.workerName });
    await putGatewayRoute(api, gateway, hostname, binding);
  } catch (error) {
    if (created) {
      await api.customHostnames.delete(gateway.zoneId, customHostname.id).catch(() => undefined);
    }
    throw error;
  }
  return {
    hostname,
    zoneId: gateway.zoneId,
    customHostnameId: customHostname.id,
    binding,
    // Taken over only when made after the claim: an earlier attempt of this add made it.
    created: true,
    customHostname,
  };
}

/** What removing an external domain did at Cloudflare. */
export type ExternalDetachOutcome = "removed" | "gone" | "left";

export interface DetachExternalDomainInput {
  hostname: string;
  /** `<zone id>/<custom hostname id>`; null when the add stopped before Cloudflare answered. */
  cfId: string | null;
  /** The gateway's binding the routing entry names; null when unknown. */
  binding: string | null;
  /** When the install claimed the name (its row's `created_at`, epoch ms). */
  claimedAt: number;
}

/**
 * Deletes the custom hostname Appflare created for the domain (visitors get an
 * error page at once) and its routing entry. A recorded id is one Appflare
 * created. Without one (an add that stopped before Cloudflare answered), the
 * hostname is looked up on the gateway zone and deleted only when it was made
 * after the claim; one made before is someone else's and is left (`left`).
 * The routing entry is removed only while it names this binding. The
 * gateway's binding itself is removed separately ({@link unbindGatewayService}),
 * with the install's last external domain.
 */
export async function detachExternalDomain(
  api: CloudflareClient,
  gateway: { zoneId: string; kvId: string | null } | null,
  domain: DetachExternalDomainInput,
): Promise<ExternalDetachOutcome> {
  let ref = parseExternalDomainRef(domain.cfId);
  let outcome: ExternalDetachOutcome = "gone";
  if (ref === null && gateway !== null) {
    const found = (
      await api.customHostnames.list(gateway.zoneId, { hostname: domain.hostname })
    ).find((ch) => ch.hostname.toLowerCase() === domain.hostname);
    if (found !== undefined) {
      if (madeAfterClaim(found, domain.claimedAt)) {
        ref = { zoneId: gateway.zoneId, customHostnameId: found.id };
      } else {
        outcome = "left";
      }
    }
  }
  if (ref !== null) {
    try {
      await api.customHostnames.delete(ref.zoneId, ref.customHostnameId);
      outcome = "removed";
    } catch (error) {
      if (!(error instanceof CloudflareApiError && error.status === 404)) throw error;
    }
  }
  if (gateway?.kvId && domain.binding !== null) {
    const routed = await api.kv.getValue(gateway.kvId, domain.hostname);
    if (routed === domain.binding) await deleteGatewayRoute(api, gateway.kvId, domain.hostname);
  }
  return outcome;
}

/** One log line for an {@link ExternalDetachOutcome}. */
export function externalDetachMessage(hostname: string, outcome: ExternalDetachOutcome): string {
  switch (outcome) {
    case "removed":
      return `Removed external domain ${hostname}.`;
    case "gone":
      return `External domain ${hostname} was already gone at Cloudflare.`;
    case "left":
      return `The custom hostname ${hostname} on the gateway domain was not made by this app, so it was left alone; its routing to this app was removed.`;
  }
}

/** The add dialog's and install form's check data: the gateway, and the account's zones. */
export async function getExternalDomainOptionsCore(deps: {
  db: D1Database;
  api: CloudflareClient;
}): Promise<ExternalDomainOptions> {
  const gateway = await readGateway(createDb(deps.db));
  if (!isGatewayReady(gateway)) return { gateway: null, accountZones: [] };
  const zones = await listAccountZones(deps.api);
  return {
    gateway: { zoneName: gateway.zoneName, hostname: gatewayHostname(gateway.zoneName) },
    accountZones: zones === null ? [] : [...zones.active, ...zones.inactive].map((z) => z.name),
  };
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
  if (row === undefined) throw new ExternalDomainError("There is no such install.");
  return row;
}

/** Runs `run`, reporting a workers.dev refusal as an external domain one. */
async function asExternalDomainError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkersDevError) throw new ExternalDomainError(error.message);
    throw error;
  }
}

async function readDomain(db: D1Database, request: { installId: string; resourceId: string }) {
  const [row] = await createDb(db)
    .select()
    .from(resources)
    .where(
      and(
        eq(resources.id, request.resourceId),
        eq(resources.install_id, request.installId),
        eq(resources.kind, CUSTOM_HOSTNAME_KIND),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  if (row === undefined)
    throw new ExternalDomainError("That is not an external domain of this app.");
  return row;
}

async function readyGateway(db: D1Database): Promise<ReadyGateway> {
  const gateway = await readGateway(createDb(db));
  if (!isGatewayReady(gateway)) {
    throw new ExternalDomainError(
      `External domains need the gateway. Set it up in ${GATEWAY_SETUP_PLACE} first.`,
    );
  }
  return gateway;
}

export type ExternalDomainClaim =
  | { kind: "claimed"; id: string; claimedAt: number }
  /** This install already records the name (a retried add), or recorded it before. */
  | { kind: "mine"; id: string; claimedAt: number; complete: boolean }
  | { kind: "taken"; installId: string }
  | { kind: "uninstalling" };

/**
 * Claims `hostname` for the install before anything is created at Cloudflare:
 * a `custom_hostname` row without an id yet, inserted only while no install
 * records the name as a custom or external domain and the install is not
 * being uninstalled (one statement, so two adds cannot both win). A row this
 * install already has is returned instead, so a retried add continues it.
 */
export async function claimExternalDomain(
  db: D1Database,
  request: { id: string; installId: string; hostname: string; binding: string; at: Date },
): Promise<ExternalDomainClaim> {
  const [held] = await createDb(db)
    .select({
      id: resources.id,
      installId: resources.install_id,
      kind: resources.kind,
      cfId: resources.cf_id,
      createdAt: resources.created_at,
    })
    .from(resources)
    .where(
      and(
        inArray(resources.kind, [...ADDRESS_KINDS]),
        eq(resources.name, request.hostname),
        isNull(resources.deleted_at),
      ),
    )
    .limit(1);
  if (held !== undefined) {
    return held.installId === request.installId && held.kind === CUSTOM_HOSTNAME_KIND
      ? {
          kind: "mine",
          id: held.id,
          claimedAt: held.createdAt.getTime(),
          complete: held.cfId !== null,
        }
      : { kind: "taken", installId: held.installId };
  }
  const inserted = await db
    .prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       SELECT ?1, ?2, '${CUSTOM_HOSTNAME_KIND}', ?3, ?4, NULL, ?5
       WHERE EXISTS (
         SELECT 1 FROM installs WHERE id = ?2 AND status NOT IN ('uninstalling', 'uninstalled')
       )
       AND NOT EXISTS (
         SELECT 1 FROM resources
         WHERE name = ?4 AND kind IN (${ADDRESS_KINDS.map((k) => `'${k}'`).join(", ")})
           AND deleted_at IS NULL
       )`,
    )
    .bind(request.id, request.installId, request.binding, request.hostname, request.at.getTime())
    .run();
  if (inserted.meta.changes === 1) {
    return { kind: "claimed", id: request.id, claimedAt: request.at.getTime() };
  }
  const [install] = await createDb(db)
    .select({ status: installs.status })
    .from(installs)
    .where(eq(installs.id, request.installId))
    .limit(1);
  if (
    install === undefined ||
    install.status === "uninstalling" ||
    install.status === "uninstalled"
  ) {
    return { kind: "uninstalling" };
  }
  // Another add claimed the name between the read and the insert.
  return claimExternalDomain(db, request);
}

/** Stores the custom hostname's id on a claimed row. */
export async function completeExternalDomain(
  db: D1Database,
  rowId: string,
  attached: AttachedExternalDomain,
): Promise<void> {
  await createDb(db)
    .update(resources)
    .set({ cf_id: externalDomainRef(attached.zoneId, attached.customHostnameId) })
    .where(eq(resources.id, rowId));
}

/** Gives up a claim nothing was created for. */
export async function releaseExternalDomain(
  db: D1Database,
  rowId: string,
  at: Date,
): Promise<void> {
  await createDb(db).update(resources).set({ deleted_at: at }).where(eq(resources.id, rowId));
}

/** Why a hostname cannot be claimed, for the admin. */
export function claimRefusal(
  hostname: string,
  claim: ExternalDomainClaim,
  installId: string,
): string | null {
  if (claim.kind === "taken") {
    return claim.installId === installId
      ? `${hostname} is already a domain of this app.`
      : `${hostname} is already a domain of another app. Remove it there first.`;
  }
  if (claim.kind === "uninstalling") return "The app is being uninstalled.";
  return null;
}

/** The `resources` id of a new external domain of `installId`. */
export function externalDomainResourceId(installId: string, id: string): string {
  return `${installId}:${CUSTOM_HOSTNAME_KIND}:${id}`;
}

export async function addExternalDomainCore(
  deps: ExternalDomainDeps,
  request: { installId: string; hostname: string; validation: ValidationMethod },
): Promise<{ resourceId: string; status: ExternalDomainStatus }> {
  const now = deps.now ?? (() => new Date());
  const install = await readInstall(deps.db, request.installId);
  if (install.status !== "installed") {
    throw new ExternalDomainError(
      `An external domain can be added only to an installed app; this one is ${install.status}.`,
    );
  }
  if (wildcardOfManifest(install.manifestJson) !== null) {
    throw new ExternalDomainError(WILDCARD_EXTERNAL_REFUSAL);
  }
  const gateway = await readyGateway(deps.db);
  // The name as Cloudflare and every check see it (lower case, Punycode).
  const format = checkExternalHostname(request.hostname, {
    gateway: gateway.zoneName,
    account: [],
  });
  if (!format.ok) throw new ExternalDomainError(format.error);
  const hostname = format.hostname;
  const claim = await claimExternalDomain(deps.db, {
    id: externalDomainResourceId(install.id, (deps.newId ?? (() => ulid()))()),
    installId: install.id,
    hostname,
    binding: gatewayBindingName(install.id),
    at: now(),
  });
  const refusal = claimRefusal(hostname, claim, install.id);
  if (refusal !== null) throw new ExternalDomainError(refusal);
  if (claim.kind === "mine" && claim.complete) {
    throw new ExternalDomainError(`${hostname} is already a domain of this app.`);
  }
  if (claim.kind !== "claimed" && claim.kind !== "mine") throw new ExternalDomainError(hostname);
  let attached: AttachedExternalDomain;
  try {
    attached = await attachExternalDomain(deps.api, {
      gateway,
      installId: install.id,
      workerName: install.workerName,
      hostname,
      method: request.validation,
      claimedAt: claim.claimedAt,
    });
  } catch (error) {
    // A refusal created nothing; any other failure may have (an answer lost on
    // the way back), so the claim stays and Remove cleans up after it.
    if (error instanceof ExternalDomainError || error instanceof GatewayError) {
      await releaseExternalDomain(deps.db, claim.id, now());
    }
    throw error;
  }
  await completeExternalDomain(deps.db, claim.id, attached);
  return {
    resourceId: claim.id,
    status: externalDomainStatus(attached.customHostname, gatewayHostname(gateway.zoneName), now()),
  };
}

/**
 * The domain's state as Cloudflare reports it now (one call), with the
 * records its owner still has to add; with `probe`, once it is active, one
 * request to the app through it. When the app answers, the domain is
 * recorded as live and, with `applyDefaults` (an admin is looking),
 * workers.dev may be turned off (`applyDomainLive`). So does Cloudflare
 * Access answering on the domain (`domainIsLive`).
 */
export async function externalDomainStatusCore(
  deps: ExternalDomainDeps,
  request: { installId: string; resourceId: string; probe?: boolean; applyDefaults?: boolean },
): Promise<ExternalDomainStatus> {
  const now = deps.now ?? (() => new Date());
  const install = await readInstall(deps.db, request.installId);
  const domain = await readDomain(deps.db, request);
  const ref = parseExternalDomainRef(domain.cf_id);
  const gateway = await readGateway(createDb(deps.db));
  const target = gatewayHostname(gateway?.zoneName ?? "");
  const missing: ExternalDomainStatus = {
    hostname: domain.name,
    status: "missing",
    sslStatus: null,
    method: "http",
    active: false,
    records: [],
    errors: [
      "Cloudflare has no custom hostname for this domain any more. Remove it here and add it again.",
    ],
    health: null,
    checkedAt: now().toISOString(),
  };
  if (ref === null) return missing;
  let ch: CustomHostname;
  try {
    ch = await deps.api.customHostnames.get(ref.zoneId, ref.customHostnameId);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) return missing;
    explainRefusal(error, gateway?.zoneName ?? "the gateway domain");
  }
  const status = externalDomainStatus(ch, target, now());
  if (request.probe === true && status.active && deps.fetch !== undefined) {
    const check = healthCheckOfManifest(install.manifestJson);
    const url = `https://${domain.name}${check.path}`;
    const probe = await probeHealth(deps.fetch, url);
    const settled = settleHealthProbe(probe, check.mode);
    status.health = { ...settled, url };
    if (domainIsLive(probe, check.mode)) {
      if (request.applyDefaults === true) {
        const applied = await asExternalDomainError(() =>
          applyDomainLive(
            {
              db: deps.db,
              api: async () => deps.api,
              ...(deps.now === undefined ? {} : { now: deps.now }),
              ...(deps.refreshVars === undefined ? {} : { refreshVars: deps.refreshVars }),
            },
            { installId: install.id, resourceId: domain.id, hostname: domain.name },
          ),
        );
        status.workersDevTurnedOff = applied.turnedOff;
        status.settingsJobId = applied.settingsJobId;
        status.settingsNote = applied.settingsNote;
      } else {
        await recordDomainLive(deps.db, domain.id, deps.now);
      }
    }
  }
  return status;
}

/**
 * Removes the external domain and marks it deleted; with the install's last
 * one, the gateway's binding to its Worker too. While an uninstall runs, the
 * uninstall removes it.
 */
export async function removeExternalDomainCore(
  deps: ExternalDomainDeps,
  request: { installId: string; resourceId: string },
): Promise<{ hostname: string } & VarsRefresh> {
  const orm = createDb(deps.db);
  const install = await readInstall(deps.db, request.installId);
  if (install.status === "uninstalling" || install.status === "uninstalled") {
    throw new ExternalDomainError("The uninstall removes this app's external domains.");
  }
  const domain = await readDomain(deps.db, request);
  const others = await orm
    .select({ id: resources.id, kind: resources.kind })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, request.installId),
        inArray(resources.kind, [...ADDRESS_KINDS]),
        isNull(resources.deleted_at),
        ne(resources.id, domain.id),
      ),
    );
  // With workers.dev off, the last live domain is the app's only address.
  const removal = await asExternalDomainError(() =>
    beforeDomainRemoval(
      { db: deps.db, api: async () => deps.api },
      { installId: request.installId, resourceId: domain.id },
    ),
  );
  const gateway = await readGateway(orm);
  await detachExternalDomain(deps.api, gateway, {
    hostname: domain.name,
    cfId: domain.cf_id,
    binding: domain.binding,
    claimedAt: domain.created_at.getTime(),
  });
  const lastExternal = !others.some((o) => o.kind === CUSTOM_HOSTNAME_KIND);
  if (lastExternal && domain.binding !== null && isGatewayReady(gateway)) {
    await unbindGatewayService(deps.api, gateway, domain.binding);
  }
  await orm
    .update(resources)
    .set({ deleted_at: (deps.now ?? (() => new Date()))() })
    .where(eq(resources.id, domain.id));
  // The app's address moved: settings that use `{{appUrl}}` follow it.
  const refresh = removal.addressChanged
    ? await refreshSettings(deps.refreshVars, request.installId, ["appUrl"])
    : NO_VARS_REFRESH;
  return { hostname: domain.name, ...refresh };
}
