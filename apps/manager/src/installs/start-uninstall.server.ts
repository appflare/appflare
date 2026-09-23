import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulidx";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import type { UninstallJobParams } from "../jobs/uninstall";
import { DATA_RESOURCE_KINDS, isDataResourceKind } from "./resource-kinds";

/**
 * Starting an uninstall: check the install can be uninstalled, check every
 * ticked resource belongs to it, then in one D1 batch record the job, set the
 * install `uninstalling`, and mark the unticked data resources retained (they
 * stay in the account and stay findable). Then create the `JobWorkflow`
 * instance. A retry re-runs the job for whatever is still neither deleted nor
 * retained, so a resource the admin chose to keep is never deleted by a retry;
 * the admin may keep more at that point (for example a bucket that cannot be
 * deleted).
 */

export class StartUninstallError extends Error {
  override name = "StartUninstallError";
}

export interface StartUninstallDeps {
  db: D1Database;
  /** Creates the Workflow instance (`env.JOBS.create`). */
  createJob(id: string, params: UninstallJobParams): Promise<{ id: string }>;
  now?: () => Date;
  newId?: () => string;
}

export interface StartUninstallRequest {
  installId: string;
  /** Continue an uninstall that stopped part way (the install is `uninstalling`). */
  retry?: boolean;
  /**
   * Data resources to delete; the others are kept. Omitted: every data
   * resource that is neither deleted nor kept yet.
   */
  deleteResources?: string[];
}

/** Statuses a first uninstall may start from. A `failed` install may hold resources too. */
const STARTABLE = ["installed", "failed"] as const;

const DATA_KINDS_SQL = DATA_RESOURCE_KINDS.map((k) => `'${k}'`).join(", ");

export async function startUninstallCore(
  deps: StartUninstallDeps,
  request: StartUninstallRequest,
): Promise<{ jobId: string }> {
  const db = createDb(deps.db);
  const now = (deps.now ?? (() => new Date()))();
  const jobId = (deps.newId ?? (() => ulid()))();
  const retry = request.retry === true;

  const [install] = await db
    .select({ status: installs.status, workerName: installs.worker_name })
    .from(installs)
    .where(eq(installs.id, request.installId))
    .limit(1);
  if (install === undefined) throw new StartUninstallError("There is no such install.");
  const refusal = retry ? retryRefusal(install.status) : startRefusal(install.status);
  if (refusal !== null) throw new StartUninstallError(refusal);

  // Data resources still in the account that nobody chose to keep.
  const pending = await db
    .select({ id: resources.id, kind: resources.kind })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, request.installId),
        isNull(resources.deleted_at),
        isNull(resources.retained_at),
      ),
    );
  let deleteResources: string[];
  if (request.deleteResources === undefined) {
    deleteResources = pending.filter((r) => isDataResourceKind(r.kind)).map((r) => r.id);
  } else {
    const known = new Map(pending.map((r) => [r.id, r.kind]));
    const unknown = request.deleteResources.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new StartUninstallError(
        `Not a resource of this install that still exists: ${unknown.join(", ")}.`,
      );
    }
    // Worker-bound resources go with the Worker whether ticked or not.
    deleteResources = [...new Set(request.deleteResources)].filter((id) =>
      isDataResourceKind(known.get(id) ?? ""),
    );
  }

  const params: UninstallJobParams = {
    kind: "uninstall",
    jobId,
    installId: request.installId,
    deleteResources,
  };
  const statuses = (retry ? ["uninstalling"] : STARTABLE).map((s) => `'${s}'`).join(", ");
  const at = now.getTime();
  // One batch (a transaction). The job row is the claim: it is inserted only if
  // the install is in a startable state and no job of this install is queued or
  // running, and the other two statements apply only if it was inserted.
  const [claimed] = await deps.db.batch([
    deps.db
      .prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json)
         SELECT ?1, ?2, 'uninstall', 'queued', ?3
         WHERE EXISTS (SELECT 1 FROM installs WHERE id = ?2 AND status IN (${statuses}))
           AND NOT EXISTS (
             SELECT 1 FROM jobs WHERE install_id = ?2 AND status IN ('queued', 'running')
           )`,
      )
      .bind(
        jobId,
        request.installId,
        JSON.stringify({ installId: request.installId, deleteResources, retry }),
      ),
    deps.db
      .prepare(
        `UPDATE installs SET status = 'uninstalling', updated_at = ?3
         WHERE id = ?2 AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1)`,
      )
      .bind(jobId, request.installId, at),
    deps.db
      .prepare(
        `UPDATE resources SET retained_at = ?3
         WHERE install_id = ?2 AND deleted_at IS NULL AND retained_at IS NULL
           AND kind IN (${DATA_KINDS_SQL})
           AND id NOT IN (SELECT value FROM json_each(?4))
           AND EXISTS (SELECT 1 FROM jobs WHERE id = ?1)`,
      )
      .bind(jobId, request.installId, at, JSON.stringify(deleteResources)),
  ]);
  if (claimed?.meta.changes !== 1) {
    throw new StartUninstallError(
      "Another job of this install is queued or running, or its state changed. Reload the page.",
    );
  }

  let instanceId: string;
  try {
    instanceId = (await deps.createJob(jobId, params)).id;
  } catch (error) {
    // The install stays `uninstalling`, so "Retry uninstall" is offered.
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await db
      .update(jobs)
      .set({ status: "failed", error: reason, finished_at: now })
      .where(eq(jobs.id, jobId));
    throw new StartUninstallError(reason);
  }
  await db.update(jobs).set({ workflow_instance_id: instanceId }).where(eq(jobs.id, jobId));
  return { jobId };
}

function startRefusal(status: string): string | null {
  switch (status) {
    case "installed":
    case "failed":
      return null;
    case "uninstalling":
      return "An uninstall of this install already started. Retry it instead.";
    case "uninstalled":
      return "This install is already uninstalled.";
    default:
      return "A job of this install is running. Wait for it to finish.";
  }
}

function retryRefusal(status: string): string | null {
  return status === "uninstalling" ? null : "Only an unfinished uninstall can be retried.";
}
