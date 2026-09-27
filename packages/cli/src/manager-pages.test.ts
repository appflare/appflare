import { describe, expect, it } from "vitest";
import { USAGE } from "./main.ts";
import {
  MANAGER_PAGES,
  managerPageLines,
  managerPageRef,
  managerPageUrl,
} from "./manager-pages.ts";

describe("manager pages", () => {
  it("points at the settings sections the manager has", () => {
    // The manager's own map (apps/manager settings-links.ts) builds these paths.
    expect(Object.values(MANAGER_PAGES).map((p) => p.path)).toEqual([
      "/settings/updates#appflare",
      "/settings/updates#versions",
      "/settings/building#sandbox",
      "/settings/account#danger-zone",
    ]);
  });

  it("builds the full URL from the manager's address, or a placeholder without one", () => {
    expect(managerPageUrl("https://appflare.acme.workers.dev/", "dangerZone")).toBe(
      "https://appflare.acme.workers.dev/settings/account#danger-zone",
    );
    expect(managerPageUrl(null, "updates")).toBe(
      "https://<your manager>/settings/updates#appflare",
    );
    expect(managerPageRef(null, "building")).toBe(
      "Settings > Building apps (https://<your manager>/settings/building#sandbox)",
    );
  });

  it("lists where to update, build apps and remove the manager after an install", () => {
    const lines = managerPageLines("https://appflare.acme.workers.dev/").join("\n");
    expect(lines).toContain("https://appflare.acme.workers.dev/settings/updates#appflare");
    expect(lines).toContain("https://appflare.acme.workers.dev/settings/building#sandbox");
    expect(lines).toContain("https://appflare.acme.workers.dev/settings/account#danger-zone");
  });

  it("names each page with its path in the help text", () => {
    for (const page of [MANAGER_PAGES.updates, MANAGER_PAGES.building, MANAGER_PAGES.dangerZone]) {
      expect(USAGE).toContain(page.name);
      expect(USAGE).toContain(`https://<your manager>${page.path}`);
    }
  });
});
