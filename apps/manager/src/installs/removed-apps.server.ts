import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { installAppKey } from "../catalog/sources";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import type { WorkflowLookup } from "../jobs/reconcile.server";
import {
  activeSelfJob,
  NO_ACTIVE_SELF_UPDATE_SQL,
  refuseDuringSelfUpdate,
  selfUpdateBusyMessage,
} from "../jobs/self-update/guard";
import type { UninstallJobParams } from "../jobs/uninstall";
import { namedInstall, readInstallLabels } from "./install-names.server";
import { DATA_RESOURCE_KINDS } from "./resource-kinds";

/**
 * Removed apps: uninstalled installs that still keep data resources in the
 * account (the admin unticked them in the uninstall dialog). They leave the
 * list of installed apps and are listed on the Removed apps settings page
 * until nothing they kept is left, or until an admin forgets them. Two
 * actions:
 *
 * - Delete retained data: an `uninstall` job with `deleteRetained`, which
 *   runs only the uninstall's data resource steps, for everything kept. A
 *   kept resource addressed by name (a bucket or index, or one with no
 *   Cloudflare id recorded) whose name another install records (see
 *   `namesHeldElsewhere`) is never addressed.
 * - Forget: sets `installs.forgotten_at`, which only hides the row. The
 *   resources stay in the account, recorded as kept; nothing is deleted.
 *
 * An uninstalled install with nothing kept is not listed at all. No row is
 * ever deleted: the install, its resources, and its jobs stay as history.
 */

export class RemovedAppsError extends Error {
  override name = "RemovedAppsError";
}

export interface RetainedResourceView {
  id: string;
  kind: string;
  binding: string | null;
  name: string;
  cfId: string | null;
}

export interface RemovedAppView {
  id: string;
  slug: string;
  /** What the UI calls the install (`distinctLabels`). */
  label: string;
  workerName: string;
  /** ISO 8601 */
  uninstalledAt: string | null;
  /** What the uninstall kept in the account and nothing has deleted since. */
  retained: RetainedResourceView[];
  /** The job queued or running for this install (a deletion of kept data), if any. */
  activeJobId: string | null;
  /** The last deletion of kept data that failed, when it is the install's latest job. */
  lastFailure: { jobId: string; error: string | null } | null;
}

const DATA_KINDS_SQL = DATA_RESOURCE_KINDS.map((k) => `'${k}'`).join(", ");

/** Whether a job row is a deletion of kept data (an `uninstall` job with `deleteRetained`). */
export function isDeleteRetainedJob(row: { kind: string; input_json?: string | null }): boolean {
  if (row.kind !== "uninstall" || row.input_json == null) return false;
  try {
    return (JSON.parse(row.input_json) as { deleteRetained?: unknown }).deleteRetained === true;
  } catch {
    return false;
  }
}

/**
 * Kinds whose Cloudflare object is addressed by name, and whose name an
 * install derives from its Worker name (`<workerName>-<binding>`). A later
 * install under the same Worker name can own an object of the same name,
 * for example after the kept one was deleted in the dashboard. KV
 * namespaces, D1 databases, queues and Hyperdrive configs are addressed by
 * an id Cloudflare assigns, so a new one never shares it, unless no id was
 * recorded (the name is recorded before the create, and the id after it):
 * such a row is looked up by name as well.
 */
export const NAME_ADDRESSED_KINDS = ["r2", "vectorize"] as const;

/** Whether a resource row is addressed by its name: a kind that always is, or no id recorded. */
function addressedByName(row: { kind: string; cfId: string | null }): boolean {
  return row.cfId === null || (NAME_ADDRESSED_KINDS as readonly string[]).includes(row.kind);
}

/**
 * The resources among `rows` (of install `installId`) whose kind and name,
 * or recorded Cloudflare id, another install records as not deleted: a
 * resource under that name belongs to that install now, so nothing done for
 * `installId` may address it. Only rows addressed by name are considered.
 * Returns resource id to the other install's Worker name.
 */
export async function namesHeldElsewhere(
  d1: D1Database,
  installId: string,
  rows: ReadonlyArray<{ id: string; kind: string; name: string; cfId: string | null }>,
): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  const named = rows.filter(addressedByName);
  if (named.length === 0) return held;
  const kinds = [...new Set(named.map((r) => r.kind))];
  const others = await d1
    .prepare(
      `SELECT r.kind, r.name, r.cf_id, i.worker_name
       FROM resources r JOIN installs i ON i.id = r.install_id
       WHERE r.install_id != ?1 AND r.deleted_at IS NULL
         AND r.kind IN (${kinds.map((_, i) => `?${i + 2}`).join(", ")})`,
    )
    .bind(installId, ...kinds)
    .all<{ kind: string; name: string; cf_id: string | null; worker_name: string }>();
  for (const row of named) {
    const addresses = new Set([row.name, row.cfId].filter((a): a is string => a !== null));
    const owner = others.results.find(
      (o) =>
        o.kind === row.kind &&
        (addresses.has(o.name) || (o.cf_id !== null && addresses.has(o.cf_id))),
    );
    if (owner !== undefined) held.set(row.id, owner.worker_name);
  }
  return held;
}

