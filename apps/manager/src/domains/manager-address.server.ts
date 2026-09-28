import type { CloudflareClient, FetchLike } from "@appflare/cf-api";
import { type AccessConfig, readAccessConfig } from "../access/config";
import { accessGate } from "../access/gate";
import {
  AccessToggleError,
  checkAccessMove,
  moveAccessApps,
  withAccessLock,
} from "../access/toggle.server";
import { safeReturnPath } from "../components/internal-path";
import { settingsLink } from "../components/settings-links";
import { createDb } from "../db/client";
import { readSettings, SETTING, type SettingKey } from "../db/settings";
import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";
import { gatewayHostname } from "../gateway/gateway";
import { checkHostnameInZone } from "../installs/custom-domain-input";
import {
  attachCheckedDomain,
  type ConflictingRecord,
  CustomDomainError,
  type DetachOutcome,
  type DomainOptions,
  detachCustomDomain,
  getDomainOptionsCore,
  readZone,
} from "../installs/custom-domains.server";
import { distinctLabels } from "../installs/display-name";
import { readInstallNames } from "../installs/install-names.server";
import {
  type HealthProbe,
  LIVE_HEALTH_WINDOW_MS,
  liveHealthDelaySeconds,
  liveHealthScheduledMs,
  probeHealth,
} from "../jobs/install/health";
import { emitEvent, readChannels } from "../notifications/outbox.server";
import { addressRedirect } from "./address-redirect";
import { MANAGER_URL_KEY } from "./manager-origin.server";

/**
 * Appflare's own address: the custom domain the manager lives on, or its
 * workers.dev address while it has none. Moving attaches a hostname in one
 * of the account's zones to the manager's own Worker (the same checks as an
 * app's custom domain), waits until that hostname answers as this manager,
 * and only then switches: the settings rows, Cloudflare Access, the passkey
 * bookkeeping. From then on the workers.dev address redirects page requests
 * to the custom domain (address-redirect.ts), and links in notifications
 * use it (manager-origin.server.ts).
 *
 * Each operation runs in the request, like an app's custom domains: a
 * handful of Cloudflare API calls and a bounded wait for the new hostname.
 * One runs at a time (a `settings` lock).
 */

export class ManagerAddressError extends Error {
  override name = "ManagerAddressError";
}

