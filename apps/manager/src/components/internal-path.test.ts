import { describe, expect, it } from "vitest";
import { isInternalPagePath, isMessageLinkPath, safeReturnPath } from "./internal-path";
import { messageSegments } from "./message-links";

/** Spellings a browser resolves to another site, or that run script. */
const HOSTILE = [
  "/\\evil.com",
  "/\\/evil.com",
  "//evil.com",
  "///evil.com",
  "/%5Cevil.com",
  "/%2F%2Fevil.com",
  "/settings/%5C..",
  "/settings\\evil",
  "/settings//evil.com",
  "javascript:alert(1)",
  "/javascript:alert(1)",
  "https://evil.com/settings",
  "/settings/account#a b",
  "/settings/account#\\evil",
  "",
];

describe("isMessageLinkPath", () => {
  it("accepts the manager's signed-in pages, with a section", () => {
    for (const href of [
      "/settings",
      "/settings/building#github-access",
      "/settings/users#passkeys",
      "/apps/01J9ZQ7K3M",
      "/jobs/01J9ZQ7K3M",
      "/catalog/mine:cut",
    ]) {
      expect(isMessageLinkPath(href), href).toBe(true);
    }
  });

  it("refuses every other spelling, other roots, and a query", () => {
    for (const href of [...HOSTILE, "/", "/login", "/api/health", "/settings?x=1", "/evil"]) {
      expect(isMessageLinkPath(href), href).toBe(false);
    }
  });
});

describe("isInternalPagePath", () => {
  it("accepts home, the sign-in pages, and pages with a query", () => {
    for (const href of [
      "/",
      "/login",
      "/forgot-password",
      "/catalog?category=media&plan=free",
      "/apps/01J9ZQ7K3M?tab=domains",
      "/settings/building#sandbox",
    ]) {
      expect(isInternalPagePath(href), href).toBe(true);
    }
  });

  it("refuses the spellings that leave the site, and paths outside the app", () => {
    for (const href of [...HOSTILE, "/api/health", "/evil", "/catalog?next=//evil.com"]) {
      expect(isInternalPagePath(href), href).toBe(false);
    }
  });

  it("refuses segments of only dots, which the browser resolves to another page", () => {
    for (const href of [
      "/catalog/x/../../login",
      "/catalog/../api/health",
      "/settings/./account",
      "/apps/..",
      "/apps/...#x",
      "/catalog/..?q=1",
    ]) {
      expect(isInternalPagePath(href), href).toBe(false);
      expect(isMessageLinkPath(href), href).toBe(false);
      expect(safeReturnPath(href), href).toBeNull();
    }
    // Dots inside a name are fine.
    expect(safeReturnPath("/install/github/owner/my.app")).toBe("/install/github/owner/my.app");
    expect(safeReturnPath("/catalog/a..b")).toBe("/catalog/a..b");
  });

  it("opens a sign-in page carrying a return path in place", () => {
    expect(isInternalPagePath("/login?returnTo=%2Fapps%2F01J9%23secrets")).toBe(true);
    expect(isInternalPagePath("/install/github/owner/repo")).toBe(true);
  });
});

describe("safeReturnPath", () => {
  it("keeps home, the signed-in pages with a query and a section, and the install links", () => {
    for (const href of [
      "/",
      "/catalog/cut",
      "/catalog/acme:cut#install",
      "/apps/01J9ZQ7K3M#secrets",
      "/settings/building#github-access",
      "/catalog?category=media&q=photo+album",
      "/catalog?repository=owner%2Frepo",
      "/install/cut",
      "/install/github/cloudflare/agents-starter",
      // Setup's last step, where the wizard resumes at a new address.
      "/setup?checklist=true",
      "/setup?checklist=true&address=true&returnTo=%2Fapps%2Fx",
    ]) {
      expect(safeReturnPath(href), href).toBe(href);
    }
  });

  it("drops other sites, other spellings of them, and the sign-in pages", () => {
    for (const href of [
      ...HOSTILE,
      "//evil",
      "/\\evil",
      "javascript:alert(1)",
      "https://evil.example/catalog",
      "http://evil.example",
      "/login",
      "/login?returnTo=%2Fcatalog",
      "/setup",
      "/setup?returnTo=%2Fcatalog",
      "/setup?checklist=false",
      "/setup?checklist=true&next=//evil.com",
      "/setup/x?checklist=true",
      "/forgot-password",
      "/api/health",
      "/catalog?next=//evil.com",
      "/catalog?next=%zz",
      "/catalog#a#b",
      `/catalog/${"a".repeat(1100)}`,
      undefined,
      42,
    ]) {
      expect(safeReturnPath(href), String(href)).toBeNull();
    }
  });
});

describe("messageSegments with hostile links", () => {
  it("leaves them as text", () => {
    for (const href of HOSTILE) {
      const message = `Open [the settings](${href}) now`;
      expect(messageSegments(message), href).toEqual([{ kind: "text", text: message }]);
    }
  });

  it("does not let nested brackets smuggle a link", () => {
    for (const message of [
      "[a [b](/settings)](/\\evil.com)",
      "[[a](/\\evil.com)](/settings)",
      "[a](/settings](/\\evil.com)",
    ]) {
      const links = messageSegments(message).filter((s) => s.kind === "link");
      for (const link of links) expect(isMessageLinkPath(link.href), message).toBe(true);
      expect(links.every((l) => !l.href.includes("\\"))).toBe(true);
    }
  });
});
