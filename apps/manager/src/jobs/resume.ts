import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { readAccountPlan } from "../account/plan.server";
import { requireConnection } from "../cloudflare/connection.server";
import { createDb } from "../db/client";
import { installs, jobs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { emitUsageEvent } from "../notifications/usage-events.server";
import { periodEnd } from "../usage/math";
import { recordActivity } from "../usage/store/activity.server";
import { effectiveSpendSettings, writeAppSpendSettings } from "../usage/store/app-settings.server";
import { closePause, findOpenPause, recordPauseProgress } from "../usage/store/pauses.server";
import { type ResumeJobParams, resumeJobParams } from "./pause/params";
import {
  instancesPerStep,
  type RecordedWorkerState,
  readRecordedWorker,
  restorePhases,
  workersGoneMessage,
} from "./pause/phases";
import { parsePausedContainers, parsePausedQueues, parsePausedWorkflows } from "./pause/records";
import type { JobContext } from "./run-job";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError } from "./steps";

/**
 * The `resume` job: puts back exactly what the app's pause recorded, then
 * closes the pause. Container applications allow their instances again
 * first, then every Worker serves the version it served before its
 * stand-in (at 100%), then the queues deliver again, then the paused
 * Workflow instances carry on (./pause/phases.ts).
 *
 * "Resume until the cap resets" also sets the app's spending cap aside
 * until the cap's period ends, so the cap does not pause it again at once;
 * the loop check still runs.
 *
 * When a step fails the pause stays open (Home still offers Resume) and the
 * activity says so (`resume_failed`): every step sets a recorded value, so
 * resuming again carries on where this one stopped.
 */

export async function runResume(ctx: JobContext): Promise<void> {
  const parsed = resumeJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid resume job payload");
  const params: ResumeJobParams = parsed.data;
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;
  let pauseId: string | null = null;
  let notice: { pauseId: string; pausedBy: string; capSetAsideUntil: number | null } | null = null;

  try {
    const started = await steps.start(async ({ log, orm }) => {
      const [install] = await orm
        .select({ status: installs.status })
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      if (install === undefined) throw new JobError("the install no longer exists");
      if (install.status !== "installed") {
        throw new JobError(`only an installed app can be resumed; this one is ${install.status}`);
      }
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      await requireConnection(env);
      const pause = await findOpenPause(orm, params.installId);
      if (pause === null) throw new JobError("the app is not paused");
      await recordPauseProgress(orm, pause.id, { resumeJobId: params.jobId });
      const recorded = {
        workerVersions: pause.workerVersions ?? {},
        containers: parsePausedContainers(pause.containersJson),
        queues: parsePausedQueues(pause.queuesJson),
        workflows: parsePausedWorkflows(pause.workflowsJson),
      };
      const workers = Object.keys(recorded.workerVersions);
      log.info(
        workers.length === 0
          ? "Resuming the app. Its pause recorded no Worker, so no Worker changes."
          : `Resuming the app: ${workers.map((w) => `"${w}"`).join(", ")} serve${workers.length === 1 ? "s" : ""} the version${workers.length === 1 ? "" : "s"} recorded before the pause again.`,
      );
      return {
        pauseId: pause.id,
        pausedBy: pause.pausedBy,
        accountId: settings.account_id,
        accountPaid: (await readAccountPlan(orm)) === "paid",
        recorded,
      };
    });
    if (started === null) return;
    pauseId = started.pauseId;
    steps.setAccountId(started.accountId);
    if (!started.accountPaid) steps.spreadOverInvocations();

    // Each Worker read in a step of its own, before anything changes, and
    // not again when it is put back.
    const read: Record<string, RecordedWorkerState> = {};
    for (const [script, versionId] of Object.entries(started.recorded.workerVersions)) {
      read[script] = await readRecordedWorker(steps, script, versionId);
    }
    // Every Worker the pause recorded was deleted outside Appflare: nothing
    // is put back for an app that cannot run, and the pause stays open
    // until the app is uninstalled. Decided from the reads, with no request.
    const workers = Object.keys(started.recorded.workerVersions);
    if (workers.length > 0) {
      await run("check the app's Workers", async ({ log }) => {
        const gone = workers.filter((script) => read[script] === "gone");
        if (gone.length === workers.length) throw new JobError(workersGoneMessage(gone, "resume"));
        if (gone.length > 0) {
          log.warn(
            `${gone.map((w) => `"${w}"`).join(", ")} ${gone.length === 1 ? "is" : "are"} gone from the account; the app's other Workers run again.`,
          );
        }
        return {};
      });
    }

    await restorePhases(steps, started.recorded, {
      perStep: instancesPerStep(started.accountPaid),
      read,
    });

    const finished = await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      let capSetAsideUntil: number | null = null;
      if (params.untilCapResets) {
        const settings = await effectiveSpendSettings(orm, params.installId);
        capSetAsideUntil = periodEnd(settings.triggers.cap.period, at.getTime());
        await writeAppSpendSettings(
          orm,
          params.installId,
          { capSetAsideUntil },
          { userId: params.by, now: at },
        );
      }
      // Closed last: the cap is set aside before the app counts as running again.
      const closed = await closePause(orm, params.installId, {
        resumedBy: params.by,
        resumedAt: at,
        resumeJobId: params.jobId,
      });
      await orm
        .update(jobs)
        .set({ status: "succeeded", finished_at: at, error: null })
        .where(eq(jobs.id, params.jobId));
      if (capSetAsideUntil !== null) {
        await recordActivity(orm, {
          installId: params.installId,
          kind: "cap_set_aside",
          facts: { until: capSetAsideUntil },
          by: params.by,
          at,
        });
      }
      if (closed !== null) {
        await recordActivity(orm, {
          installId: params.installId,
          kind: "resumed",
          facts: { pauseId: closed.id, jobId: params.jobId },
          by: params.by,
          at,
        });
      }
      log.info(
        capSetAsideUntil === null
          ? "The app runs again."
          : `The app runs again. Its spending cap is set aside until ${new Date(capSetAsideUntil).toISOString()}, when its period resets; the loop check still runs.`,
      );
      return { capSetAsideUntil };
    });
    notice = {
      pauseId: started.pauseId,
      pausedBy: started.pausedBy,
      capSetAsideUntil: finished.capSetAsideUntil,
    };
  } catch (error) {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    const pause = pauseId;
    await step.do("mark resume failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      const log = new StepLog(now);
      if (pause === null) {
        log.error(`Resume failed at "${failedAt}". Nothing was changed.`);
      } else {
        await recordActivity(orm, {
          installId: params.installId,
          kind: "resume_failed",
          facts: { pauseId: pause, jobId: params.jobId, error: reason },
          by: params.by,
          at,
        });
        log.error(
          `Resume failed at "${failedAt}". The app stays paused; resume it again to carry on from there.`,
        );
      }
      await log.flush(env.DB, params.jobId);
      return {};
    });
    throw new NonRetryableError(reason);
  }

  // Outside the job's own work: a notification that cannot be recorded
  // never fails a resume that finished.
  const resumed = notice;
  if (resumed !== null) {
    try {
      await step.do("tell notification channels", async () => {
        const outcome = await emitUsageEvent(env, {
          type: "app_resumed",
          installId: params.installId,
          pauseId: resumed.pauseId,
          pausedBy: resumed.pausedBy,
          resumedBy: params.by,
          capSetAsideUntil: resumed.capSetAsideUntil,
        });
        return { status: outcome.status };
      });
    } catch (error) {
      console.warn("resume notification failed", {
        jobId: params.jobId,
        error: errorMessage(error),
      });
    }
  }
}