export interface ManagerAddressDeps {
  db: D1Database;
  api: CloudflareClient;
  /** Fetches the new hostname's health endpoint. */
  fetch: FetchLike;
  /** The version this manager runs, which the new hostname must report. */
  version: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const ADDRESS_KEYS = [
  SETTING.managerHostname,
  SETTING.managerDomainId,
  SETTING.managerZoneId,
  SETTING.managerPreviousHostname,
  SETTING.managerMovedAt,
] as const satisfies readonly SettingKey[];

const LOCK_KEY = "manager_address_lock";
/** Longer than the wait for the new hostname plus the calls around it. */
const LOCK_TTL_MS = 5 * 60_000;

export const ADDRESS_MESSAGES = {
  busy: "Appflare's address is already being changed. Try again in a minute.",
  noWorkerName:
    "Appflare does not know its own Worker name yet. Save the Cloudflare token under Your account first.",
  alreadyMoved: (hostname: string) =>
    `Appflare already lives at ${hostname}. Use Change to move it to another address.`,
  notMoved: "Appflare lives at its workers.dev address. Choose a domain to move it there.",
  sameAddress: (hostname: string) => `Appflare already lives at ${hostname}.`,
  gateway: (hostname: string) =>
    `${hostname} is the external domains gateway's own hostname. Choose another name.`,
  usedByApp: (hostname: string, app: string) =>
    `${hostname} already serves the app ${app}. Remove it from that app first, or choose another name.`,
  noSubdomain:
    "Appflare could not find this account's workers.dev subdomain, so it cannot tell its workers.dev address.",
  notServing: (
    hostname: string,
    seconds: number,
    last: string,
    stays: string,
    domain: UndoOutcome,
  ) =>
    `${hostname} did not answer as this Appflare within ${seconds} seconds (last answer: ${last}). Appflare stays at ${stays}. ${UNDO_SENTENCES[domain](hostname)} A new domain's certificate can take a few minutes; try again shortly.`,
} as const;

/** What became of the new domain after a move that did not complete. */
export type UndoOutcome = "detached" | "detach-failed" | "kept-replaced-records" | "kept-by-hand";

const UNDO_SENTENCES: Record<UndoOutcome, (hostname: string) => string> = {
  detached: () => "Appflare removed the domain again.",
  "detach-failed": (hostname) =>
    `Appflare could not remove ${hostname} again; it stays attached, and trying again uses it.`,
  "kept-replaced-records": (hostname) =>
    `${hostname} stays attached to Appflare so you can try again: the DNS records it replaced are gone, and Appflare cannot put them back.`,
  "kept-by-hand": (hostname) =>
    `${hostname} stays attached to Appflare's Worker, as it was before.`,
};

/**
 * `manager_domain_attached_by:<hostname>`: who attached a custom domain that
 * Appflare is moving to, written as soon as it is attached and deleted once
 * the move completes or the domain is detached again. A move that does not
 * complete reads it to decide whether to detach the domain, also on a later
 * try after a detach that failed or a request that was cancelled:
 * - `appflare`: Appflare attached it, so it detaches it again;
 * - `appflare-replaced-records`: Appflare attached it in place of DNS
 *   records, which detaching cannot restore, so it stays attached;
 * - `hand`: it served Appflare's Worker before, so it stays attached.
 */
const ATTACHED_BY_PREFIX = "manager_domain_attached_by:";
type AttachedBy = "appflare" | "appflare-replaced-records" | "hand";

async function readAttachedBy(db: D1Database, hostname: string): Promise<AttachedBy | null> {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(`${ATTACHED_BY_PREFIX}${hostname}`)
    .first<{ value: string }>();
  const value = row?.value;
  return value === "appflare" || value === "appflare-replaced-records" || value === "hand"
    ? value
    : null;
}

function writeAttachedBy(db: D1Database, hostname: string, by: AttachedBy, now: Date) {
  return upsertStatement(db, `${ATTACHED_BY_PREFIX}${hostname}`, by, now).run();
}

function deleteAttachedBy(db: D1Database, hostname: string) {
  return db
    .prepare("DELETE FROM settings WHERE key = ?1")
    .bind(`${ATTACHED_BY_PREFIX}${hostname}`)
    .run();
}

/** The rows as stored; every field null while Appflare lives at workers.dev. */
interface AddressRows {
  hostname: string | null;
  domainId: string | null;
  zoneId: string | null;
  previousHostname: string | null;
  movedAt: string | null;
}

async function readAddressRows(db: D1Database): Promise<AddressRows> {
  const s = await readSettings(createDb(db), ADDRESS_KEYS);
  return {
    hostname: s.manager_hostname || null,
    domainId: s.manager_domain_id || null,
    zoneId: s.manager_zone_id || null,
    previousHostname: s.manager_previous_hostname || null,
    movedAt: s.manager_moved_at || null,
  };
}

async function readWorkerName(db: D1Database): Promise<string> {
  const { worker_name: workerName } = await readSettings(createDb(db), [SETTING.workerName]);
  if (!workerName) throw new ManagerAddressError(ADDRESS_MESSAGES.noWorkerName);
  return workerName;
}

/**
 * `<worker>.<subdomain>.workers.dev`. The subdomain is cached in `settings`;
 * without it, one call reads it (and caches it).
 */
async function workersDevHostname(
  deps: Pick<ManagerAddressDeps, "db" | "api">,
  workerName: string,
) {
  const orm = createDb(deps.db);
  let { account_subdomain: subdomain } = await readSettings(orm, [SETTING.accountSubdomain]);
  if (!subdomain) {
    subdomain = (await deps.api.workers.getAccountSubdomain()).subdomain;
    if (!subdomain) throw new ManagerAddressError(ADDRESS_MESSAGES.noSubdomain);
    await deps.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(SETTING.accountSubdomain, subdomain, Date.now())
      .run();
  }
  return `${workerName}.${subdomain}.workers.dev`.toLowerCase();
}

/** A custom domain serving the manager's Worker. */
export interface ServingDomain {
  hostname: string;
  zoneId: string;
  zoneName: string;
}

export interface ManagerAddress {
  /** The custom domain Appflare lives on; null while it lives at workers.dev. */
  hostname: string | null;
  zoneId: string | null;
  /** The hostname it lived at before the last move (its workers.dev address, or a custom domain). */
  previousHostname: string | null;
  /** ISO 8601 time of the last move; null at workers.dev. */
  movedAt: string | null;
  /** `<worker>.<subdomain>.workers.dev`; null when the subdomain is not known yet. */
  workersDevHostname: string | null;
  /**
   * Whether the custom domain still serves the manager's Worker (Cloudflare's
   * list of its domains); null at workers.dev.
   */
  serving: boolean | null;
  /**
   * Custom domains that serve the manager's Worker but are not its address:
   * attached by hand in the Cloudflare dashboard. Any of them can become
   * Appflare's address.
   */
  attachedByHand: ServingDomain[];
}

/** Appflare's address as stored, checked against Cloudflare's list of the Worker's domains. One call. */
export async function readManagerAddress(
  deps: Pick<ManagerAddressDeps, "db" | "api">,
): Promise<ManagerAddress> {
  const workerName = await readWorkerName(deps.db);
  const rows = await readAddressRows(deps.db);
  const { account_subdomain: subdomain } = await readSettings(createDb(deps.db), [
    SETTING.accountSubdomain,
  ]);
  const domains = await deps.api.workerDomains.listDomains({ service: workerName });
  const serving = domains
    .filter((d) => d.service === workerName)
    .map((d) => ({ hostname: d.hostname.toLowerCase(), zoneId: d.zone_id, zoneName: d.zone_name }));
  return {
    hostname: rows.hostname,
    zoneId: rows.zoneId,
    previousHostname: rows.previousHostname,
    movedAt: rows.movedAt,
    workersDevHostname: subdomain ? `${workerName}.${subdomain}.workers.dev`.toLowerCase() : null,
    serving: rows.hostname === null ? null : serving.some((d) => d.hostname === rows.hostname),
    attachedByHand: serving.filter((d) => d.hostname !== rows.hostname),
  };
}

export interface AddressOptions extends Omit<DomainOptions, "zones"> {
  /** Active zones, each with the hostname the field suggests: `appflare.<zone>`. */
  zones: Array<{ id: string; name: string; suggestedHostname: string }>;
}

/** The zones Appflare can move to, and the custom domain permissions the token lacks. */
export async function listAddressOptions(
  deps: Pick<ManagerAddressDeps, "db" | "api">,
): Promise<AddressOptions> {
  const options = await getDomainOptionsCore({ db: deps.db, api: deps.api });
  return {
    ...options,
    zones: options.zones.map((z) => ({ ...z, suggestedHostname: `appflare.${z.name}` })),
  };
}

export interface MoveAddressRequest {
  zoneId: string;
  hostname: string;
  /** The admin agreed to replace the DNS records at the hostname. */
  overrideExistingDnsRecord?: boolean;
  /** The page to open at the new address once signed in there. */
  returnTo?: string;
}

export type MoveAddressResult =
  | {
      ok: true;
      hostname: string;
      /** Where to send the browser: the sign-in page at the new address. */
      url: string;
      /** A change only: what happened to the domain Appflare left. */
      previousDomain?: DetachOutcome | "failed";
    }
  | {
      ok: false;
      /** The hostname has DNS records the domain would replace; ask before replacing them. */
      reason: "dns-conflict";
      hostname: string;
      records: ConflictingRecord[];
    };

/** The sign-in page at `hostname`, with the page to open and the note that Appflare moved. */
export function signInAtUrl(hostname: string, returnTo: string | undefined): string {
  const params = new URLSearchParams({
    returnTo: safeReturnPath(returnTo) ?? settingsLink("domains", "address"),
    moved: "1",
  });
  return `https://${hostname}/login?${params.toString()}`;
}

/** Moves Appflare from its workers.dev address to a custom domain. */
export function moveManagerAddress(
  deps: ManagerAddressDeps,
  request: MoveAddressRequest,
): Promise<MoveAddressResult> {
  return withAddressLock(deps.db, () => move(deps, request, "move"));
}

/** Moves Appflare from its custom domain to another one, then detaches the one it left. */
export function changeManagerAddress(
  deps: ManagerAddressDeps,
  request: MoveAddressRequest,
): Promise<MoveAddressResult> {
  return withAddressLock(deps.db, () => move(deps, request, "change"));
}

async function move(
  deps: ManagerAddressDeps,
  request: MoveAddressRequest,
  kind: "move" | "change",
): Promise<MoveAddressResult> {
  const { api } = deps;
  const workerName = await readWorkerName(deps.db);
  const current = await readAddressRows(deps.db);
  if (kind === "move" && current.hostname !== null) {
    throw new ManagerAddressError(ADDRESS_MESSAGES.alreadyMoved(current.hostname));
  }
  if (kind === "change" && current.hostname === null) {
    throw new ManagerAddressError(ADDRESS_MESSAGES.notMoved);
  }

  // 1. The hostname, and everything that could refuse it, before anything changes.
  const zone = await asAddressError(() => readZone(api, request.zoneId));
  const checked = checkHostnameInZone(request.hostname, zone.name);
  if (!checked.ok) throw new ManagerAddressError(checked.error);
  const { hostname } = checked;
  if (hostname === current.hostname) {
    throw new ManagerAddressError(ADDRESS_MESSAGES.sameAddress(hostname));
  }
  if (hostname === gatewayHostname(zone.name)) {
    throw new ManagerAddressError(ADDRESS_MESSAGES.gateway(hostname));
  }
  // Without the Access permission the move is refused here, before attaching.
  await asAddressError(() => checkAccessMove({ db: deps.db, client: api }, hostname));
  const existing = (await api.workerDomains.listDomains({ hostname })).find(
    (d) => d.hostname.toLowerCase() === hostname,
  );
  if (existing !== undefined && existing.service !== workerName) {
    const app = await appServedBy(deps.db, existing.service);
    if (app !== null) throw new ManagerAddressError(ADDRESS_MESSAGES.usedByApp(hostname, app));
  }
  const alreadyAttached = existing !== undefined && existing.service === workerName;
  // Attached to the manager already: by hand (adopted), or by an earlier try
  // that did not complete, which recorded that.
  const recorded = await readAttachedBy(deps.db, hostname);
  const leaving = current.hostname ?? (await addressInUse(deps, workerName));
  const now = (deps.now ?? (() => new Date()))();

  // 2. Attach it to the manager's own Worker (Cloudflare creates the DNS record).
  const attached = await asAddressError(() =>
    attachCheckedDomain(api, {
      zone,
      hostname,
      workerName,
      overrideExistingDnsRecord: request.overrideExistingDnsRecord === true,
    }),
  );
  if (!attached.ok) return attached;
  const by: AttachedBy = alreadyAttached
    ? (recorded ?? "hand")
    : request.overrideExistingDnsRecord === true
      ? "appflare-replaced-records"
      : "appflare";
  if (recorded !== by) await writeAttachedBy(deps.db, hostname, by, now);
  /**
   * Detaches the new domain when Appflare attached it and nothing was lost
   * by attaching it; else it stays attached. The record goes with the domain.
   */
  const undo = async (): Promise<UndoOutcome> => {
    if (by === "hand") return "kept-by-hand";
    if (by === "appflare-replaced-records") return "kept-replaced-records";
    try {
      await detachCustomDomain(api, { hostname, cfId: attached.domainId, workerName });
    } catch (error) {
      console.error("address: could not detach the new domain again", {
        hostname,
        error: error instanceof Error ? error.message : String(error),
      });
      return "detach-failed";
    }
    await deleteAttachedBy(deps.db, hostname);
    return "detached";
  };

  // 3. Wait until it answers as this manager; the old address serves meanwhile.
  const wait = await waitForManager(deps, hostname);
  if (!wait.ok) {
    const domain = await undo();
    throw new ManagerAddressError(
      ADDRESS_MESSAGES.notServing(
        hostname,
        Math.round(LIVE_HEALTH_WINDOW_MS / 1000),
        wait.last,
        leaving,
        domain,
      ),
    );
  }

  // 4. Switch.
  try {
    await switchAddress(deps, {
      from: leaving,
      to: hostname,
      rows: {
        hostname,
        domainId: attached.domainId,
        zoneId: zone.id,
        // Adopting the domain people already use leaves nothing behind.
        previousHostname: leaving === hostname ? null : leaving,
        movedAt: now.toISOString(),
      },
    });
  } catch (error) {
    await undo();
    if (error instanceof AccessToggleError) throw new ManagerAddressError(error.message);
    throw error;
  }

  await deleteAttachedBy(deps.db, hostname);
  const result: MoveAddressResult = {
    ok: true,
    hostname,
    url: signInAtUrl(hostname, request.returnTo),
  };
  if (kind === "change" && current.hostname !== null) {
    result.previousDomain = await detachQuietly(api, {
      hostname: current.hostname,
      cfId: current.domainId,
      workerName,
    });
  }
  return result;
}

/**
 * The address people use while Appflare has none of its own, which the
 * passkeys without a recorded host were added at: the hostname Cloudflare
 * Access protects, else the one an admin last managed notification channels
 * from, else the workers.dev address.
 */
async function addressInUse(
  deps: Pick<ManagerAddressDeps, "db" | "api">,
  workerName: string,
): Promise<string> {
  const { results } = await deps.db
    .prepare("SELECT key, value FROM settings WHERE key IN (?1, ?2)")
    .bind(SETTING.accessDomain, MANAGER_URL_KEY)
    .all<{ key: string; value: string }>();
  const s = new Map(results.map((r) => [r.key, r.value]));
  const access = s.get(SETTING.accessDomain);
  if (access) return access.toLowerCase();
  const remembered = s.get(MANAGER_URL_KEY);
  if (remembered) {
    try {
      return new URL(remembered).hostname;
    } catch {
      // Not a URL; the workers.dev address below.
    }
  }
  return workersDevHostname(deps, workerName);
}

/** The label of the app whose Worker is `workerName`, or null when it is not an app of Appflare's. */
async function appServedBy(db: D1Database, workerName: string): Promise<string | null> {
  const named = await readInstallNames(db);
  const install = named.find((n) => n.workerName === workerName);
  if (install === undefined) return null;
  return distinctLabels(named).get(install.id) ?? install.name;
}

export type WaitResult = { ok: true } | { ok: false; last: string };

/**
 * Probes `https://<hostname>/api/health` until it answers as this manager
 * (200 with this `version`), with the install's live-check backoff (2, 3, 5,
 * 8, then 10 seconds) for at most its window.
 */
export async function waitForManager(
  deps: Pick<ManagerAddressDeps, "fetch" | "version" | "now" | "sleep">,
  hostname: string,
): Promise<WaitResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = () => (deps.now ?? (() => new Date()))().getTime();
  const url = `https://${hostname}/api/health`;
  const started = clock();
  let last = "no answer";
  for (let attempt = 1; ; attempt++) {
    const probe = await probeHealth(deps.fetch, url);
    const verdict = managerVerdict(probe, deps.version);
    if (verdict === null) return { ok: true };
    last = verdict;
    const delayMs = liveHealthDelaySeconds(attempt) * 1000;
    const elapsed = Math.max(clock() - started, liveHealthScheduledMs(attempt));
    if (elapsed + delayMs > LIVE_HEALTH_WINDOW_MS) return { ok: false, last };
    await sleep(delayMs);
  }
}

