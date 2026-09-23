import { eq, inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import {
  isManagerUpdateAvailable,
  type ManagerRelease,
} from "../../catalog/manager-releases.server";
import { createDb } from "../../db/client";
import { jobs } from "../../db/schema";
import { readSettings, SETTING } from "../../db/settings";
import { reconcileJobs, type WorkflowLookup } from "../reconcile.server";
import type { SelfUpdateJobParams } from "../self-update";

/**
 * Starting a self-update. The job row is the claim: it is inserted only when
 * no job at all is queued or running (see ./guard.ts for why), then the
 * `JobWorkflow` instance is created.
 */

export class SelfUpdateError extends Error {
  override name = "SelfUpdateError";
}

export interface StartSelfUpdateDeps {
  db: D1Database;
  /** The stored newest release (`manager:latest`), or null. */
  latest: ManagerRelease | null;
  /** The running `APPFLARE_VERSION`. */
  currentVersion: string;
  /** `CF_API_TOKEN` is bound to the running version. */
  hasToken: boolean;
  /** For settling jobs whose Workflow instance died, so they do not block the update. */
  workflows: WorkflowLookup;
  createJob(id: string, params: SelfUpdateJobParams): Promise<{ id: string }>;
  now?: () => Date;
  newId?: () => string;
}

const BUSY =
  "Another job is queued or running. Appflare updates itself only when nothing else runs; wait for it to finish.";

export async function startSelfUpdateCore(
  deps: StartSelfUpdateDeps,
  request: { version: string },
): Promise<{ jobId: string }> {
  const { latest, currentVersion } = deps;
  if (latest === null) {
    throw new SelfUpdateError("No Appflare release is known yet. Check for updates first.");
  }
  if (request.version !== latest.version) {
    throw new SelfUpdateError(
      `${request.version} is not the newest Appflare release (${latest.version}). Reload the page.`,
    );
  }
  if (!isManagerUpdateAvailable(currentVersion, latest.version)) {
    throw new SelfUpdateError(
      `Appflare ${latest.version} is not newer than the running version ${currentVersion}.`,
    );
  }
  const orm = createDb(deps.db);
  const settings = await readSettings(orm, [SETTING.accountId, SETTING.workerName]);
  if (!settings.account_id || !settings.worker_name || !deps.hasToken) {
    throw new SelfUpdateError(
      "Appflare does not know its Cloudflare account and Worker yet. Finish setup first.",
    );
  }

  const active = await orm
    .select()
    .from(jobs)
    .where(inArray(jobs.status, ["queued", "running"]));
  if (active.length > 0) await reconcileJobs(deps.db, deps.workflows, active);

  const now = (deps.now ?? (() => new Date()))();
  const jobId = (deps.newId ?? (() => ulid()))();
  const params: SelfUpdateJobParams = {
    kind: "self_update",
    jobId,
    version: latest.version,
    fromVersion: currentVersion,
    tag: latest.tag,
    artifacts: latest.assets,
  };
  const claimed = await deps.db
    .prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json)
       SELECT ?1, NULL, 'self_update', 'queued', ?2
       WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE status IN ('queued', 'running'))`,
    )
    .bind(
      jobId,
      JSON.stringify({ version: latest.version, fromVersion: currentVersion, tag: latest.tag }),
    )
    .run();
  if (claimed.meta.changes !== 1) throw new SelfUpdateError(BUSY);

  let instanceId: string;
  try {
    instanceId = (await deps.createJob(jobId, params)).id;
  } catch (error) {
    const reason = `start: could not create the job: ${error instanceof Error ? error.message : String(error)}`;
    await orm
      .update(jobs)
      .set({ status: "failed", error: reason, finished_at: now })
      .where(eq(jobs.id, jobId));
    throw new SelfUpdateError(reason);
  }
  await orm.update(jobs).set({ workflow_instance_id: instanceId }).where(eq(jobs.id, jobId));
  return { jobId };
}
