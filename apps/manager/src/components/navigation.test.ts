import { describe, expect, it } from "vitest";
import { isCurrentPage, SETTINGS_PAGE_LIST, settingsPageForAnchor } from "./navigation";

describe("isCurrentPage", () => {
  it("matches a section and the pages below it", () => {
    expect(isCurrentPage("/catalog", "/catalog", false)).toBe(true);
    expect(isCurrentPage("/catalog/cut", "/catalog", false)).toBe(true);
    expect(isCurrentPage("/catalogue", "/catalog", false)).toBe(false);
  });

  it("matches exact pages only exactly, ignoring a trailing slash", () => {
    expect(isCurrentPage("/", "/", true)).toBe(true);
    expect(isCurrentPage("/apps/1", "/", true)).toBe(false);
    expect(isCurrentPage("/settings/", "/settings", true)).toBe(true);
    expect(isCurrentPage("/settings/users", "/settings", true)).toBe(false);
  });
});

describe("SETTINGS_PAGE_LIST", () => {
  it("lists General first and every page under /settings once", () => {
    const hrefs = SETTINGS_PAGE_LIST.map((p) => p.href);
    expect(hrefs[0]).toBe("/settings");
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.every((h) => h === "/settings" || h.startsWith("/settings/"))).toBe(true);
  });
});

describe("settingsPageForAnchor", () => {
  it("sends the old Settings anchors to the pages they became", () => {
    expect(settingsPageForAnchor("#appflare-updates")).toBe("/settings/appflare-updates");
    expect(settingsPageForAnchor("#notifications")).toBe("/settings/notifications");
    expect(settingsPageForAnchor("#usage-data")).toBe("/settings/usage-data");
    expect(settingsPageForAnchor("#automatic-updates")).toBe("/settings");
    expect(settingsPageForAnchor("")).toBeNull();
    expect(settingsPageForAnchor("#other")).toBeNull();
  });
});