/** Null when the answer is this manager's health report; else what it was instead. */
function managerVerdict(probe: HealthProbe, version: string): string | null {
  if (probe.kind === "error") return `no connection (${probe.message})`;
  if (probe.status !== 200) {
    const edge = /^error code: (\d+)/.exec(probe.bodyStart.trimStart());
    return edge ? `HTTP ${probe.status}, error code ${edge[1]}` : `HTTP ${probe.status}`;
  }
  let reported: unknown;
  try {
    reported = (JSON.parse(probe.body ?? probe.bodyStart) as { version?: unknown } | null)?.version;
  } catch {
    return "HTTP 200 from something that is not Appflare";
  }
  if (typeof reported !== "string") return "HTTP 200 from something that is not Appflare";
  return reported === version ? null : `Appflare ${reported}, not ${version}`;
}

/** One switch of the address. */
interface AddressSwitch {
  /** The hostname being left: passkeys without a row were added there. */
  from: string;
  /** The hostname being arrived at: Access moves there, and its passkeys work again. */
  to: string;
  /** The rows to write; all null to go back to workers.dev. */
  rows: AddressRows;
  /** Move Cloudflare Access along when it is on (default). */
  moveAccess?: boolean;
}

/**
 * Writes the new address in one batch: the address rows, the Access rows
 * when Access moved along, the passkey bookkeeping, and the remembered
 * manager URL (deleted, since it named the address being left). Access is
 * moved first, under its lock; if the batch then fails, it is moved back.
 */
