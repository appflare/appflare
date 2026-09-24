import { useEffect, useState } from "react";
import { compareVersions } from "../catalog/versions";
import { getJob, type JobView } from "./jobs.functions";
import {
  acceptPoll,
  clientReplaced,
  followJob,
  type LiveJobState,
  type SwitchJob,
  switchAnswer,
  switchTargetOf,
} from "./live-job-state";

/**
 * Following a job from the browser: its row and log while it runs, and for
 * a self-update or a rollback of Appflare, the switch to the other version. Used by the job's page and by
 * the sidebar's Appflare card.
 */

/** How often a queued or running job is re-read. */
export const POLL_MS = 2000;

export function isActive(job: Pick<JobView, "status"> | null | undefined): boolean {
  return job != null && (job.status === "queued" || job.status === "running");
}

/**
 * Polls `getJob` every 2 s while the job is queued or running and stops once
 * it has finished (the free plan allows 100k requests a day). `initial` is
 * the job as already read; when it is `undefined` (not read yet) the job is
 * read at once. A failed poll (for example a 5xx or 404 while Appflare
 * switches versions) is retried on the next tick; an answer without the job
 * never replaces the job already shown. Returns `undefined` until the first
 * read, and null when there is no such job.
 */
export function useLiveJob(
  jobId: string | null,
  initial?: JobView | null,
): JobView | null | undefined {
  const [stored, setStored] = useState<LiveJobState>({ jobId, job: initial });
  // A new read handed in (the job page's loader) replaces what is shown.
  useEffect(() => setStored({ jobId, job: initial }), [jobId, initial]);
  // Another job: start over from `initial` at once, never showing the previous one.
  const state = followJob(stored, jobId, initial);
  if (state !== stored) setStored(state);
  const { job } = state;
  const unread = job === undefined;
  const active = jobId !== null && (unread || isActive(job));
  useEffect(() => {
    if (!active || jobId === null) return;
    const id = jobId;
    let cancelled = false;
    async function poll() {
      try {
        const next = await getJob({ data: { jobId: id } });
        if (!cancelled) setStored((s) => acceptPoll(s, id, next));
      } catch {
        // A missed poll is retried on the next tick.
      }
    }
    if (unread) void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, active, unread]);
  return job;
}

/** A finished self-update or rollback stops being watched for the switch after this long. */
const SWITCH_WATCH_MS = 5 * 60 * 1000;

/**
 * A self-update, or a rollback of Appflare, replaces the code serving this
 * page. Polls `/api/health` (a plain URL every version serves, unlike server
 * functions, whose ids change between builds) while the job runs, and after
 * it succeeded until the target answers (at most a few minutes): for a
 * self-update a version at least as new as the target, for a rollback
 * exactly the target. Reports whether the replaced version still answers.
 * When the target starts answering after the replaced one did, or while this
 * page runs another version's client (`clientVersion`, when known),
 * `onArrived` runs (when given) and the page reloads once to load the
 * target's client. `stalled`: the job succeeded, the watch ended, and the
 * target never answered here.
 */
export function useVersionSwitch(
  job: SwitchJob | null | undefined,
  options: { clientVersion?: string; onArrived?: (version: string) => void } = {},
): { switching: boolean; stalled: boolean } {
  const { clientVersion, onArrived } = options;
  const target = switchTargetOf(job);
  const kind = job?.kind ?? "";
  const [seen, setSeen] = useState<string | null>(null);
  const [sawReplaced, setSawReplaced] = useState(false);
  const arrived =
    seen !== null && target !== null && switchAnswer(kind, target, seen, compareVersions).arrived;
  const otherClient = clientReplaced(kind, clientVersion, target, compareVersions);
  const finishedAt = job?.finishedAt ?? null;
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (finishedAt === null) return;
    const left = new Date(finishedAt).getTime() + SWITCH_WATCH_MS - Date.now();
    if (left <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [finishedAt]);
  const recentlyFinished = finishedAt === null || !expired;
  const watching =
    target !== null &&
    job != null &&
    (isActive(job) || (job.status === "succeeded" && recentlyFinished && !arrived));
  useEffect(() => {
    if (!watching || target === null) return;
    const to = target;
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const body = (await res.json()) as { version?: unknown };
        if (cancelled || typeof body.version !== "string") return;
        const version = body.version;
        setSeen(version);
        if (switchAnswer(kind, to, version, compareVersions).replaced) setSawReplaced(true);
      } catch {
        // Unreachable during the switch; the next tick retries.
      }
    }
    void check();
    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [watching, target, kind]);
  const status = job?.status;
  useEffect(() => {
    if (arrived && (sawReplaced || otherClient) && status !== "failed" && seen !== null) {
      onArrived?.(seen);
      window.location.reload();
    }
  }, [arrived, sawReplaced, otherClient, status, seen, onArrived]);
  return {
    switching: watching && seen !== null && !arrived,
    stalled: target !== null && status === "succeeded" && expired && !arrived,
  };
}
