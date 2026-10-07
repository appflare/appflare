import type { CloudflareClient } from "@appflare/cf-api";
import { ulid } from "ulidx";
import { type AccessConfig, readAccessConfig } from "../access/config";
import {
  AccessToggleError,
  checkAccessMove,
  moveAccessApps,
  withAccessLock,
} from "../access/toggle.server";
import { safeReturnPath } from "../components/internal-path";
import { settingsLink } from "../components/settings-links";
import { REMOVAL_IN_PROGRESS_MESSAGE, removalInProgress } from "../danger/removal-flag";
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
  ACCESS_CHALLENGE_DETAIL,
  type HealthProbe,
  isAccessChallenge,
} from "../jobs/install/health";
import { reconcileJobs, type WorkflowLookup } from "../jobs/reconcile.server";
import {
  activeSelfJob,
  NO_ACTIVE_SELF_UPDATE_SQL,
  selfUpdateBusyMessage,
} from "../jobs/self-update/guard";
import { emitEvent, readChannels } from "../notifications/outbox.server";
import { addressRedirect } from "./address-redirect";
import { MANAGER_URL_KEY } from "./manager-origin.server";
import type { MoveAddressJobParams } from "./move-address-job";
import { type MoveJobInput, moveInputOf } from "./move-address-lines";

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
 * The request that moves does the quick part: every check, the attach, and
 * the start of a `move_address` job, which waits for the new address (a new
 * domain's certificate commonly takes minutes) and then switches
 * (./move-address-job.ts). Going back to workers.dev, and the cron's check
 * that the domain still serves, run in their request. Each operation holds
 * a `settings` lock while it changes anything, and only one move job runs
 * at a time.
 */

export class ManagerAddressError extends Error {
  override name = "ManagerAddressError";
}

export interface ManagerAddressDeps {
  db: D1Database;
  api: CloudflareClient;
  /** The version this manager runs, which the new hostname must report. */
  version: string;
  /** Starts the move's Workflow instance (`jobCreator(env.JOBS)`). */
  createJob(id: string, params: MoveAddressJobParams): Promise<{ id: string }>;
  /** For settling jobs whose Workflow instance died, so they do not block a move. */
  workflows?: WorkflowLookup;
  /**
   * Drops this isolate's cached Access protection after a switch
   * (`accessGate.invalidate`); other isolates follow within its 15 seconds.
   * Handed in, so the move job never loads the gate and its refusal page.
   */
  invalidateAccessGate?: () => void;
  now?: () => Date;
  newId?: () => string;
}

const ADDRESS_KEYS = [
  SETTING.managerHostname,
  SETTING.managerDomainId,
  SETTING.managerZoneId,
  SETTING.managerPreviousHostname,
  SETTING.managerMovedAt,
] as const satisfies readonly SettingKey[];

const LOCK_KEY = "manager_address_lock";
/** Longer than the calls a start, a switch, or a way back makes while holding it. */
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
  moving: (hostname: string, jobId: string) =>
    `Appflare is moving to ${hostname} (job ${jobId}). Wait for it to finish, then try again. Follow it at /jobs/${jobId}.`,
  notStarted: (hostname: string, reason: string) =>
    `Appflare could not start the move: ${reason}. ${hostname} stays attached to Appflare's Worker; try again.`,
} as const;

/**
 * `manager_domain_attached_by:<hostname>`: who attached a custom domain that
 * Appflare is moving to, written as soon as it is attached and deleted once
 * the move completes. A move that does not complete leaves the domain
 * attached (detaching could not bring back DNS records it replaced, and a
 * later try needs the domain again), and a later try reads the record to
 * know the domain was not attached by hand:
 * - `appflare`: Appflare attached it;
 * - `appflare-replaced-records`: Appflare attached it in place of DNS
 *   records, which are gone for good;
 * - `hand`: it served Appflare's Worker before the move started.
 */
const ATTACHED_BY_PREFIX = "manager_domain_attached_by:";
export type AttachedBy = "appflare" | "appflare-replaced-records" | "hand";

