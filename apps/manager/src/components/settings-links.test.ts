import { describe, expect, it } from "vitest";
import { MANAGER_UPDATES_HREF } from "../installs/pending-updates";
import { ANALYTICS_ENGINE_CHECKLIST_LINK } from "../onboarding/checklist";
import { ENABLE_SANDBOX_PLACE } from "../sandbox/connect-copy";
import { SANDBOX_CHECKLIST_HREF } from "../sandbox/readiness";
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
  it("builds the path of a page, and of a section or a checklist row on it", () => {
    expect(settingsLink("account")).toBe("/settings/account");
    expect(settingsLink("account", "github-access")).toBe("/settings/account#github-access");
    expect(settingsLink("account", "sandbox")).toBe("/settings/account#sandbox");
    expect(settingsLink("account", "capabilities")).toBe("/settings/account#capabilities");
    expect(settingsLink("account", "checklist-r2")).toBe("/settings/account#checklist-r2");
    expect(settingsLink("general", "danger-zone")).toBe("/settings#danger-zone");
    expect(settingsLink("users", "passkeys")).toBe("/settings/users#passkeys");
    expect(settingsLink("domains", "external-domains")).toBe("/settings/domains#external-domains");
    expect(settingsLink("appflareUpdates", "versions")).toBe("/settings/appflare-updates#versions");
  });

  it("only takes the sections of the page it is given", () => {
    // @ts-expect-error: the passkeys section is on the users page.
    settingsLink("account", "passkeys");
    // @ts-expect-error: checklist rows are on the account page only.
    settingsLink("users", "checklist-r2");
  });

  it("is where every settings page and the links into them take their paths from", () => {
    for (const [key, page] of Object.entries(SETTINGS_PAGES)) {
      expect(page.href).toBe(SETTINGS_SECTIONS[key as keyof typeof SETTINGS_SECTIONS].path);
    }
    expect(ACCOUNT_LINKS.passkeys).toBe("/settings/users#passkeys");
    expect(MANAGER_UPDATES_HREF).toBe("/settings/appflare-updates");
    expect(SANDBOX_CHECKLIST_HREF).toBe("/settings/account#checklist-sandbox");
    expect(ANALYTICS_ENGINE_CHECKLIST_LINK.href).toBe(
      "/settings/account#checklist-analytics-engine",
    );
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
    expect(settingsPlace("account", "github-access")).toBe(
      "[GitHub access settings](/settings/account#github-access)",
    );
    expect(settingsPlace("domains", "external-domains", "the domains settings")).toBe(
      "[the domains settings](/settings/domains#external-domains)",
    );
    expect(plainMessage(`Enable sandbox builds in ${ENABLE_SANDBOX_PLACE} first.`)).toBe(
      "Enable sandbox builds in Sandbox builds settings first.",
    );
  });
});
