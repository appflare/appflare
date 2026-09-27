import { describe, expect, it } from "vitest";
import { type ManagerStatus, type PendingInstallRow, pendingUpdates } from "./pending-updates";

const row = (over: Partial<PendingInstallRow> & { id: string }): PendingInstallRow => ({
  status: "installed",
  appSlug: "cut",
  displayName: null,
  workerName: over.id,
  catalogVersion: "1.0.0",
  ...over,
});

const upToDate: ManagerStatus = {
  current: "0.4.0",
  latest: "0.4.0",
  updateAvailable: false,
  activeJobId: null,
};

describe("pendingUpdates", () => {
  it("counts every installed app behind the catalog, each install on its own", () => {
    const pending = pendingUpdates(
      [
        row({ id: "a", displayName: "Links" }),
        row({ id: "b" }),
        row({ id: "c", appSlug: "brain", catalogVersion: "2.0.0" }),
        // Not installed right now: an update is not offered.
        row({ id: "d", status: "updating" }),
        row({ id: "e", status: "failed" }),
        row({ id: "f", status: "uninstalled" }),
        // No longer in the catalog.
        row({ id: "g", appSlug: "gone" }),
      ],
      new Map([
        ["cut", "1.1.0"],
        ["brain", "2.0.0"],
      ]),
      upToDate,
    );
    expect(pending.apps).toEqual([
      { installId: "a", label: "Links", version: "1.0.0", latestVersion: "1.1.0" },
      { installId: "b", label: "b", version: "1.0.0", latestVersion: "1.1.0" },
    ]);
  });

  it("passes Appflare's own version along without counting its update with the apps", () => {
    const manager: ManagerStatus = {
      current: "0.4.0",
      latest: "0.5.0",
      updateAvailable: true,
      activeJobId: null,
    };
    const pending = pendingUpdates([], new Map(), manager);
    expect(pending).toEqual({ apps: [], manager });
    // Only apps are ever counted.
    expect(pending.apps).toHaveLength(0);
  });
});
