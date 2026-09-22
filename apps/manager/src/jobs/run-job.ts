import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import { JOB_KINDS, type JobKind, jobs } from "../db/schema";

/**
 * Job dispatch for `JobWorkflow` (one Workflow class, dispatching on
 * `kind`). Kept free of the Workflow class so it can be tested with a fake step.
 */

/**
 * The subset of `WorkflowStep` jobs use. `WorkflowStep` is an RPC stub: call
 * `step.do(...)` as a method on it, never `step.do.bind(step)`.
 */
export interface StepRunner {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export const jobParams = z.object({
  kind: z.enum(JOB_KINDS),
  jobId: z.string().min(1),
});
export type JobParams = z.infer<typeof jobParams>;

export interface JobContext {
  params: JobParams;
  step: StepRunner;
  db: D1Database;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

export const NOT_IMPLEMENTED = "not implemented";

export async function markJobFailed(db: D1Database, jobId: string, error: string): Promise<void> {
  await createDb(db)
    .update(jobs)
    .set({ status: "failed", error, finished_at: new Date() })
    .where(eq(jobs.id, jobId));
}

/** Records the failure on the job row, then ends the instance without retries. */
const notImplemented: JobHandler = async ({ params, step, db }) => {
  await step.do("mark job failed", async () => {
    await markJobFailed(db, params.jobId, NOT_IMPLEMENTED);
    return null;
  });
  throw new NonRetryableError(`job kind "${params.kind}" is ${NOT_IMPLEMENTED}`);
};

export const JOB_HANDLERS: Record<JobKind, JobHandler> = {
  install: notImplemented, // TODO: the install job.
  update: notImplemented, // TODO: the update job.
  rollback: notImplemented, // TODO: the rollback job.
  self_update: notImplemented, // TODO: the self-update job.
  uninstall: notImplemented, // TODO: the uninstall job.
};

export async function runJob(
  payload: unknown,
  step: StepRunner,
  db: D1Database,
  handlers: Record<JobKind, JobHandler> = JOB_HANDLERS,
): Promise<void> {
  const parsed = jobParams.safeParse(payload);
  if (!parsed.success) throw new NonRetryableError("invalid job payload");
  await handlers[parsed.data.kind]({ params: parsed.data, step, db });
}
