import { describe, expect, it } from "vitest";
import { compareVersions } from "../catalog/versions";
import type { JobView } from "./jobs.functions";
import {
  acceptPoll,
  clientReplaced,
  followJob,
  type LiveJobState,
  lastLogIdOf,
  switchAnswer,
  switchTargetOf,
  withEarlierLogs,
} from "./live-job-state";

const view = (id: string, status: JobView["status"]): JobView =>
  ({ id, status }) as unknown as JobView; // Only the fields these helpers pass through.

describe("following a job", () => {
  it("starts over when the job changes, such as trying a failed self-update again", () => {
    const failed: LiveJobState = { jobId: "job1", job: view("job1", "failed") };
    // Same job: kept.
    expect(followJob(failed, "job1", undefined)).toBe(failed);
    // A new job: the failed one is dropped and the new one is read from scratch.
    expect(followJob(failed, "job2", undefined)).toEqual({ jobId: "job2", job: undefined });
    expect(followJob(failed, null, null)).toEqual({ jobId: null, job: null });
  });

  it("drops a poll answer for a job it no longer follows", () => {
    const now: LiveJobState = { jobId: "job2", job: undefined };
    expect(acceptPoll(now, "job1", view("job1", "failed"))).toBe(now);
    expect(acceptPoll(now, "job2", view("job2", "running"))).toEqual({
      jobId: "job2",
      job: view("job2", "running"),
    });
  });

  it("keeps the job shown when a poll answers without it, unless nothing was read yet", () => {
    const shown: LiveJobState = { jobId: "job1", job: view("job1", "running") };
    expect(acceptPoll(shown, "job1", null)).toBe(shown);
    expect(acceptPoll({ jobId: "job1", job: undefined }, "job1", null)).toEqual({
      jobId: "job1",
      job: null,
    });
  });
});

describe("following a job's log", () => {
  const line = (id: number) => ({
    id,
    ts: "2026-09-28T00:00:00.000Z",
    level: "info",
    message: `line ${id}`,
    requests: [],
    detail: null,
  });
  const withLogs = (ids: number[], logsAfter: number | null = null): JobView =>
    ({ id: "job1", status: "running", logs: ids.map(line), logsAfter }) as unknown as JobView;

  it("asks for the whole log first, then only for lines after the last one shown", () => {
    expect(lastLogIdOf(undefined)).toBeUndefined();
    expect(lastLogIdOf(null)).toBeUndefined();
    expect(lastLogIdOf(withLogs([]))).toBe(0);
    expect(lastLogIdOf(withLogs([3, 4, 9]))).toBe(9);
  });

  it("adds the newer lines of a poll to the lines already shown", () => {
    const shown: LiveJobState = { jobId: "job1", job: withLogs([1, 2, 3]) };
    const next = acceptPoll(shown, "job1", withLogs([4, 5], 3));
    expect(next.job?.logs.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
    expect(next.job?.logsAfter).toBeNull();
    // Nothing new: the lines shown stay.
    expect(acceptPoll(shown, "job1", withLogs([], 3)).job?.logs.map((l) => l.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("never repeats a line when two polls asked from the same point", () => {
    const shown: LiveJobState = { jobId: "job1", job: withLogs([1, 2, 3, 4]) };
    // An earlier poll asked for lines after 2 and answers late with 3 and 4 again.
    const next = acceptPoll(shown, "job1", withLogs([3, 4, 5], 2));
    expect(next.job?.logs.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("takes a whole log as it is (the first read, or an older version's answer)", () => {
    const shown: LiveJobState = { jobId: "job1", job: withLogs([1, 2, 3]) };
    const whole = withLogs([1, 2, 3, 4]);
    expect(acceptPoll(shown, "job1", whole).job).toBe(whole);
    const older = { id: "job1", status: "running", logs: [line(1)] } as unknown as JobView;
    expect(withEarlierLogs(withLogs([1, 2]), older)).toBe(older);
  });
});

describe("following a version switch", () => {
  const job = (kind: string) =>
    ({ kind, status: "succeeded", targetVersion: "0.4.0", finishedAt: null }) as const;

  it("follows self-updates and rollbacks of Appflare only", () => {
    expect(switchTargetOf(job("self_update"))).toBe("0.4.0");
    expect(switchTargetOf(job("self_rollback"))).toBe("0.4.0");
    expect(switchTargetOf(job("rollback"))).toBeNull();
  });

  it("waits for a self-update's target or newer", () => {
    expect(switchAnswer("self_update", "0.4.0", "0.3.0", compareVersions)).toEqual({
      arrived: false,
      replaced: true,
    });
    expect(switchAnswer("self_update", "0.4.0", "0.5.0", compareVersions).arrived).toBe(true);
  });

  it("waits for a rollback's exact target, older than what served", () => {
    expect(switchAnswer("self_rollback", "0.4.0", "0.5.0", compareVersions)).toEqual({
      arrived: false,
      replaced: true,
    });
    expect(switchAnswer("self_rollback", "0.4.0", "0.4.0", compareVersions)).toEqual({
      arrived: true,
      replaced: false,
    });
  });

  it("reloads a page whose client is not the target's", () => {
    expect(clientReplaced("self_rollback", "0.5.0", "0.4.0", compareVersions)).toBe(true);
    expect(clientReplaced("self_rollback", "0.4.0", "0.4.0", compareVersions)).toBe(false);
    expect(clientReplaced("self_update", "0.5.0", "0.4.0", compareVersions)).toBe(false);
    expect(clientReplaced("self_update", "0.3.0", "0.4.0", compareVersions)).toBe(true);
  });
});