async function switchAddress(
  deps: Pick<ManagerAddressDeps, "db" | "api" | "now">,
  change: AddressSwitch,
): Promise<void> {
  const { db, api } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const run = async (access: AccessConfig | null) => {
    const moved =
      access !== null && access.domain !== change.to
        ? await moveAccessApps({ db, client: api }, access, change.to)
        : null;
    const statements: D1PreparedStatement[] = [
      addressStatement(db, change.rows, now),
      db.prepare("DELETE FROM settings WHERE key = ?1").bind(MANAGER_URL_KEY),
      // Every passkey without a row was added at the address being left...
      db
        .prepare(
          `INSERT INTO passkey_host (passkey_id, hostname, recorded_at)
           SELECT id, ?1, ?2 FROM passkey WHERE true
           ON CONFLICT(passkey_id) DO NOTHING`,
        )
        .bind(change.from, now.getTime()),
      // ...and those added at the address being arrived at work there again.
      db.prepare("DELETE FROM passkey_host WHERE hostname = ?1").bind(change.to),
    ];
    if (moved !== null) {
      statements.push(
        upsertStatement(db, SETTING.accessDomain, moved.domain, now),
        upsertStatement(db, SETTING.accessAud, moved.aud, now),
        upsertStatement(db, SETTING.accessPolicyId, moved.policyId, now),
      );
    }
    try {
      await db.batch(statements);
    } catch (error) {
      if (moved !== null && access !== null) {
        await moveAccessApps({ db, client: api }, moved, access.domain).catch((back: unknown) =>
          console.error("address: could not move Cloudflare Access back", {
            error: back instanceof Error ? back.message : String(back),
          }),
        );
      }
      throw error;
    }
  };
  if (change.moveAccess === false || (await readAccessConfig(db)) === null) {
    await run(null);
  } else {
    // Read again under the Access lock: protection may have changed during the wait.
    await withAccessLock(db, async () => run(await readAccessConfig(db)));
  }
  accessGate.invalidate();
  addressRedirect.invalidate();
}

