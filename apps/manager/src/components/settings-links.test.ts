import { describe, expect, it } from "vitest";
import { ANALYTICS_ENGINE_CAPABILITY_LINK } from "../capabilities/capability-rows";
import { GITHUB_ACCESS_PLACE } from "../github/tokens";
import { MANAGER_UPDATES_HREF } from "../installs/pending-updates";
import { ENABLE_SANDBOX_PLACE } from "../sandbox/connect-copy";
import { SANDBOX_CAPABILITY_HREF } from "../sandbox/readiness";
import { ACCOUNT_LINKS } from "./account";
import { plainMessage } from "./message-links";
import { SETTINGS_PAGES } from "./navigation";
import {
  SETTINGS_SECTIONS,
  settingsLink,
  settingsPlace,
  settingsSection,
  settingsSectionTitle,
} from "./settings-links";

describe("settingsLink", () => {
  it("builds the path of a page, and of a section or a capability row on it", () => {
    expect(settingsLink("account")).toBe("/settings/account");
    expect(settingsLink("account", "connection")).toBe("/settings/account#connection");
    expect(settingsLink("account", "capabilities")).toBe("/settings/account#capabilities");
    expect(settingsLink("account", "capability-r2")).toBe("/settings/account#capability-r2");
    expect(settingsLink("account", "capability-token-permissions")).toBe(
      "/settings/account#capability-token-permissions",
    );
    expect(settingsLink("account", "danger-zone")).toBe("/settings/account#danger-zone");
    expect(settingsLink("building", "sandbox")).toBe("/settings/building#sandbox");
    expect(settingsLink("building", "github-access")).toBe("/settings/building#github-access");
    expect(settingsLink("updates", "apps")).toBe("/settings/updates#apps");
    expect(settingsLink("updates", "appflare")).toBe("/settings/updates#appflare");
    expect(settingsLink("updates", "versions")).toBe("/settings/updates#versions");
    expect(settingsLink("users", "users")).toBe("/settings/users#users");
    expect(settingsLink("users", "passkeys")).toBe("/settings/users#passkeys");
    expect(settingsLink("users", "access")).toBe("/settings/users#access");
    expect(settingsLink("domains", "external-domains")).toBe("/settings/domains#external-domains");
    expect(settingsLink("notifications", "channels")).toBe("/settings/notifications#channels");
    expect(settingsLink("removedApps")).toBe("/settings/removed-apps");
    expect(settingsLink("usageData")).toBe("/settings/usage-data");
  });

  it("lists the pages in the order the settings menu shows them", () => {
    expect(Object.values(SETTINGS_SECTIONS).map((page) => page.path)).toEqual([
      "/settings/account",
      "/settings/building",
      "/settings/updates",
      "/settings/users",
      "/settings/domains",
      "/settings/notifications",
      "/settings/catalogs",
      "/settings/removed-apps",
      "/settings/usage-data",
    ]);
    expect(Object.keys(SETTINGS_SECTIONS.account.sections)).toEqual([
      "connection",
      "capabilities",
      "danger-zone",
    ]);
    expect(Object.keys(SETTINGS_SECTIONS.updates.sections)).toEqual([
      "apps",
      "appflare",
      "versions",
    ]);
  });

  it("only takes the sections of the page it is given", () => {
    // @ts-expect-error: the passkeys section is on the users page.
    settingsLink("account", "passkeys");
    // @ts-expect-error: sandbox builds moved to Building apps.
    settingsLink("account", "sandbox");
    // @ts-expect-error: capability rows are on the account page only.
    settingsLink("users", "capability-r2");
    // @ts-expect-error: the account setup list is part of What this account can run.
    settingsLink("account", "checklist");
    // @ts-expect-error: its rows are capability rows.
    settingsLink("account", "checklist-r2");
  });

  it("is where every settings page and the links into them take their paths from", () => {
    for (const [key, page] of Object.entries(SETTINGS_PAGES)) {
      expect(page.href).toBe(SETTINGS_SECTIONS[key as keyof typeof SETTINGS_SECTIONS].path);
    }
    expect(ACCOUNT_LINKS.passkeys).toBe("/settings/users#passkeys");
    expect(MANAGER_UPDATES_HREF).toBe("/settings/updates#appflare");
    expect(SANDBOX_CAPABILITY_HREF).toBe("/settings/account#capability-sandbox");
    expect(ANALYTICS_ENGINE_CAPABILITY_LINK.href).toBe(
      "/settings/account#capability-analytics-engine",
    );
    expect(GITHUB_ACCESS_PLACE).toBe("[GitHub access settings](/settings/building#github-access)");
  });

  it("gives every section a unique id on its page", () => {
    for (const { sections } of Object.values(SETTINGS_SECTIONS)) {
      const ids = Object.keys(sections);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });
});

describe("settingsSection and settingsSectionTitle", () => {
  it("give a section's element id and its sentence-case heading", () => {
    expect(settingsSection("users", "passkeys")).toEqual({
      id: "passkeys",
      title: "Your passkeys",
    });
    expect(settingsSectionTitle("account", "connection")).toBe("Cloudflare connection");
    for (const { sections } of Object.values(SETTINGS_SECTIONS)) {
      for (const title of Object.values(sections)) {
        const [first = "", ...rest] = title.split(" ");
        expect(first[0]).toBe(first[0]?.toUpperCase());
        // Later words stay lower case unless they are names (GitHub, Cloudflare, Appflare, Access).
        for (const word of rest) {
          expect(
            word === word.toLowerCase() ||
              ["GitHub", "Cloudflare", "Appflare", "Access"].includes(word),
          ).toBe(true);
        }
      }
    }
  });
});

describe("settingsPlace", () => {
  it("links to a section inside a message, labelled after its heading unless told otherwise", () => {
    expect(settingsPlace("building", "github-access")).toBe(
      "[GitHub access settings](/settings/building#github-access)",
    );
    expect(settingsPlace("domains", "external-domains", "the domains settings")).toBe(
      "[the domains settings](/settings/domains#external-domains)",
    );
    expect(plainMessage(`Enable sandbox builds in ${ENABLE_SANDBOX_PLACE} first.`)).toBe(
      "Enable sandbox builds in the Building apps settings first.",
    );
  });
});
