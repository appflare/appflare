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

/** The parts of a job that following its version switch reads. */
export interface SwitchJob {
  kind: string;
  status: "queued" | "running" | "succeeded" | "failed";
  /** The Appflare version the job moves to. */
  targetVersion: string | null;
  /** ISO 8601 */
  finishedAt: string | null;
}

/** The Appflare version a self-update or a rollback of Appflare switches to; null for other jobs. */
export function switchTargetOf(job: SwitchJob | null | undefined): string | null {
  if (job == null) return null;
  return job.kind === "self_update" || job.kind === "self_rollback" ? job.targetVersion : null;
}

type Compare = (a: string, b: string) => number | null;

/**
 * How the version `/api/health` reports relates to the job's target. A
 * self-update moves forward: the target or anything newer has arrived, and
 * an older version is the one being replaced. A rollback moves back to
 * exactly its target: any other version is the one being replaced.
 */
export function switchAnswer(
  kind: string,
  target: string,
  seen: string,
  compare: Compare,
): { arrived: boolean; replaced: boolean } {
  if (kind === "self_rollback") return { arrived: seen === target, replaced: seen !== target };
  const order = compare(seen, target) ?? 0;
  return { arrived: order >= 0, replaced: order < 0 };
}

/** This page's own client is not the target's, so it must reload once the target answers. */
export function clientReplaced(
  kind: string,
  clientVersion: string | undefined,
  target: string | null,
  compare: Compare,
): boolean {
  if (clientVersion === undefined || target === null) return false;
  if (kind === "self_rollback") return clientVersion !== target;
  return (compare(clientVersion, target) ?? 0) < 0;
}
