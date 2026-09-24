import { describe, expect, it } from "vitest";
import {
  parseSidebarRail,
  readSidebarRail,
  SIDEBAR_RAIL_KEY,
  writeSidebarRail,
} from "./sidebar-rail";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("the sidebar rail state", () => {
  it("is expanded unless collapsed was stored", () => {
    expect(parseSidebarRail("collapsed")).toBe("collapsed");
    expect(parseSidebarRail("expanded")).toBe("expanded");
    expect(parseSidebarRail("true")).toBe("expanded");
    expect(parseSidebarRail(null)).toBe("expanded");
    expect(parseSidebarRail(undefined)).toBe("expanded");
  });

  it("is remembered in storage under its key", () => {
    const storage = memoryStorage();
    expect(readSidebarRail(storage)).toBe("expanded");
    writeSidebarRail(storage, "collapsed");
    expect(storage.map.get(SIDEBAR_RAIL_KEY)).toBe("collapsed");
    expect(readSidebarRail(storage)).toBe("collapsed");
    writeSidebarRail(storage, "expanded");
    expect(readSidebarRail(storage)).toBe("expanded");
  });

  it("falls back to expanded when storage is missing or blocked", () => {
    expect(readSidebarRail(undefined)).toBe("expanded");
    expect(readSidebarRail(blocked)).toBe("expanded");
    expect(() => writeSidebarRail(blocked, "collapsed")).not.toThrow();
    expect(() => writeSidebarRail(undefined, "collapsed")).not.toThrow();
  });
});
