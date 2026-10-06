import type { CloudflareClient } from "@appflare/cf-api";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import {
  ADDRESS_MESSAGES,
  activeMoveJob,
  clearPendingStatement,
  type ManagerAddressDeps,
  ManagerAddressError,
  type MoveAddressResult,
  moveManagerAddress,
} from "./manager-address.server";
import { identityVerdict } from "./manager-identity";

/**
 * Appflare's pending address: the custom domain the browser install chose,
 * while it does not serve yet. The installer attaches the domain to the
 * manager's Worker; a new domain's certificate can take longer than the
 * installing page waits, and the person may open Appflare at its workers.dev
 * address instead. The handoff arriving there records the domain as
 * pending (`recordPendingAddress`). Once an owner exists and the domain
 * answers as this Appflare (`identityVerdict`), the usual move
 * (manager-address.server.ts, move-address-job.ts) takes Appflare there
 * (`movePendingAddress`), started by the cron or by a page request at
 * workers.dev; workers.dev then redirects. Owner setup waits for nothing: it
 * happens at workers.dev with a password, which works at every address, and
 * passkeys come after the move, since a passkey belongs to one address.
 *
 * Appflare tries by itself once. When that move fails (its job fails, or it
 * is refused before it starts), the pending address is marked failed and
 * nothing more happens by itself: Settings, Domains offers Try again (one
 * move, by an admin) and Stay at workers.dev (`stayAtWorkersDev`). A failed
 * job sends its one "move finished" notification as every move job does.
 * A pending domain that is no longer attached to the Worker is dropped.
 *
 * Any change of address deletes the pending rows (`switchAddress`), so a
 * move by hand, a move back to workers.dev or a lost domain ends it.
 */

export interface PendingAddress {
  hostname: string;
  zoneId: string;
  /** The move job started for it, while it may still run. */
  jobId: string | null;
  /** When the move failed, and why; no automatic try after that. */
  failedAt: string | null;
  failure: string | null;
}

const PENDING_KEYS = [
  SETTING.managerPendingHostname,
  SETTING.managerPendingZoneId,
  SETTING.managerPendingJobId,
  SETTING.managerPendingFailedAt,
  SETTING.managerPendingFailure,
] as const;

export async function readPendingAddress(db: D1Database): Promise<PendingAddress | null> {
  const s = await readSettings(createDb(db), PENDING_KEYS);
  const hostname = s.manager_pending_hostname;
  const zoneId = s.manager_pending_zone_id;
  if (!hostname || !zoneId) return null;
  return {
    hostname,
    zoneId,
    jobId: s.manager_pending_job_id || null,
    failedAt: s.manager_pending_failed_at || null,
    failure: s.manager_pending_failure || null,
  };
}

function upsert(db: D1Database, key: string, value: string, now: Date) {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now.getTime());
}

/**
 * At a handoff that arrived at the workers.dev address: the custom domain
 * of this Worker the install chose, recorded as pending. `intended` is the
 * hostname the installing page reviewed, when it sends one; without it, the
 * Worker's only custom domain (a new manager's Worker has no other). None
 * recorded when no domain matches: Appflare then simply lives at workers.dev.
 */
export async function recordPendingAddress(deps: {
  db: D1Database;
  api: CloudflareClient;
  workerName: string;
  intended: string | null;
  now: Date;
}): Promise<{ hostname: string; zoneId: string } | null> {
  const domains = (await deps.api.workerDomains.listDomains({ service: deps.workerName })).filter(
    (d) => d.service === deps.workerName,
  );
  const intended = deps.intended?.toLowerCase() ?? null;
  const chosen =
    intended !== null
      ? domains.find((d) => d.hostname.toLowerCase() === intended)
      : domains.length === 1
        ? domains[0]
        : undefined;
  if (chosen === undefined) return null;
  const pending = { hostname: chosen.hostname.toLowerCase(), zoneId: chosen.zone_id };
  await deps.db.batch([
    clearPendingStatement(deps.db),
    upsert(deps.db, SETTING.managerPendingHostname, pending.hostname, deps.now),
    upsert(deps.db, SETTING.managerPendingZoneId, pending.zoneId, deps.now),
  ]);
  return pending;
}