function upsertStatement(db: D1Database, key: string, value: string, now: Date) {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now.getTime());
}

/** One statement: every address row written, or (all null) every one deleted. */
function addressStatement(db: D1Database, rows: AddressRows, now: Date): D1PreparedStatement {
  if (rows.hostname === null) {
    return db
      .prepare(
        `DELETE FROM settings WHERE key IN (${ADDRESS_KEYS.map((k) => `'${k}'`).join(", ")})`,
      )
      .bind();
  }
  const values: Array<[string, string | null]> = [
    [SETTING.managerHostname, rows.hostname],
    [SETTING.managerDomainId, rows.domainId],
    [SETTING.managerZoneId, rows.zoneId],
    [SETTING.managerPreviousHostname, rows.previousHostname],
    [SETTING.managerMovedAt, rows.movedAt],
  ];
  const present = values.filter((v): v is [string, string] => v[1] !== null);
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?2 FROM json_each(?1)
       WHERE true
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(present), now.getTime());
}

export interface RevertResult {
  /** False when Appflare was at workers.dev already. */
  wasMoved: boolean;
  /** Where to send the browser: the sign-in page at workers.dev. */
  url: string | null;
  /** What happened to the custom domain Appflare left. */
  previousDomain: DetachOutcome | "failed" | null;
}

