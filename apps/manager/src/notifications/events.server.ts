import { managerUpdateView, readManagerLatest } from "../catalog/manager-releases.server";
import { catalogLookup } from "../catalog/merged.server";
import { installAppKey } from "../catalog/sources";
import { installLabel } from "../installs/display-name";
import {
  installJobAppNameSql,
  namedInstall,
  readInstallLabels,
} from "../installs/install-names.server";
import { pendingUpdates } from "../installs/pending-updates";
import type { AppRef, NotificationFacts } from "./messages";
import {
  type ChannelRow,
  emitEvent,
  HEALTH_EPISODE_PREFIX,
  JOBS_CURSOR_KEY,
  wants,
} from "./outbox.server";
import type { NotificationEvent } from "./schema";

/**
 * Where events come from.
 *
 * - A job's end (job-end.ts, and the cron's sweep of finished jobs that
 *   catches any the job itself could not record): install finished, update
 *   applied or failed, uninstall finished, Appflare's move to a new address
 *   finished. Once per job.
 * - Conditions the cron sees: an update available (once per install and
 *   version), a newer Appflare release (once per version), an install whose
 *   health check answers with a server error (once per episode: it opens
 *   when the scheduled check gets two server errors in a row, and ends only
 *   when a check finds the app serving or the app is gone).
 * - The cron's check of external domains (installs/external-domains-poll.server.ts):
 *   a domain went active, or failed. Once per change of the domain's state.
 *
 * A condition is emitted on every run while it holds; the dedupe key keeps
 * it one event, and a channel added later still hears about it once.
 */

export interface InstallRow {
  id: string;
  app_slug: string;
  worker_name: string;
  display_name: string | null;
  catalog_version: string;
  manifest_json: string | null;
  /**
   * The app's name its install job recorded, for an install without a
   * manifest yet (one that failed): it names the app as a finished one would.
   */
  app_name?: string | null;
}

/**
 * What a message names each of `rows` by (see `readInstallLabels`): told
 * apart from each other and from every install that is not uninstalled.
 */
export function readMessageLabels(
  db: D1Database,
  rows: readonly InstallRow[],
): Promise<Map<string, string>> {
  return readInstallLabels(db, rows.map(namedInstall));
}

export function appRefOf(
  row: InstallRow,
  /** From `readMessageLabels`. */
  labels: ReadonlyMap<string, string>,
  name?: string,
): AppRef {
  const named = namedInstall(row);
  return {
    installId: row.id,
    app: name ?? named.name,
    instance: labels.get(row.id) ?? installLabel(named),
    workerName: row.worker_name,
  };
}