/** Marks the pending address failed: nothing more is tried by itself. */
async function markFailed(db: D1Database, reason: string, now: Date): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM settings WHERE key = ?1").bind(SETTING.managerPendingJobId),
    upsert(db, SETTING.managerPendingFailedAt, now.toISOString(), now),
    upsert(db, SETTING.managerPendingFailure, reason, now),
  ]);
}

export type PendingMove =
  /** Nothing is pending. */
  | { status: "none" }
  /** Appflare has an address of its own already; the pending one is dropped. */
  | { status: "cleared" }
  /** The domain is no longer attached to this Worker; the pending one is dropped. */
  | { status: "detached"; hostname: string }
  /** An earlier move failed; Appflare waits for an admin. */
  | { status: "failed" }
  /** The move job just failed: the pending address is marked failed now. */
  | { status: "move-failed"; hostname: string; reason: string }
  /** No owner yet: setup's claim belongs to the address in use, so the move waits. */
  | { status: "waiting-for-owner" }
  /** A move job is queued or running. */
  | { status: "moving"; jobId: string }
  /** Another look started the move at the same moment. */
  | { status: "busy" }
  /** The domain does not answer as this Appflare yet. */
  | { status: "not-serving"; last: string }
  /** The move job started. */
  | { status: "started"; jobId: string }
  /** The move refused to start; marked failed like a failed job. */
  | { status: "refused"; reason: string };

/** What a look needs: the move's own dependencies, the API client made lazily. */
export type PendingMoveDeps = Omit<ManagerAddressDeps, "api"> & {
  /** Made only when there is something to move. */
  api: () => Promise<CloudflareClient>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** The hash in `APPFLARE_HANDOFF`; null on a manager not installed from the browser. */
  handoffHash: string | null;
};

async function ownerExists(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS one FROM user LIMIT 1").first()) !== null;
}

async function jobOf(db: D1Database, id: string) {
  return db
    .prepare("SELECT status, error FROM jobs WHERE id = ?1")
    .bind(id)
    .first<{ status: string; error: string | null }>();
}

/** The error a move that lost a race to another look ends with. */
function lostRace(error: ManagerAddressError): boolean {
  return (
    error.message === ADDRESS_MESSAGES.busy || error.message.startsWith("Appflare is moving to ")
  );
}

/**
 * Moves Appflare to its pending address once that serves: one identity
 * probe of the domain, then the move every admin can start in Settings,
 * Domains (which checks, attaches the domain it already has, and starts the
 * job that switches). One D1 read when nothing is pending.
 */
