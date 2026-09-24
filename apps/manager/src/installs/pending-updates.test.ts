import { describe, expect, it } from "vitest";
import { type PendingInstallRow, pendingUpdates, pendingUpdatesTitle } from "./pending-updates";

const row = (over: Partial<PendingInstallRow> & { id: string }): PendingInstallRow => ({
  status: "installed",
  appSlug: "cut",
  instanceName: null,
  workerName: over.id,
  catalogVersion: "1.0.0",
  ...over,
});

const noManager = { current: "0.4.0", latest: null, updateAvailable: false };

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
      noManager,
    );
    expect(pending.apps).toEqual([
      { installId: "a", instanceName: "Links", version: "1.0.0", latestVersion: "1.1.0" },
      { installId: "b", instanceName: "b", version: "1.0.0", latestVersion: "1.1.0" },
    ]);
    expect(pending.manager).toBeNull();
    expect(pending.total).toBe(2);
  });

  it("adds one for a newer Appflare release", () => {
    const pending = pendingUpdates([], new Map(), {
      current: "0.4.0",
      latest: "0.5.0",
      updateAvailable: true,
    });
    expect(pending).toEqual({ apps: [], manager: { current: "0.4.0", latest: "0.5.0" }, total: 1 });
    expect(
      pendingUpdates([], new Map(), { current: "0.5.0", latest: "0.5.0", updateAvailable: false })
        .total,
    ).toBe(0);
  });

  it("titles the count", () => {
    expect(pendingUpdatesTitle(1)).toBe("1 update available");
    expect(pendingUpdatesTitle(3)).toBe("3 updates available");
  });
});
