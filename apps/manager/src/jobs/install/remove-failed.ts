import { startUninstallCore } from "../../installs/start-uninstall.server";
import { jobCreator } from "../create-job.server";
import type { JobEnv, StepRunner } from "../run-job";
import { StepLog } from "../step-log";
import { errorMessage } from "../steps";

/**
 * What the "set cron triggers" refusal of an install says happens to the
 * Worker: the install removes what it created (see
 * {@link removeFailedInstallPhase}).
 */
export const CRON_REFUSED_UNDO = "Appflare removes what this install created.";

/**
 * How the admin goes on once there is room: the removed install has no
 * "Install again" any more, so from the app's catalog page.
 */
export const CRON_REFUSED_NEXT = "then install the app again from its catalog page";

/**
 * After an install failed in a way installing it again would meet too
 * (Cloudflare refused its cron triggers at the account's limit), starts the
 * uninstall of what it created, keeping nothing, as the admin's Uninstall
 * would; its progress is that job's. The install is `failed` by now, so the
 * uninstall's claim succeeds unless another job of the install started in
 * between. When it cannot start, the log says how to remove it by hand.
 * Never throws: the install's own failure is what the job reports.
 */
export async function removeFailedInstallPhase(
  ctx: { step: StepRunner; env: JobEnv; params: { installId: string; jobId: string } },
  now: () => number,
): Promise<void> {
  const { step, env, params } = ctx;
  await step.do("remove what the install created", async () => {
    const log = new StepLog(now);
    try {
      if (env.JOBS === undefined) throw new Error("this manager cannot start jobs from a job");
      const { jobId } = await startUninstallCore(
        { db: env.DB, createJob: jobCreator(env.JOBS), now: () => new Date(now()) },
        { installId: params.installId },
      );
      log.info(
        `Removing what this install created, so nothing of it stays in the account (job ${jobId}).`,
      );
    } catch (error) {
      log.warn(
        `Could not start removing what this install created (${errorMessage(error)}). Uninstall it from the danger zone of its page to remove it.`,
      );
    }
    await log.flush(env.DB, params.jobId);
    return {};
  });
}