export async function movePendingAddress(deps: PendingMoveDeps): Promise<PendingMove> {
  const now = (deps.now ?? (() => new Date()))();
  const pending = await readPendingAddress(deps.db);
  if (pending === null) return { status: "none" };
  const { manager_hostname: current, worker_name: workerName } = await readSettings(
    createDb(deps.db),
    [SETTING.managerHostname, SETTING.workerName],
  );
  if (current) {
    await clearPendingStatement(deps.db).run();
    return { status: "cleared" };
  }
  if (pending.failedAt !== null) return { status: "failed" };
  if (pending.jobId !== null) {
    const job = await jobOf(deps.db, pending.jobId);
    if (job?.status === "queued" || job?.status === "running") {
      return { status: "moving", jobId: pending.jobId };
    }
    if (job === null || job.status === "failed") {
      const reason = job?.error ?? "The move job is gone.";
      await markFailed(deps.db, reason, now);
      return { status: "move-failed", hostname: pending.hostname, reason };
    }
  }
  if (!(await ownerExists(deps.db))) return { status: "waiting-for-owner" };
  const active = await activeMoveJob(deps.db, deps.workflows);
  if (active !== null) return { status: "moving", jobId: active.id };
  const last = await identityVerdict(deps.fetch, pending.hostname, {
    version: deps.version,
    handoffHash: deps.handoffHash,
  });
  if (last !== null) {
    // Not serving: still attached to this Worker, or removed in the dashboard?
    const api = await deps.api();
    const attached = (await api.workerDomains.listDomains({ hostname: pending.hostname })).some(
      (d) => d.hostname.toLowerCase() === pending.hostname && d.service === workerName,
    );
    if (!attached) {
      await clearPendingStatement(deps.db).run();
      return { status: "detached", hostname: pending.hostname };
    }
    return { status: "not-serving", last };
  }
  let moved: MoveAddressResult;
  try {
    moved = await moveManagerAddress(
      { ...deps, api: await deps.api() },
      { zoneId: pending.zoneId, hostname: pending.hostname, returnTo: "/", startedBy: "schedule" },
    );
  } catch (error) {
    if (!(error instanceof ManagerAddressError)) throw error;
    if (lostRace(error)) return { status: "busy" };
    await markFailed(deps.db, error.message, now);
    return { status: "refused", reason: error.message };
  }
  if (!moved.ok) {
    const reason = `${moved.hostname} has DNS records the move would replace.`;
    await markFailed(deps.db, reason, now);
    return { status: "refused", reason };
  }
  await upsert(deps.db, SETTING.managerPendingJobId, moved.jobId, now).run();
  return { status: "started", jobId: moved.jobId };
}

/**
 * Try again, by an admin, after the move failed: one move to the pending
 * address, followed like any other (no automatic try after it either).
 */
export async function retryPendingMove(
  deps: ManagerAddressDeps,
  request: { returnTo?: string } = {},
): Promise<MoveAddressResult> {
  const pending = await readPendingAddress(deps.db);
  if (pending === null) throw new ManagerAddressError(PENDING_MESSAGES.nothingPending);
  const now = (deps.now ?? (() => new Date()))();
  const moved = await moveManagerAddress(deps, {
    zoneId: pending.zoneId,
    hostname: pending.hostname,
    ...(request.returnTo === undefined ? {} : { returnTo: request.returnTo }),
  });
  if (moved.ok) {
    await deps.db.batch([
      upsert(deps.db, SETTING.managerPendingJobId, moved.jobId, now),
      deps.db
        .prepare("DELETE FROM settings WHERE key IN (?1, ?2)")
        .bind(SETTING.managerPendingFailedAt, SETTING.managerPendingFailure),
    ]);
  }
  return moved;
}

/** Stay at workers.dev: the pending address goes; the domain stays attached to the Worker. */
export async function stayAtWorkersDev(db: D1Database): Promise<void> {
  await clearPendingStatement(db).run();
}

/**
 * The pending domain, when `host` (the address a request came to) is a
 * workers.dev address: passkeys are not offered there until the move,
 * since a passkey works only at the address it was made at. Null otherwise.
 */
export async function passkeyMoveNotice(db: D1Database, host: string): Promise<string | null> {
  if (!host.toLowerCase().endsWith(".workers.dev")) return null;
  return (await readPendingAddress(db))?.hostname ?? null;
}

export const PENDING_MESSAGES = {
  nothingPending: "Appflare is not waiting to move anywhere.",
} as const;

/**
 * One log line for what a look at the pending address did; null when there
 * is nothing to say (each look while waiting, and a look that lost a race to
 * another one, stay quiet).
 */
export function pendingMoveLog(result: PendingMove): string | null {
  switch (result.status) {
    case "started":
      return `address: the pending domain serves Appflare; moving there (job ${result.jobId})`;
    case "refused":
      return `address: could not start the move to the pending domain: ${result.reason}`;
    case "move-failed":
      return `address: the move to ${result.hostname} failed; waiting for an admin`;
    case "detached":
      return `address: ${result.hostname} is no longer attached to Appflare's Worker; it is not pending any more`;
    default:
      return null;
  }
}
