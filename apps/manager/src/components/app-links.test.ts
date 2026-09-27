import { describe, expect, it } from "vitest";
import {
  APP_SECTIONS,
  APP_TABS,
  type AppSectionId,
  appLink,
  appPlace,
  appSectionTab,
} from "./app-links";
import { isMessageLinkPath } from "./internal-path";
import { messageSegments } from "./message-links";

/**
 * The source of the app page and the parts it is built from, read at build
 * time, to check that every section a link can name is on the page.
 */
const PAGE_SOURCES = import.meta.glob<string>(
  [
    "../routes/_app/apps/$installId.tsx",
    "./app-settings-section.tsx",
    "./custom-domains-section.tsx",
    "./external-domains-section.tsx",
    "./source-changes-card.tsx",
    "./versions-section.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
);

describe("appLink", () => {
  it("is the app's page, or one section of it", () => {
    expect(appLink("01J9ZQ7K3M")).toBe("/apps/01J9ZQ7K3M");
    expect(appLink("01J9ZQ7K3M", "secrets")).toBe("/apps/01J9ZQ7K3M#secrets");
    expect(appLink("01J9ZQ7K3M", "external-domains")).toBe("/apps/01J9ZQ7K3M#external-domains");
  });

  it("escapes an install id that is not a plain path segment", () => {
    expect(appLink("a/b", "domains")).toBe("/apps/a%2Fb#domains");
  });

  it("makes a path a message may link to, for every section", () => {
    for (const id of Object.keys(APP_SECTIONS) as AppSectionId[]) {
      expect(isMessageLinkPath(appLink("01J9ZQ7K3M", id)), id).toBe(true);
    }
  });
});

describe("appSectionTab", () => {
  it("names the tab that holds a section, with or without the #", () => {
    expect(appSectionTab("#secrets")).toBe("settings");
    expect(appSectionTab("automatic-updates")).toBe("settings");
    expect(appSectionTab("#external-domains")).toBe("domains");
    expect(appSectionTab("#versions")).toBe("jobs");
    expect(appSectionTab("#danger-zone")).toBe("overview");
    expect(appSectionTab("#kept-resources")).toBe("resources");
  });

  it("is null for no hash or one that names no section", () => {
    expect(appSectionTab("")).toBeNull();
    expect(appSectionTab("#")).toBeNull();
    expect(appSectionTab("#nothing")).toBeNull();
    expect(appSectionTab("#toString")).toBeNull();
  });

  it("only names tabs the page has", () => {
    for (const { tab } of Object.values(APP_SECTIONS)) expect(APP_TABS).toContain(tab);
  });
});

describe("appPlace", () => {
  it("is a link inside a message, which the UI renders and plain text keeps as its label", () => {
    const message = `Add it from ${appPlace("i1", "domains", "the app's domains")}.`;
    expect(message).toBe("Add it from [the app's domains](/apps/i1#domains).");
    expect(messageSegments(message)).toContainEqual({
      kind: "link",
      label: "the app's domains",
      href: "/apps/i1#domains",
    });
  });

  it("keeps a typed name's brackets out of the link token", () => {
    expect(appPlace("i1", "external-domains", "Links [beta]")).toBe(
      "[Links (beta)](/apps/i1#external-domains)",
    );
  });

  it("falls back to the label when the path may not be linked, and never throws", () => {
    expect(appPlace("a%b", "domains", "the app's domains")).toBe("the app's domains");
    expect(appPlace("", "domains", "the app's domains")).toBe("the app's domains");
  });
});

describe("the app page", () => {
  it("has an element for every section a link can name", () => {
    const source = Object.values(PAGE_SOURCES).join("\n");
    expect(Object.keys(PAGE_SOURCES)).toHaveLength(6);
    for (const id of Object.keys(APP_SECTIONS)) {
      expect(source, id).toMatch(new RegExp(`\\bid="${id}"`));
    }
  });
});
