import { describe, expect, it } from "vitest";
import { isInternalPagePath, isMessageLinkPath } from "./internal-path";
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