export async function readAttachedBy(db: D1Database, hostname: string): Promise<AttachedBy | null> {
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
  /** An earlier move of Appflare attached it and did not complete; not attached by hand. */
  leftByMove: boolean;
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
   * attached by hand in the Cloudflare dashboard, or left attached by a move
   * that did not complete. Any of them can become Appflare's address.
   */
  attachedByHand: ServingDomain[];
  /** The move job queued or running, which the page follows; null when none is. */
  movingJobId: string | null;
  /** Where that job moves Appflare; null when no move runs. */
  movingTo: { hostname: string; zoneId: string } | null;
  /**
   * The custom domain the install chose, which Appflare moves to by itself
   * once it serves (pending-address.server.ts); null when none is pending.
   * `failedAt`: the move there failed, and Appflare waits for an admin.
   * Optional for callers that build an address by hand.
   */
  pending?: { hostname: string; failedAt: string | null; failure: string | null } | null;
}

/** A move job queued or running. */
interface ActiveMove {
  id: string;
  hostname: string;
  zoneId: string;
}

interface MoveJobRow {
  id: string;
  kind: string;
  status: string;
  install_id: string | null;
  workflow_instance_id: string | null;
  input_json: string | null;
  started_at: number | null;
}

/**
 * The `move_address` job queued or running, if any. With `workflows`, a job
 * whose Workflow instance ended is settled first, so a dead instance never
 * blocks the next move.
 */
export async function activeMoveJob(
  db: D1Database,
  workflows?: WorkflowLookup,
): Promise<ActiveMove | null> {
  const read = async () =>
    (
      await db
        .prepare(
          `SELECT id, kind, status, install_id, workflow_instance_id, input_json, started_at
           FROM jobs WHERE kind = 'move_address' AND status IN ('queued', 'running')
           ORDER BY id DESC`,
        )
        .all<MoveJobRow>()
    ).results;
  let rows = await read();
  if (rows.length > 0 && workflows !== undefined) {
    const active = rows.map((r) => ({
      ...r,
      started_at: r.started_at === null ? null : new Date(r.started_at),
    }));
    if (await reconcileJobs(db, workflows, active)) rows = await read();
  }
  const [row] = rows;
  if (row === undefined) return null;
  const input = moveInputOf(row.input_json);
  return { id: row.id, hostname: input.hostname, zoneId: input.zoneId };
}

/**
 * Appflare's address as stored, checked against Cloudflare's list of the
 * Worker's domains (one call), and the move job running, if any.
 */
export async function readManagerAddress(
  deps: Pick<ManagerAddressDeps, "db" | "api" | "workflows">,
): Promise<ManagerAddress> {
  const workerName = await readWorkerName(deps.db);
  const rows = await readAddressRows(deps.db);
  const s = await readSettings(createDb(deps.db), [
    SETTING.accountSubdomain,
    SETTING.managerPendingHostname,
    SETTING.managerPendingFailedAt,
    SETTING.managerPendingFailure,
  ]);
  const subdomain = s.account_subdomain;
  const pending = s.manager_pending_hostname;
  const [domains, attachedBy, moving] = await Promise.all([
    deps.api.workerDomains.listDomains({ service: workerName }),
    readAllAttachedBy(deps.db),
    activeMoveJob(deps.db, deps.workflows),
  ]);
  const serving = domains
    .filter((d) => d.service === workerName)
    .map((d) => {
      const hostname = d.hostname.toLowerCase();
      const by = attachedBy.get(hostname);
      return {
        hostname,
        zoneId: d.zone_id,
        zoneName: d.zone_name,
        leftByMove: by === "appflare" || by === "appflare-replaced-records",
      };
    });
  return {
    hostname: rows.hostname,
    zoneId: rows.zoneId,
    previousHostname: rows.previousHostname,
    movedAt: rows.movedAt,
    workersDevHostname: subdomain ? `${workerName}.${subdomain}.workers.dev`.toLowerCase() : null,
    serving: rows.hostname === null ? null : serving.some((d) => d.hostname === rows.hostname),
    // The pending domain is attached too; Appflare moves there by itself.
    attachedByHand: serving.filter((d) => d.hostname !== rows.hostname && d.hostname !== pending),
    movingJobId: moving?.id ?? null,
    movingTo: moving === null ? null : { hostname: moving.hostname, zoneId: moving.zoneId },
    pending:
      rows.hostname === null && pending
        ? {
            hostname: pending,
            failedAt: s.manager_pending_failed_at || null,
            failure: s.manager_pending_failure || null,
          }
        : null,
  };
}