/** Which installs are removed apps: uninstalled, not forgotten, and still keeping something. */
function isRemovedApp() {
  return and(
    eq(installs.status, "uninstalled"),
    isNull(installs.forgotten_at),
    sql`EXISTS (SELECT 1 FROM resources r WHERE r.install_id = ${installs.id}
          AND r.retained_at IS NOT NULL AND r.deleted_at IS NULL)`,
  );
}

/** How many removed apps there are, for the settings menu, which lists Removed apps only then (`getLayoutData`). */
export async function countRemovedAppsCore(d1: D1Database): Promise<number> {
  const [row] = await createDb(d1)
    .select({ count: sql<number>`count(*)` })
    .from(installs)
    .where(isRemovedApp());
  return row?.count ?? 0;
}

/** Removed apps that still keep something and were not forgotten, most recently uninstalled first. */
export async function listRemovedAppsCore(d1: D1Database): Promise<RemovedAppView[]> {
  const db = createDb(d1);
  const rows = await db
    .select()
    .from(installs)
    .where(isRemovedApp())
    .orderBy(desc(installs.uninstalled_at), desc(installs.id));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [kept, jobRows, labels] = await Promise.all([
    db
      .select()
      .from(resources)
      .where(
        and(
          inArray(resources.install_id, ids),
          isNotNull(resources.retained_at),
          isNull(resources.deleted_at),
        ),
      )
      .orderBy(sql`rowid`),
    db
      .select({
        id: jobs.id,
        installId: jobs.install_id,
        kind: jobs.kind,
        status: jobs.status,
        error: jobs.error,
        input_json: jobs.input_json,
      })
      .from(jobs)
      .where(inArray(jobs.install_id, ids))
      .orderBy(desc(jobs.id)),
    readInstallLabels(d1, rows.map(namedInstall)),
  ]);
  return rows.map((row) => {
    const own = jobRows.filter((j) => j.installId === row.id);
    const active = own.find((j) => j.status === "queued" || j.status === "running");
    const latest = own[0];
    return {
      id: row.id,
      // The app key, so a custom catalog's app is looked up in that catalog only.
      slug: installAppKey(row),
      label: labels.get(row.id) ?? row.worker_name,
      workerName: row.worker_name,
      uninstalledAt: row.uninstalled_at?.toISOString() ?? null,
      retained: kept
        .filter((r) => r.install_id === row.id)
        .map((r) => ({ id: r.id, kind: r.kind, binding: r.binding, name: r.name, cfId: r.cf_id })),
      activeJobId: active?.id ?? null,
      lastFailure:
        latest !== undefined && latest.status === "failed" && isDeleteRetainedJob(latest)
          ? { jobId: latest.id, error: latest.error }
          : null,
    };
  });
}

/**
 * Hides an uninstalled install from the removed apps. Only the row's
 * `forgotten_at` changes: whatever it kept stays in the account, recorded as
 * kept, and its history stays. Refused while a job of the install runs.
 * Forgetting twice is a no-op.
 */
export async function forgetRemovedAppCore(
  d1: D1Database,
  installId: string,
  now: Date = new Date(),
): Promise<void> {
  const db = createDb(d1);
  const [install] = await db
    .select({ status: installs.status, forgottenAt: installs.forgotten_at })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) throw new RemovedAppsError("There is no such install.");
  if (install.status !== "uninstalled") {
    throw new RemovedAppsError("Only an uninstalled app can be forgotten.");
  }
  if (install.forgottenAt !== null) return;
  const result = await d1
    .prepare(
      `UPDATE installs SET forgotten_at = ?2
       WHERE id = ?1 AND status = 'uninstalled' AND forgotten_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM jobs WHERE install_id = ?1 AND status IN ('queued', 'running')
         )`,
    )
    .bind(installId, now.getTime())
    .run();
  if (result.meta.changes !== 1) {
    throw new RemovedAppsError(
      "A job of this install is queued or running. Wait for it to finish, then try again.",
    );
  }
}

