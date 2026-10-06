import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { isVersionPreviewHost } from "../../cloudflare/worker-name";
import { createDb } from "../../db/client";
import { jobs } from "../../db/schema";
import { readSettings, SETTING, writeSettings } from "../../db/settings";
import { runningVersion } from "../../server/build-version";
import type { StepConfig, StepRunner } from "../run-job";
import { StepLog } from "../step-log";
import { appendVersionHistory } from "./plan";

/**
 * The end of a self-update, shared by the job's last step, by the new
 * version's first request, and by reconciliation.
 *
 * Once the new version is promoted, the running Workflow instance may be
 * resumed on the new code, so the step after promotion must mean the same
 * thing in every version: its name ({@link RECORD_STEP}), its config, its
 * input (the job's params and row), and its result shape never change. It
 * marks the job `succeeded` and appends to `settings.manager_version_history`;
 * both are idempotent, so running it twice (old code, then new) is harmless.
 *
 * Nothing here completes a job whose `promoting_version` does not name its
 * target: the job writes that marker in the step right before the promotion.
 * The new code also serves the version's preview URL (the canary) before the
 * switch, against the same database, and must not complete the job there.
 */

/** Never rename: a newer version resumes this step by name. */
export const RECORD_STEP = "record";
const RECORD_CONFIG: StepConfig = {
  retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
};

export interface SelfUpdateRecord {
  jobId: string;
  /** The version the job moved to. */
  version: string;
  /** The version it replaced. */
  fromVersion: string;
}

const selfUpdateInput = z.looseObject({ version: z.string(), fromVersion: z.string() });

function parseInput(json: string | null): { version: string; fromVersion: string } | null {
  try {
    const parsed = selfUpdateInput.safeParse(JSON.parse(json ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Appends a promoted self-update to the version history, once per job. Does
 * nothing unless the job's promotion marker names its target version.
 */
export async function appendSelfUpdateHistory(
  db: D1Database,
  jobId: string,
  at: Date,
): Promise<boolean> {
  const orm = createDb(db);
  const [job] = await orm
    .select({
      input: jobs.input_json,
      promoting: jobs.promoting_version,
      workerVersionId: jobs.worker_version_id,
    })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.kind, "self_update")))
    .limit(1);
  const input = parseInput(job?.input ?? null);
  if (job === undefined || input === null || job.promoting !== input.version) return false;
  const current = await readSettings(orm, [SETTING.managerVersionHistory]);
  const next = appendVersionHistory(current.manager_version_history, {
    version: input.version,
    from: input.fromVersion,
    jobId,
    workerVersionId: job.workerVersionId,
    at: at.toISOString(),
  });
  if (next === current.manager_version_history) return false;
  await writeSettings(orm, { [SETTING.managerVersionHistory]: next }, at);
  return true;
}

/**
 * Marks a promoted job succeeded (if still queued or running) and records the
 * switch in the version history. Returns whether the job row changed.
 */
export async function recordSelfUpdate(
  db: D1Database,
  input: SelfUpdateRecord,
  at: Date,
): Promise<boolean> {
  const updated = await createDb(db)
    .update(jobs)
    .set({ status: "succeeded", finished_at: at, error: null })
    .where(
      and(
        eq(jobs.id, input.jobId),
        inArray(jobs.status, ["queued", "running"]),
        eq(jobs.promoting_version, input.version),
      ),
    )
    .returning({ id: jobs.id });
  await appendSelfUpdateHistory(db, input.jobId, at);
  return updated.length > 0;
}

/** The job's last step. Its name, config, and `{ recorded }` result never change. */
export async function recordStep(
  step: StepRunner,
  db: D1Database,
  input: SelfUpdateRecord,
  now: () => number,
): Promise<void> {
  await step.do(RECORD_STEP, RECORD_CONFIG, async () => {
    const recorded = await recordSelfUpdate(db, input, new Date(now()));
    if (recorded) {
      const log = new StepLog(now);
      log.info(`Appflare ${input.version} serves all traffic (was ${input.fromVersion}).`);
      await log.flush(db, input.jobId);
    }
    return { recorded };
  });
}

export interface FinalizeResult {
  /** Jobs this call completed. */
  completed: number;
  /** The request came to a version preview host; nothing was looked at beyond the jobs. */
  previewHost: boolean;
}

/**
 * On the first request a new manager version serves: a `self_update` job
 * still `running` whose target is this version and which reached its
 * promotion was cut off by the switch before its last step, so this version
 * completes it. Jobs aimed at other versions, or not promoted yet, are left
 * alone. Requests to a version preview host never complete anything.
 */
export async function finalizeSelfUpdates(
  env: { DB: D1Database; APPFLARE_VERSION: string },
  opts: { host?: string; now?: () => Date } = {},
): Promise<FinalizeResult> {
  const now = opts.now ?? (() => new Date());
  const orm = createDb(env.DB);
  const rows = await orm
    .select({ id: jobs.id, input: jobs.input_json })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, "self_update"),
        eq(jobs.status, "running"),
        eq(jobs.promoting_version, runningVersion(env)),
      ),
    );
  const candidates = rows.flatMap((row) => {
    const input = parseInput(row.input);
    return input !== null && input.version === runningVersion(env) ? [{ id: row.id, input }] : [];
  });
  if (candidates.length === 0) return { completed: 0, previewHost: false };
  if (opts.host !== undefined) {
    const { worker_name } = await readSettings(orm, [SETTING.workerName]);
    if (isVersionPreviewHost(opts.host, worker_name ?? null)) {
      return { completed: 0, previewHost: true };
    }
  }
  let completed = 0;
  for (const { id, input } of candidates) {
    const at = now();
    const changed = await recordSelfUpdate(
      env.DB,
      { jobId: id, version: input.version, fromVersion: input.fromVersion },
      at,
    );
    if (!changed) continue;
    const log = new StepLog(() => at.getTime());
    log.info(`Completed by the new version: Appflare ${input.version} serves all traffic.`);
    await log.flush(env.DB, id);
    completed += 1;
  }
  return { completed, previewHost: false };
}