/** Every `manager_domain_attached_by:` record, by hostname. */
async function readAllAttachedBy(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db
    .prepare("SELECT key, value FROM settings WHERE key LIKE ?1")
    .bind(`${ATTACHED_BY_PREFIX}%`)
    .all<{ key: string; value: string }>();
  return new Map(results.map((r) => [r.key.slice(ATTACHED_BY_PREFIX.length), r.value]));
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
  /** Who starts the move: an admin (default), or Appflare itself for a pending address. */
  startedBy?: "admin" | "schedule";
}

export type MoveAddressResult =
  | {
      ok: true;
      hostname: string;
      /** The `move_address` job that waits for the new address and switches. */
      jobId: string;
      /** Where to send the browser once the job succeeded: the sign-in page at the new address. */
      url: string;
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

/**
 * Moves Appflare from its workers.dev address to a custom domain: checks,
 * attaches, and starts the job that waits for the new address and switches.
 */
export function moveManagerAddress(
  deps: ManagerAddressDeps,
  request: MoveAddressRequest,
): Promise<MoveAddressResult> {
  return withAddressLock(deps.db, () => move(deps, request, "move"));
}

/**
 * Moves Appflare from its custom domain to another one; the job detaches the
 * one it left once it has switched.
 */
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
  // One move at a time, none while Appflare replaces its own version (the
  // job waits for the version running now), and none during a removal.
  if ((await removalInProgress(deps.db)) !== null) {
    throw new ManagerAddressError(REMOVAL_IN_PROGRESS_MESSAGE);
  }
  const running = await activeMoveJob(deps.db, deps.workflows);
  if (running !== null) {
    throw new ManagerAddressError(ADDRESS_MESSAGES.moving(running.hostname, running.id));
  }
  const selfJob = await activeSelfJob(deps.db, deps.workflows);
  if (selfJob !== null) throw new ManagerAddressError(selfUpdateBusyMessage(selfJob));

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

  // 3. The job that waits for the new address and switches. Its row is the
  // claim: inserted only while no other move and no self-update runs.
  const jobId = (deps.newId ?? (() => ulid()))();
  const url = signInAtUrl(hostname, request.returnTo);
  const from =
    kind === "change" && current.hostname !== null
      ? { hostname: current.hostname, domainId: current.domainId }
      : null;
  const params: MoveAddressJobParams = {
    kind: "move_address",
    jobId,
    hostname,
    zoneId: zone.id,
    domainId: attached.domainId,
    version: deps.version,
    from,
  };
  const input: MoveJobInput = { hostname, zoneId: zone.id, from: from?.hostname ?? null, url };
  const claimed = await deps.db
    .prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by)
       SELECT ?1, NULL, 'move_address', 'queued', ?2, ?3
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE kind = 'move_address' AND status IN ('queued', 'running'))
         AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
    )
    .bind(jobId, JSON.stringify(input), request.startedBy ?? "admin")
    .run();
  if (claimed.meta.changes !== 1) throw new ManagerAddressError(ADDRESS_MESSAGES.busy);
  let instanceId: string;
  try {
    instanceId = (await deps.createJob(jobId, params)).id;
  } catch (error) {
    const reason = `could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await deps.db
      .prepare("UPDATE jobs SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1")
      .bind(jobId, `start: ${reason}`, now.getTime())
      .run();
    throw new ManagerAddressError(ADDRESS_MESSAGES.notStarted(hostname, reason));
  }
  await deps.db
    .prepare("UPDATE jobs SET workflow_instance_id = ?2 WHERE id = ?1")
    .bind(jobId, instanceId)
    .run();
  return { ok: true, hostname, jobId, url };
}

/** What the switch at the end of a move did. */
export interface CompletedMove {
  /** The hostname Appflare left (its passkeys were recorded against it). */
  from: string;
  /** Cloudflare Access moved along. */
  accessMoved: boolean;
}

/**
 * The switch at the end of a move job, once the new address answers: under
 * the address lock, the rows, Cloudflare Access and the passkey bookkeeping
 * in one go (`switchAddress`), then the attach record goes. Safe to run
 * again: when the rows already name `hostname`, an earlier run switched.
 *
 * Also how a manager installed from the browser on a custom domain adopts
 * it when the installer's handoff arrives there: `inUse` is then that
 * hostname, the address people already use, so nothing is left behind.
 */
export async function completeAddressMove(
  deps: Pick<ManagerAddressDeps, "db" | "api" | "now">,
  move: {
    hostname: string;
    domainId: string;
    zoneId: string;
    workerName: string;
    /** The address people use now, when the caller knows it; else it is looked up. */
    inUse?: string;
  },
): Promise<CompletedMove> {
  return withAddressLock(deps.db, async () => {
    const current = await readAddressRows(deps.db);
    if (current.hostname === move.hostname) {
      await deleteAttachedBy(deps.db, move.hostname);
      return { from: current.previousHostname ?? move.hostname, accessMoved: false };
    }
    const leaving = current.hostname ?? move.inUse ?? (await addressInUse(deps, move.workerName));
    const now = (deps.now ?? (() => new Date()))();
    const accessMoved = await switchAddress(deps, {
      from: leaving,
      to: move.hostname,
      rows: {
        hostname: move.hostname,
        domainId: move.domainId,
        zoneId: move.zoneId,
        // Adopting the domain people already use leaves nothing behind.
        previousHostname: leaving === move.hostname ? null : leaving,
        movedAt: now.toISOString(),
      },
    });
    await deleteAttachedBy(deps.db, move.hostname);
    return { from: leaving, accessMoved };
  });
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

/**
 * Null when the answer is this manager's health report (200 with this
 * `version`); else what it was instead.
 */
export function managerVerdict(probe: HealthProbe, version: string): string | null {
  if (probe.kind === "error") return `no connection (${probe.message})`;
  if (isAccessChallenge(probe)) return ACCESS_CHALLENGE_DETAIL;
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
 * True when Access moved along.
 */
async function switchAddress(
  deps: Pick<ManagerAddressDeps, "db" | "api" | "now" | "invalidateAccessGate">,
  change: AddressSwitch,
): Promise<boolean> {
  const { db, api } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const run = async (access: AccessConfig | null): Promise<boolean> => {
    const moved =
      access !== null && access.domain !== change.to
        ? await moveAccessApps({ db, client: api }, access, change.to)
        : null;
    const statements: D1PreparedStatement[] = [
      addressStatement(db, change.rows, now),
      db.prepare("DELETE FROM settings WHERE key = ?1").bind(MANAGER_URL_KEY),
      // Any change of address ends a pending one (pending-address.server.ts).
      clearPendingStatement(db),
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
    return moved !== null;
  };
  let accessMoved: boolean;
  if (change.moveAccess === false || (await readAccessConfig(db)) === null) {
    accessMoved = await run(null);
  } else {
    // Read again under the Access lock: protection may have changed during the wait.
    accessMoved = await withAccessLock(db, async () => run(await readAccessConfig(db)));
  }
  deps.invalidateAccessGate?.();
  addressRedirect.invalidate();
  return accessMoved;
}

/**
 * Ends a pending address (pending-address.server.ts): in every batch that
 * changes the address, and once Appflare has an address of its own.
 */
export function clearPendingStatement(db: D1Database): D1PreparedStatement {
  return db
    .prepare("DELETE FROM settings WHERE key IN (?1, ?2, ?3, ?4, ?5)")
    .bind(
      SETTING.managerPendingHostname,
      SETTING.managerPendingZoneId,
      SETTING.managerPendingJobId,
      SETTING.managerPendingFailedAt,
      SETTING.managerPendingFailure,
    );
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
 * custom domain is detached from the manager's Worker. Refused while a move
 * job runs, which would switch again once its address answers.
 */
export function revertManagerAddress(
  deps: Pick<ManagerAddressDeps, "db" | "api" | "now" | "workflows" | "invalidateAccessGate">,
  request: { returnTo?: string } = {},
): Promise<RevertResult> {
  return withAddressLock(deps.db, async () => {
    const running = await activeMoveJob(deps.db, deps.workflows);
    if (running !== null) {
      throw new ManagerAddressError(ADDRESS_MESSAGES.moving(running.hostname, running.id));
    }
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
  lazy: Pick<ManagerAddressDeps, "db" | "now" | "invalidateAccessGate"> & {
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
export async function detachQuietly(
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