/**
 * Back to workers.dev: Access moves back first (a refusal leaves everything
 * as it was), then the rows are cleared (the redirect stops), then the
 * custom domain is detached from the manager's Worker.
 */
export function revertManagerAddress(
  deps: Pick<ManagerAddressDeps, "db" | "api" | "now">,
  request: { returnTo?: string } = {},
): Promise<RevertResult> {
  return withAddressLock(deps.db, async () => {
    const current = await readAddressRows(deps.db);
    if (current.hostname === null) return { wasMoved: false, url: null, previousDomain: null };
    const workerName = await readWorkerName(deps.db);
    const workersDev = await workersDevHostname(deps, workerName);
    try {
      await switchAddress(deps, { from: current.hostname, to: workersDev, rows: CLEARED });
    } catch (error) {
      if (error instanceof AccessToggleError) throw new ManagerAddressError(error.message);
      throw error;
    }
    const previousDomain = await detachQuietly(deps.api, {
      hostname: current.hostname,
      cfId: current.domainId,
      workerName,
    });
    return { wasMoved: true, url: signInAtUrl(workersDev, request.returnTo), previousDomain };
  });
}

const CLEARED: AddressRows = {
  hostname: null,
  domainId: null,
  zoneId: null,
  previousHostname: null,
  movedAt: null,
};