function parseInput(json: string | null): Record<string, unknown> {
  if (json === null) return {};
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export interface JobEvent {
  type: NotificationEvent;
  facts: NotificationFacts;
  occurredAt: number;
  dedupeKey: string;
}

/**
 * The event a finished job makes, or null: the job has not finished, it is
 * a kind nobody is told about (rollback, self-update, deleting kept data),
 * or its install is gone. A move of Appflare's address has no install.
 */
export async function jobEventOf(db: D1Database, jobId: string): Promise<JobEvent | null> {
  const move = await moveEventOf(db, jobId);
  if (move !== undefined) return move;
  const row = await db
    .prepare(
      `SELECT j.kind, j.status, j.input_json, j.finished_at,
              i.id, i.app_slug, i.worker_name, i.display_name, i.catalog_version, i.manifest_json,
              CASE WHEN i.manifest_json IS NULL THEN ${installJobAppNameSql("i")} END AS app_name
       FROM jobs j JOIN installs i ON i.id = j.install_id
       WHERE j.id = ?1`,
    )
    .bind(jobId)
    .first<
      InstallRow & {
        kind: string;
        status: string;
        input_json: string | null;
        finished_at: number | null;
      }
    >();
  if (row === null || (row.status !== "succeeded" && row.status !== "failed")) return null;
  const outcome = row.status;
  const input = parseInput(row.input_json);
  const app = appRefOf(row, await readMessageLabels(db, [row]));
  const occurredAt = row.finished_at ?? Date.now();
  const base = { occurredAt, dedupeKey: `job:${jobId}` };
  switch (row.kind) {
    case "install":
      return {
        ...base,
        type: "install_finished",
        facts: {
          type: "install_finished",
          app,
          version: str(input.version) ?? row.catalog_version,
          outcome,
          jobId,
        },
      };
    case "update": {
      const type = outcome === "succeeded" ? "update_applied" : "update_failed";
      return {
        ...base,
        type,
        facts: { type, app, from: str(input.fromVersion), to: str(input.version), jobId },
      };
    }
    case "uninstall":
      // Deleting what an uninstalled app kept is an uninstall job too; not news.
      if (input.deleteRetained === true) return null;
      // Removing what an install that did not finish left, for "Install
      // again": an install under the same name starts next, so "Uninstalled"
      // would mislead. Only its failure is news.
      if (typeof input.replacedBy === "string") {
        if (outcome === "succeeded") return null;
        return {
          ...base,
          type: "uninstall_finished",
          facts: { type: "uninstall_finished", app, outcome, jobId, replaced: true },
        };
      }
      return {
        ...base,
        type: "uninstall_finished",
        facts: { type: "uninstall_finished", app, outcome, jobId },
      };
    default:
      return null;
  }
}

/**
 * The event a finished move of Appflare's address makes; null while it has
 * not finished, undefined when the job is not such a move.
 */
async function moveEventOf(db: D1Database, jobId: string): Promise<JobEvent | null | undefined> {
  const row = await db
    .prepare(
      "SELECT status, input_json, finished_at FROM jobs WHERE id = ?1 AND kind = 'move_address'",
    )
    .bind(jobId)
    .first<{ status: string; input_json: string | null; finished_at: number | null }>();
  if (row === null) return undefined;
  if (row.status !== "succeeded" && row.status !== "failed") return null;
  const hostname = str(parseInput(row.input_json).hostname);
  if (hostname === null) return null;
  // A job can fail after its switch: Appflare then lives at the new address anyway.
  const current =
    row.status === "failed"
      ? await db
          .prepare("SELECT value FROM settings WHERE key = 'manager_hostname'")
          .first<{ value: string }>()
      : null;
  const moved = current?.value === hostname;
  return {
    type: "manager_move_finished",
    facts: {
      type: "manager_move_finished",
      hostname,
      outcome: row.status,
      jobId,
      ...(moved ? { moved: true } : {}),
    },
    occurredAt: row.finished_at ?? Date.now(),
    dedupeKey: `job:${jobId}`,
  };
}

/** Kinds whose end may make an event (job-end.ts checks this before anything else). */
export const NOTIFIED_JOB_KINDS: ReadonlySet<string> = new Set([
  "install",
  "update",
  "uninstall",
  "move_address",
]);

export interface DetectEnv {
  DB: D1Database;
  KV: KVNamespace;
  APPFLARE_VERSION: string;
}

/** Jobs that ended at most this long ago are left to the job's own step. */
export const JOB_SWEEP_LAG_MS = 60_000;
const JOB_SWEEP_LIMIT = 50;

/**
 * Events for jobs that ended since the last sweep and have none yet (their
 * own step failed, or they were settled from outside a job). The first
 * sweep only sets the cursor.
 */
export async function sweepFinishedJobs(
  db: D1Database,
  channels: readonly ChannelRow[],
  now: number,
): Promise<number> {
  const upTo = now - JOB_SWEEP_LAG_MS;
  const cursorRow = await db
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(JOBS_CURSOR_KEY)
    .first<{ value: string }>();
  const cursor = cursorRow === null ? null : Number(cursorRow.value);
  let next = upTo;
  let queued = 0;
  if (cursor !== null && Number.isFinite(cursor)) {
    const { results } = await db
      .prepare(
        `SELECT id, finished_at FROM jobs
         WHERE kind IN (${[...NOTIFIED_JOB_KINDS].map((k) => `'${k}'`).join(", ")})
           AND status IN ('succeeded', 'failed')
           AND finished_at > ?1 AND finished_at <= ?2
         ORDER BY finished_at LIMIT ?3`,
      )
      .bind(cursor, upTo, JOB_SWEEP_LIMIT)
      .all<{ id: string; finished_at: number }>();
    for (const job of results) {
      const event = await jobEventOf(db, job.id);
      if (event !== null) {
        const out = await emitEvent(
          db,
          channels,
          { ...event, channelsCreatedBy: event.occurredAt },
          now,
        );
        queued += out.queued;
      }
    }
    // A full page means more are waiting: continue after the last one next time.
    if (results.length === JOB_SWEEP_LIMIT) next = results.at(-1)?.finished_at ?? upTo;
  }
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(JOBS_CURSOR_KEY, String(next), now)
    .run();
  return queued;
}

const INSTALL_COLUMNS =
  "id, app_slug, catalog_id, worker_name, display_name, catalog_version, manifest_json, health_status, status, build_kind";

/**
 * Update available (apps and Appflare) and health failing, from the caches
 * the cron has just refreshed and the installs' recorded health.
 */
export async function detectConditions(
  env: DetectEnv,
  channels: readonly ChannelRow[],
  now: number,
  /** Installs the scheduled health check just found failing twice in a row. */
  confirmedFailing: ReadonlySet<string> = new Set(),
): Promise<number> {
  const db = env.DB;
  let queued = 0;
  const emit = async (event: JobEvent) => {
    queued += (await emitEvent(db, channels, event, now)).queued;
  };

  const needsInstalls = wants(channels, "update_available") || wants(channels, "health_failing");
  const installs = needsInstalls
    ? (
        await db.prepare(`SELECT ${INSTALL_COLUMNS} FROM installs WHERE status = 'installed'`).all<
          InstallRow & {
            catalog_id: string | null;
            health_status: string | null;
            status: string;
            build_kind: string;
          }
        >()
      ).results
    : [];
  // What messages call the installs, read only once a message may name one.
  let labels: Map<string, string> | undefined;
  const labelsOf = async () => {
    labels ??= await readMessageLabels(db, installs);
    return labels;
  };

  if (wants(channels, "update_available")) {
    // Every enabled catalog's cached index; each install is compared with its own catalog's.
    const apps = await catalogLookup(env, { refreshOnMiss: false });
    if (apps.size > 0) {
      const pending = pendingUpdates(
        installs.map((r) => ({
          id: r.id,
          status: r.status,
          appSlug: installAppKey(r),
          catalogVersion: r.catalog_version,
          buildKind: r.build_kind,
        })),
        new Map([...apps].map(([key, l]) => [key, { version: l.app.version, tier: l.app.tier }])),
        { current: env.APPFLARE_VERSION, latest: null, updateAvailable: false, activeJobId: null },
      );
      const byId = new Map(installs.map((r) => [r.id, r]));
      for (const update of pending.apps) {
        const row = byId.get(update.installId);
        if (row === undefined) continue;
        await emit({
          type: "update_available",
          // Apart from a plain update's: a manager from before the reinstall
          // notice may have sent this version as an update already.
          dedupeKey: `update_available:${row.id}:${update.latestVersion}${update.reinstall === true ? ":reinstall" : ""}`,
          occurredAt: now,
          facts: {
            type: "update_available",
            app: appRefOf(row, await labelsOf(), apps.get(installAppKey(row))?.app.name),
            from: update.version,
            to: update.latestVersion,
            ...(update.reinstall === true ? { reinstall: true as const } : {}),
          },
        });
      }
    }
  }

  if (wants(channels, "manager_update_available")) {
    const view = managerUpdateView(env.APPFLARE_VERSION, await readManagerLatest(env.KV));
    if (view.updateAvailable && view.latest !== null) {
      await emit({
        type: "manager_update_available",
        dedupeKey: `manager_update_available:${view.latest.version}`,
        occurredAt: now,
        facts: { type: "manager_update_available", from: view.current, to: view.latest.version },
      });
    }
  }

  if (wants(channels, "health_failing")) {
    const byId = new Map(installs.map((r) => [r.id, r]));
    // Only the scheduled check's own two failing probes open an episode.
    const opening = [...confirmedFailing].filter(
      (id) => byId.get(id)?.health_status === "unhealthy",
    );
    if (opening.length > 0) {
      await db.batch(
        opening.map((id) =>
          db
            .prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)")
            .bind(`${HEALTH_EPISODE_PREFIX}${id}`, String(now), now),
        ),
      );
    }
    // Read the starts back: a run that overlaps this one may have opened the
    // same episode first, and both must name it the same way.
    const { results: open } = await db
      .prepare("SELECT key, value FROM settings WHERE key LIKE ?1")
      .bind(`${HEALTH_EPISODE_PREFIX}%`)
      .all<{ key: string; value: string }>();
    const others = open
      .map((r) => r.key.slice(HEALTH_EPISODE_PREFIX.length))
      .filter((id) => !byId.has(id));
    const statusOf = new Map<string, string>();
    if (others.length > 0) {
      const { results } = await db
        .prepare("SELECT id, status FROM installs WHERE id IN (SELECT value FROM json_each(?1))")
        .bind(JSON.stringify(others))
        .all<{ id: string; status: string }>();
      for (const r of results) statusOf.set(r.id, r.status);
    }
    const closing: D1PreparedStatement[] = [];
    for (const { key, value: since } of open) {
      const id = key.slice(HEALTH_EPISODE_PREFIX.length);
      const row = byId.get(id);
      // An episode ends only when a check finds the app serving (`verified`)
      // or the app is gone. No answer at all (a timeout, a connection error,
      // the edge's route-not-live page) says nothing about the app, so it
      // neither ends an episode nor starts a new one.
      const ended =
        row === undefined
          ? !["updating", "installing"].includes(statusOf.get(id) ?? "uninstalled")
          : row.health_status === "verified";
      if (ended) {
        closing.push(db.prepare("DELETE FROM settings WHERE key = ?1").bind(key));
        continue;
      }
      if (row === undefined) continue;
      await emit({
        type: "health_failing",
        dedupeKey: `health_failing:${id}:${since}`,
        occurredAt: Number(since),
        facts: { type: "health_failing", app: appRefOf(row, await labelsOf()) },
      });
    }
    if (closing.length > 0) await db.batch(closing);
  }
  return queued;
}
