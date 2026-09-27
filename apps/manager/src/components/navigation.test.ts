import { describe, expect, it } from "vitest";
import {
  currentSettingsPage,
  isCurrentPage,
  isSettingsPath,
  SETTINGS_PAGE_LIST,
  settingsRedirect,
  visibleSettingsPages,
} from "./navigation";

describe("isCurrentPage", () => {
  it("matches a section and the pages below it", () => {
    expect(isCurrentPage("/catalog", "/catalog", false)).toBe(true);
    expect(isCurrentPage("/catalog/cut", "/catalog", false)).toBe(true);
    expect(isCurrentPage("/catalogue", "/catalog", false)).toBe(false);
  });

  it("matches exact pages only exactly, ignoring a trailing slash", () => {
    expect(isCurrentPage("/", "/", true)).toBe(true);
    expect(isCurrentPage("/apps/1", "/", true)).toBe(false);
    expect(isCurrentPage("/settings/users/", "/settings/users", true)).toBe(true);
    expect(isCurrentPage("/settings/users", "/settings", true)).toBe(false);
  });

  it("tells the settings pages apart from the rest", () => {
    expect(isSettingsPath("/settings")).toBe(true);
    expect(isSettingsPath("/settings/")).toBe(true);
    expect(isSettingsPath("/settings/building")).toBe(true);
    expect(isSettingsPath("/settingsx")).toBe(false);
    expect(isSettingsPath("/catalog")).toBe(false);
  });
});

describe("SETTINGS_PAGE_LIST", () => {
  it("lists the settings pages in order, each once, with no General page", () => {
    expect(SETTINGS_PAGE_LIST.map((p) => [p.label, p.href])).toEqual([
      ["Your account", "/settings/account"],
      ["Building apps", "/settings/building"],
      ["Updates", "/settings/updates"],
      ["Users and sign-in", "/settings/users"],
      ["Domains", "/settings/domains"],
      ["Notifications", "/settings/notifications"],
      ["Catalogs", "/settings/catalogs"],
      ["Removed apps", "/settings/removed-apps"],
      ["Usage data", "/settings/usage-data"],
    ]);
  });
});

describe("visibleSettingsPages", () => {
  const labels = (removed: number, pathname: string) =>
    visibleSettingsPages(removed, pathname).map((p) => p.label);

  it("lists Removed apps only while an uninstalled app keeps something", () => {
    expect(labels(0, "/")).not.toContain("Removed apps");
    expect(labels(0, "/settings/account")).not.toContain("Removed apps");
    expect(labels(2, "/")).toContain("Removed apps");
    expect(labels(2, "/")).toEqual(SETTINGS_PAGE_LIST.map((p) => p.label));
  });

  it("keeps Removed apps listed while it is the page open, so the menus show where you are", () => {
    expect(labels(0, "/settings/removed-apps")).toContain("Removed apps");
    expect(labels(0, "/settings/removed-apps/")).toContain("Removed apps");
  });

  it("finds the page open among those listed", () => {
    const pages = visibleSettingsPages(0, "/settings/updates");
    expect(currentSettingsPage(pages, "/settings/updates")?.label).toBe("Updates");
    expect(currentSettingsPage(pages, "/settings/removed-apps")).toBeNull();
    expect(currentSettingsPage(pages, "/jobs")).toBeNull();
  });
});

describe("settingsRedirect", () => {
  it("opens Your account for /settings, and the section an old anchor named", () => {
    expect(settingsRedirect("/settings", "")).toBe("/settings/account");
    expect(settingsRedirect("/settings/", "")).toBe("/settings/account");
    expect(settingsRedirect("/settings", "automatic-updates")).toBe("/settings/updates#apps");
    expect(settingsRedirect("/settings", "#automatic-updates")).toBe("/settings/updates#apps");
    expect(settingsRedirect("/settings", "danger-zone")).toBe("/settings/account#danger-zone");
    expect(settingsRedirect("/settings", "appflare-updates")).toBe("/settings/updates#appflare");
    expect(settingsRedirect("/settings", "notifications")).toBe("/settings/notifications");
    expect(settingsRedirect("/settings", "usage-data")).toBe("/settings/usage-data");
    expect(settingsRedirect("/settings", "unknown")).toBe("/settings/account");
  });

  it("sends the old Appflare updates page to the same section of Updates", () => {
    expect(settingsRedirect("/settings/appflare-updates", "")).toBe("/settings/updates#appflare");
    expect(settingsRedirect("/settings/appflare-updates", "appflare")).toBe(
      "/settings/updates#appflare",
    );
    expect(settingsRedirect("/settings/appflare-updates", "versions")).toBe(
      "/settings/updates#versions",
    );
  });

  it("sends the sections that left the account page to Building apps, and old row anchors on", () => {
    expect(settingsRedirect("/settings/account", "sandbox")).toBe("/settings/building#sandbox");
    expect(settingsRedirect("/settings/account", "github-access")).toBe(
      "/settings/building#github-access",
    );
    expect(settingsRedirect("/settings/account", "checklist-sandbox")).toBe(
      "/settings/account#capability-sandbox",
    );
    expect(settingsRedirect("/settings/account", "checklist-analytics-engine")).toBe(
      "/settings/account#capability-analytics-engine",
    );
  });

  it("sends the account setup list to What this account can run", () => {
    expect(settingsRedirect("/settings/account", "checklist")).toBe(
      "/settings/account#capabilities",
    );
    expect(settingsRedirect("/settings/account", "#checklist")).toBe(
      "/settings/account#capabilities",
    );
  });

  it("leaves current addresses alone", () => {
    expect(settingsRedirect("/settings/account", "")).toBeNull();
    expect(settingsRedirect("/settings/account", "connection")).toBeNull();
    expect(settingsRedirect("/settings/account", "capability-r2")).toBeNull();
    expect(settingsRedirect("/settings/account", "capabilities")).toBeNull();
    expect(settingsRedirect("/settings/building", "sandbox")).toBeNull();
    expect(settingsRedirect("/settings/updates", "versions")).toBeNull();
    expect(settingsRedirect("/catalog", "")).toBeNull();
  });
});