export type ReconcileResult =
  | { status: "workers-dev" }
  | { status: "serving"; hostname: string }
  | { status: "lost"; hostname: string; notified: number };

/**
 * The cron's check that the custom domain still serves the manager (one
 * call). When Cloudflare no longer lists it among the Worker's domains
 * (removed in the dashboard), Appflare goes back to workers.dev: Cloudflare
 * Access moves back when it is on (a failure is logged; the domain is gone
 * either way), the rows are cleared, and a notification goes out.
 */
export async function reconcileManagerAddress(
  lazy: Pick<ManagerAddressDeps, "db" | "now"> & {
    /** The API client, made only when Appflare has a custom domain to check. */
    api: () => Promise<CloudflareClient>;
  },
): Promise<ReconcileResult> {
  const before = await readAddressRows(lazy.db);
  if (before.hostname === null) return { status: "workers-dev" };
  const deps = { ...lazy, api: await lazy.api() };
  const workerName = await readWorkerName(deps.db);
  const domains = await deps.api.workerDomains.listDomains({ service: workerName });
  const serving = (hostname: string) =>
    domains.some((d) => d.service === workerName && d.hostname.toLowerCase() === hostname);
  if (serving(before.hostname)) return { status: "serving", hostname: before.hostname };

  return withAddressLock(deps.db, async (): Promise<ReconcileResult> => {
    // Read again under the lock: a change or a revert may have finished meanwhile.
    const current = await readAddressRows(deps.db);
    if (current.hostname === null) return { status: "workers-dev" };
    const hostname = current.hostname;
    if (hostname !== before.hostname && serving(hostname)) return { status: "serving", hostname };
    const workersDev = await workersDevHostname(deps, workerName);
    const change: AddressSwitch = { from: hostname, to: workersDev, rows: CLEARED };
    let accessLeftBehind = false;
    try {
      await switchAddress(deps, change);
    } catch (error) {
      accessLeftBehind = (await readAccessConfig(deps.db)) !== null;
      // The domain no longer serves Appflare, so the address is cleared even
      // when Access cannot follow; it then still protects the lost hostname.
      console.error("address: could not move Cloudflare Access back to workers.dev", {
        error: error instanceof Error ? error.message : String(error),
      });
      await switchAddress(deps, { ...change, moveAccess: false });
    }
    const now = (deps.now ?? (() => new Date()))().getTime();
    const { queued } = await emitEvent(
      deps.db,
      await readChannels(deps.db),
      {
        type: "manager_address_lost",
        dedupeKey: `manager_address_lost:${hostname}:${current.movedAt ?? ""}`,
        facts: {
          type: "manager_address_lost",
          hostname,
          ...(accessLeftBehind ? { accessLeftBehind: true } : {}),
        },
        occurredAt: now,
      },
      now,
    );
    return { status: "lost", hostname, notified: queued };
  });
}

