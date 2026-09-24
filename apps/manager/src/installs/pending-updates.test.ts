import { describe, expect, it } from "vitest";
import {
  MANAGER_UPDATES_HREF,
  type ManagerStatus,
  type PendingInstallRow,
  pendingUpdates,
  pendingUpdatesTitle,
  sidebarUpdateBadge,
} from "./pending-updates";

const row = (over: Partial<PendingInstallRow> & { id: string }): PendingInstallRow => ({
  status: "installed",
  appSlug: "cut",
  instanceName: null,
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
        row({ id: "a", instanceName: "Links" }),
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
      { installId: "a", instanceName: "Links", version: "1.0.0", latestVersion: "1.1.0" },
      { installId: "b", instanceName: "b", version: "1.0.0", latestVersion: "1.1.0" },
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
    // The sidebar's Home count and the home page's title only ever count apps.
    expect(pending.apps).toHaveLength(0);
  });

  it("puts the app count on Home only, never a count for Appflare's own update", () => {
    const pending = pendingUpdates([row({ id: "a" })], new Map([["cut", "1.1.0"]]), {
      current: "0.4.0",
      latest: "0.5.0",
      updateAvailable: true,
      activeJobId: null,
    });
    expect(sidebarUpdateBadge("/", pending)).toEqual({ count: 1, label: "1 update available" });
    for (const href of ["/settings", MANAGER_UPDATES_HREF, "/catalog", "/jobs"]) {
      expect(sidebarUpdateBadge(href, pending).count).toBe(0);
    }
    expect(sidebarUpdateBadge("/", pendingUpdates([], new Map(), upToDate)).count).toBe(0);
  });

  it("titles the count", () => {
    expect(pendingUpdatesTitle(1)).toBe("1 update available");
    expect(pendingUpdatesTitle(3)).toBe("3 updates available");
  });
});