export interface StartDeleteRetainedDeps {
  db: D1Database;
  /** The Workflow binding, to settle a self-update whose instance died before refusing to start. */
  workflows?: WorkflowLookup;
  /** Creates the Workflow instance (`env.JOBS.create`). */
  createJob(id: string, params: UninstallJobParams): Promise<{ id: string }>;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Starts deleting everything an uninstalled install kept in the account.
 * The job row is the claim: it is inserted only while the install is
 * `uninstalled`, no job of the install is queued or running, and the manager
 * is not updating itself. The install stays `uninstalled` throughout.
 */
export async function startDeleteRetainedCore(
  deps: StartDeleteRetainedDeps,
  installId: string,
): Promise<{ jobId: string }> {
  await refuseDuringSelfUpdate(deps.db, deps.workflows, (m) => new RemovedAppsError(m));
  const db = createDb(deps.db);
  const now = (deps.now ?? (() => new Date()))();
  const jobId = (deps.newId ?? (() => ulid()))();

  const [install] = await db
    .select({ status: installs.status })
    .from(installs)
    .where(eq(installs.id, installId))
    .limit(1);
  if (install === undefined) throw new RemovedAppsError("There is no such install.");
  if (install.status !== "uninstalled") {
    throw new RemovedAppsError(
      "Only an uninstalled app's kept data is deleted here; uninstall the app instead.",
    );
  }
  const kept = await db
    .select({ id: resources.id, kind: resources.kind, name: resources.name, cfId: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        isNull(resources.deleted_at),
        isNotNull(resources.retained_at),
        eq(resources.managed_by, "appflare"),
        inArray(resources.kind, [...DATA_RESOURCE_KINDS]),
      ),
    )
    .orderBy(sql`rowid`);
  if (kept.length === 0) {
    throw new RemovedAppsError("Nothing this app kept is left in the account.");
  }
  // A bucket or index (or anything with no id recorded) whose name a later
  // install records belongs to that install now. When that is all that is
  // left, there is nothing to start; otherwise the job leaves those alone
  // (and checks again when it runs).
  const held = await namesHeldElsewhere(deps.db, installId, kept);
  if (held.size === kept.length) {
    const names = kept.map((r) => `${r.name} (now used by "${held.get(r.id)}")`).join(", ");
    throw new RemovedAppsError(
      `Everything this app kept has a name another install uses now: ${names}. Appflare never deletes another install's data. Forget this app to stop listing it.`,
    );
  }
  const deleteResources = kept.map((r) => r.id);

  const claimed = await deps.db
    .prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json)
       SELECT ?1, ?2, 'uninstall', 'queued', ?3
       WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status = 'uninstalled')
         AND NOT EXISTS (
           SELECT 1 FROM jobs WHERE install_id = ?2 AND status IN ('queued', 'running')
         )
         AND EXISTS (
           SELECT 1 FROM resources WHERE install_id = ?2 AND deleted_at IS NULL
             AND retained_at IS NOT NULL AND kind IN (${DATA_KINDS_SQL})
         )
         AND ${NO_ACTIVE_SELF_UPDATE_SQL}`,
    )
    .bind(jobId, installId, JSON.stringify({ installId, deleteResources, deleteRetained: true }))
    .run();
  if (claimed.meta.changes !== 1) {
    const selfUpdate = await activeSelfJob(deps.db);
    if (selfUpdate !== null) throw new RemovedAppsError(selfUpdateBusyMessage(selfUpdate));
    throw new RemovedAppsError(
      "Another job of this install is queued or running, or its state changed. Reload the page.",
    );
  }

  let instanceId: string;
  try {
    instanceId = (
      await deps.createJob(jobId, {
        kind: "uninstall",
        jobId,
        installId,
        deleteResources,
        deleteRetained: true,
      })
    ).id;
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await db
      .update(jobs)
      .set({ status: "failed", error: reason, finished_at: now })
      .where(eq(jobs.id, jobId));
    throw new RemovedAppsError(reason);
  }
  await db.update(jobs).set({ workflow_instance_id: instanceId }).where(eq(jobs.id, jobId));
  return { jobId };
}

/**
 * The admin actions as the server functions run them: `authorize` (the
 * admin check) runs first and throws for anyone else, before anything is
 * read or written.
 */
export async function deleteRetainedDataAs(
  authorize: () => Promise<unknown>,
  deps: StartDeleteRetainedDeps,
  installId: string,
): Promise<{ jobId: string }> {
  await authorize();
  return startDeleteRetainedCore(deps, installId);
}

export async function forgetRemovedAppAs(
  authorize: () => Promise<unknown>,
  d1: D1Database,
  installId: string,
  now?: Date,
): Promise<void> {
  await authorize();
  await forgetRemovedAppCore(d1, installId, now);
}