/** Detaches a custom domain of the manager; a failure is logged and reported, never thrown. */
async function detachQuietly(
  api: CloudflareClient,
  domain: { hostname: string; cfId: string | null; workerName: string },
): Promise<DetachOutcome | "failed"> {
  try {
    return await detachCustomDomain(api, domain);
  } catch (error) {
    console.error("address: could not detach the domain Appflare left", {
      hostname: domain.hostname,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

/**
 * Before "Remove Appflare" deletes the manager's Worker: its custom domain,
 * detached first. Read before the database goes; Cloudflare also removes the
 * domain with the Worker, so this only makes the order explicit.
 */
export async function readManagerDomain(
  db: D1Database,
): Promise<{ hostname: string; domainId: string | null } | null> {
  const rows = await readAddressRows(db);
  return rows.hostname === null ? null : { hostname: rows.hostname, domainId: rows.domainId };
}

/**
 * The hostname each of `passkeyIds` was added at, for the passkeys added at
 * an address Appflare has since left (the `passkey_host` rows). A passkey
 * missing from the map was added at the current address.
 */
export async function readPasskeyHosts(
  db: D1Database,
  passkeyIds: readonly string[],
): Promise<Map<string, string>> {
  if (passkeyIds.length === 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT passkey_id, hostname FROM passkey_host
       WHERE passkey_id IN (SELECT value FROM json_each(?1))`,
    )
    .bind(JSON.stringify(passkeyIds))
    .all<{ passkey_id: string; hostname: string }>();
  return new Map(results.map((r) => [r.passkey_id, r.hostname]));
}

async function asAddressError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CustomDomainError || error instanceof AccessToggleError) {
      throw new ManagerAddressError(error.message);
    }
    throw error;
  }
}

/**
 * Runs `run` holding the address lock. A request the browser cancels can end
 * the invocation before `finally` runs; the lock then stays until it expires
 * (LOCK_TTL_MS), and until then another change is refused as busy.
 */
async function withAddressLock<T>(db: D1Database, run: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID();
  if (!(await tryAcquireSettingsLock(db, LOCK_KEY, owner, LOCK_TTL_MS))) {
    throw new ManagerAddressError(ADDRESS_MESSAGES.busy);
  }
  try {
    return await run();
  } finally {
    await releaseSettingsLock(db, LOCK_KEY, owner);
  }
}
