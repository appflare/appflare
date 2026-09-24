import type { JobView } from "./jobs.functions";

/**
 * The job a page follows, tied to the job id it belongs to, so that
 * following another job (such as a second self-update after a failed one)
 * never shows or keeps polling the first. Pure; ./live-job.ts holds it in
 * React state.
 */
export interface LiveJobState {
  jobId: string | null;
  /** Undefined until the first read; null when there is no such job. */
  job: JobView | null | undefined;
}

/** The state for `jobId`: kept while it still follows that job, else started over from `initial`. */
export function followJob(
  state: LiveJobState,
  jobId: string | null,
  initial: JobView | null | undefined,
): LiveJobState {
  return state.jobId === jobId ? state : { jobId, job: initial };
}

/**
 * A poll's answer for `jobId`. Dropped when the state follows another job by
 * now; an answer without the job replaces only a job not read yet.
 */
export function acceptPoll(state: LiveJobState, jobId: string, next: JobView | null): LiveJobState {
  if (state.jobId !== jobId) return state;
  if (next === null && state.job !== undefined) return state;
  return { jobId, job: next };
}
