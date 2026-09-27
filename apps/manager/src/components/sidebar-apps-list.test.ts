import { describe, expect, it } from "vitest";
import { currentAppId, filterApps, sidebarApps } from "./sidebar-apps-list";

const install = (id: string, name: string, displayName: string | null = null) => ({
  id,
  name,
  displayName,
  label: displayName ?? id,
  icon: null,
});

describe("sidebarApps", () => {
  it("lists every install by the name Home uses, sorted, with its dot", () => {
    const apps = sidebarApps(
      [
        install("cut", "Cut"),
        install("stats", "Counterscale"),
        install("feed", "Microfeed", "blog"),
      ],
      new Map([["stats", "update" as const]]),
    );
    expect(apps.map((a) => [a.label, a.signal])).toEqual([
      ["blog", null],
      ["Counterscale", "update"],
      ["Cut", null],
    ]);
  });

  it("tells two installs of one app apart by their labels", () => {
    const apps = sidebarApps([install("cut-a", "Cut"), install("cut-b", "Cut")], new Map());
    expect(apps.map((a) => a.label)).toEqual(["cut-a", "cut-b"]);
  });
});

describe("filterApps", () => {
  const apps = sidebarApps(
    [
      install("cut", "Cut", "Short links"),
      install("stats", "Counterscale"),
      install("feed", "Microfeed"),
    ],
    new Map(),
  );

  it("matches the row's name or the app's name, ignoring case and spaces around", () => {
    expect(filterApps(apps, "  SHORT ").map((a) => a.id)).toEqual(["cut"]);
    expect(filterApps(apps, "cut").map((a) => a.id)).toEqual(["cut"]);
    expect(filterApps(apps, "c").map((a) => a.id)).toEqual(["stats", "feed", "cut"]);
    expect(filterApps(apps, "zzz")).toEqual([]);
  });

  it("keeps every app for an empty query", () => {
    expect(filterApps(apps, "  ")).toHaveLength(3);
  });
});

describe("currentAppId", () => {
  it("reads the install from its page and the pages under it", () => {
    expect(currentAppId("/apps/01J8")).toBe("01J8");
    expect(currentAppId("/apps/01J8/anything")).toBe("01J8");
    expect(currentAppId("/catalog")).toBeNull();
    expect(currentAppId("/apps")).toBeNull();
  });
});
