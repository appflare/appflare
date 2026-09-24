import { describe, expect, it } from "vitest";
import { compareVersions } from "../catalog/versions";
import type { JobView } from "./jobs.functions";
import {
  acceptPoll,
  clientReplaced,
  followJob,
  type LiveJobState,
  switchAnswer,
  switchTargetOf,
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
