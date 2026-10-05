import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { job_logs, jobs } from "../../db/schema";
import { firstLine } from "../../sandbox/failure-hint";
import type { StepRunner } from "../run-job";
import { JobError, type JobSteps } from "../steps";

/**
 * "Install again": an install that replaces a failed one whose resources
 * are still in the account carries the id of the `uninstall` job its start
 * claimed for them, and waits for that job before anything else. The new
 * install checks every name it creates is free and never adopts what exists,
 * so only a completed removal lets it create the same names again, and
 * nothing of the failed attempt is left behind or duplicated.
 *
 * Each poll is one step that makes one D1 query (the removal job's status
 * with its new log lines, not the API request lines) and writes this job's
 * log only when it copied lines. D1 calls are planned as subrequests (see
 * ../units/client.ts), and the short sleeps between polls share the job's
 * invocation, so the polls back off: 5, 10, 20 and 40 seconds apart, which
 * sees a removal of a few resources at the first or second poll. A removal
 * still running after that is polled 5 minutes apart, a sleep long enough to
 * resume in a fresh invocation, so the wait never spends more than about 10
 * of the install's subrequests (five polls, each with at most one log write).
 */

/** The job params field: the removal of the failed install to wait for. */
export const cleanupJobField = z.string().min(1).max(64).optional();

export const CLEANUP_WAIT = {
  /** Seconds to sleep after each poll, in order; the wait gives up after the last. */
  sleeps: [5, 10, 20, 40, 300, 300, 300, 300] as const,
  /** Log lines copied per poll. */
  linesPerPoll: 40,
} as const;

/** The start step's line for an install that waits for a removal (logged there, at no extra write). */
export const CLEANUP_WAIT_NOTE =
  "This replaces an install that did not finish. What it left in the account is removed first; its progress follows.";

/** The step name of every poll; the failure reason names it without the count. */
export const CLEANUP_WAIT_STEP = "wait for the failed install's removal";

/** What the job log says when the removal failed: where to finish it, and what then. */
export function cleanupFailedMessage(cleanupJobId: string, error: string | null): string {
  return `what the install that did not finish left could not all be removed (job ${cleanupJobId}): ${firstLine(error) ?? "it failed"}. Nothing of this install was created. Open the app page of the earlier install, finish uninstalling it from its danger zone, then use Install again on this install's page`;
}

interface PollResult {
  status: string;
  lastLogId: number;
}

/** Returns once the removal job succeeded; throws `JobError` when it failed or took too long. */
export async function awaitCleanupPhase(
  steps: JobSteps,
  step: StepRunner,
  cleanupJobId: string,
): Promise<void> {
  let lastLogId = 0;
  for (let poll = 1; ; poll++) {
    const seen: PollResult = await steps.run(
      `${CLEANUP_WAIT_STEP} (${poll})`,
      async ({ log, orm }) => {
        // One query: the job, with the log lines it wrote since the last poll.
        const rows = await orm
          .select({
            status: jobs.status,
            error: jobs.error,
            lineId: job_logs.id,
            level: job_logs.level,
            message: job_logs.message,
          })
          .from(jobs)
          .leftJoin(
            job_logs,
            and(
              eq(job_logs.job_id, jobs.id),
              gt(job_logs.id, lastLogId),
              inArray(job_logs.level, ["info", "warn", "error"]),
            ),
          )
          .where(and(eq(jobs.id, cleanupJobId), eq(jobs.kind, "uninstall")))
          .orderBy(asc(job_logs.id))
          .limit(CLEANUP_WAIT.linesPerPoll);
        const job = rows[0];
        if (job === undefined) {
          throw new JobError(
            `the job ${cleanupJobId} that removes the failed install is not recorded`,
          );
        }
        let last = lastLogId;
        for (const row of rows) {
          if (row.lineId === null || row.level === null || row.message === null) continue;
          log.log(row.level, `Removing the failed install: ${row.message}`);
          last = row.lineId;
        }
        if (job.status === "failed") {
          throw new JobError(cleanupFailedMessage(cleanupJobId, job.error));
        }
        return { status: job.status, lastLogId: last };
      },
    );
    lastLogId = seen.lastLogId;
    if (seen.status === "succeeded") return;
    const seconds = CLEANUP_WAIT.sleeps[poll - 1];
    if (seconds === undefined) {
      steps.current = CLEANUP_WAIT_STEP;
      throw new JobError(
        `the install that did not finish is still being removed after about 20 minutes (job ${cleanupJobId}). Nothing of this install was created; once that job has finished, use Install again on this install's page`,
      );
    }
    await step.sleep(`${CLEANUP_WAIT_STEP} (${poll}) pause`, `${seconds} seconds`);
  }
}
