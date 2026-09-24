import { describe, expect, it } from "vitest";
import type { ManagerStatus } from "../installs/pending-updates";
import { appflareCardState, appflareRailItem, type CardJob } from "./appflare-card-state";

const upToDate: ManagerStatus = {
  current: "0.4.0",
  latest: "0.4.0",
  updateAvailable: false,
  activeJobId: null,
};
const behind: ManagerStatus = { ...upToDate, latest: "0.5.0", updateAvailable: true };

const job = (over: Partial<CardJob> = {}): CardJob => ({
  status: "running",
  targetVersion: "0.5.0",
  error: null,
  lastStep: "Uploaded the new version",
  ...over,
});

function state(
  over: Partial<Parameters<typeof appflareCardState>[0]> = {},
): ReturnType<typeof appflareCardState> {
  return appflareCardState({
    manager: upToDate,
    job: null,
    switching: false,
    updatedTo: null,
    isAdmin: true,
    ...over,
  });
}

describe("appflareCardState", () => {
  it("shows no card while it is up to date or nothing is known", () => {
    expect(state()).toEqual({ kind: "current", version: "0.4.0" });
    expect(state({ manager: { ...upToDate, latest: null } })).toEqual({
      kind: "current",
      version: "0.4.0",
    });
  });

  it("offers a newer release, with the Update button for admins only", () => {
    expect(state({ manager: behind })).toEqual({
      kind: "available",
      current: "0.4.0",
      latest: "0.5.0",
      canUpdate: true,
    });
    expect(state({ manager: behind, isAdmin: false })).toMatchObject({ canUpdate: false });
  });

  it("follows the self-update: its newest log line, then the switch", () => {
    expect(state({ manager: behind, job: undefined })).toEqual({
      kind: "running",
      target: "0.5.0",
      step: null,
    });
    expect(state({ manager: behind, job: job({ status: "queued", lastStep: null }) })).toEqual({
      kind: "running",
      target: "0.5.0",
      step: null,
    });
    expect(state({ manager: behind, job: job() })).toEqual({
      kind: "running",
      target: "0.5.0",
      step: "Uploaded the new version",
    });
    expect(state({ manager: behind, job: job(), switching: true })).toEqual({
      kind: "switching",
      target: "0.5.0",
    });
    // Finished: the page waits for the new version, then reloads onto it.
    expect(state({ manager: behind, job: job({ status: "succeeded" }) })).toEqual({
      kind: "switching",
      target: "0.5.0",
    });
  });

  it("stops promising a reload once the new version has not answered for the whole wait", () => {
    expect(state({ manager: behind, job: job({ status: "succeeded" }), stalled: true })).toEqual({
      kind: "stalled",
      target: "0.5.0",
    });
    // Only a finished job can stall; a running one is still running.
    expect(state({ manager: behind, job: job(), stalled: true })).toMatchObject({
      kind: "running",
    });
  });

  it("says it updated once the page runs the new version", () => {
    const now: ManagerStatus = { ...upToDate, current: "0.5.0", latest: "0.5.0" };
    expect(state({ manager: now, updatedTo: "0.5.0" })).toEqual({
      kind: "updated",
      version: "0.5.0",
    });
    // A marker from an older switch is not news.
    expect(state({ manager: now, updatedTo: "0.4.0" })).toEqual({
      kind: "current",
      version: "0.5.0",
    });
  });

  it("drops the updated card once it was dismissed or has been shown long enough", () => {
    const now: ManagerStatus = { ...upToDate, current: "0.5.0", latest: "0.5.0" };
    expect(state({ manager: now, updatedTo: "0.5.0", updatedDone: true })).toEqual({
      kind: "current",
      version: "0.5.0",
    });
    // The same after a job this page followed to the end.
    expect(state({ manager: now, job: job({ status: "succeeded" }), updatedDone: true })).toEqual({
      kind: "current",
      version: "0.5.0",
    });
    // Only the updated card goes; a failure stays.
    expect(
      state({ manager: behind, job: job({ status: "failed" }), updatedDone: true }),
    ).toMatchObject({ kind: "failed" });
  });

  it("shows a failure in place and offers the newest release again to admins", () => {
    const failed = job({ status: "failed", error: "The new version failed its check." });
    expect(state({ manager: behind, job: failed })).toEqual({
      kind: "failed",
      target: "0.5.0",
      error: "The new version failed its check.",
      retry: "0.5.0",
    });
    expect(state({ manager: behind, job: failed, isAdmin: false })).toMatchObject({ retry: null });
    // A newer release came out meanwhile: the retry offers that one.
    expect(state({ manager: { ...behind, latest: "0.5.1" }, job: failed })).toMatchObject({
      kind: "failed",
      target: "0.5.0",
      retry: "0.5.1",
    });
  });
});

describe("appflareRailItem", () => {
  const updates = "/settings/appflare-updates";

  it("shows nothing while Appflare is up to date", () => {
    expect(appflareRailItem({ kind: "current", version: "0.4.0" }, null, updates)).toBeNull();
  });

  it("links an available release to Appflare updates", () => {
    expect(
      appflareRailItem(
        { kind: "available", current: "0.4.0", latest: "0.5.0", canUpdate: true },
        null,
        updates,
      ),
    ).toEqual({ tone: "update", label: "Appflare 0.5.0 is available", href: updates });
  });

  it("links a followed self-update to its log", () => {
    expect(
      appflareRailItem({ kind: "running", target: "0.5.0", step: "Uploading" }, "job-1", updates),
    ).toEqual({ tone: "progress", label: "Updating to 0.5.0", href: "/jobs/job-1" });
    expect(
      appflareRailItem(
        { kind: "failed", target: "0.5.0", error: "boom", retry: "0.5.0" },
        "job-1",
        updates,
      ),
    ).toEqual({ tone: "danger", label: "Update to 0.5.0 failed", href: "/jobs/job-1" });
    expect(appflareRailItem({ kind: "stalled", target: "0.5.0" }, null, updates)?.href).toBe(
      updates,
    );
  });
});
