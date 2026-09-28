import { describe, expect, it } from "vitest";
import { afterSignIn, returnToSearch, returnToSearchSchema, withReturnTo } from "./return-to";

const HOSTILE = [
  "//evil.example",
  "/\\evil.example",
  "javascript:alert(1)",
  "https://evil.example/catalog",
  "/login",
  "",
];

describe("the return path through the sign-in pages", () => {
  it("carries a page, its query and its section, encoded as the router reads it", () => {
    const href = withReturnTo("/login", "/apps/01J9#secrets");
    expect(href).toBe("/login?returnTo=%2Fapps%2F01J9%23secrets");
    expect(new URL(href, "https://m.test").searchParams.get("returnTo")).toBe("/apps/01J9#secrets");
    expect(withReturnTo("/forgot-password", "/install/cut")).toBe(
      "/forgot-password?returnTo=%2Finstall%2Fcut",
    );
  });

  it("leaves out home and anything that is not one of the manager's pages", () => {
    expect(withReturnTo("/login", "/")).toBe("/login");
    expect(withReturnTo("/login", undefined)).toBe("/login");
    for (const value of HOSTILE) {
      expect(withReturnTo("/login", value), value).toBe("/login");
      expect(returnToSearch(value), value).toEqual({});
    }
    expect(returnToSearch("/catalog/cut")).toEqual({ returnTo: "/catalog/cut" });
  });

  it("goes to the page asked for once signed in, else home", () => {
    expect(afterSignIn("/catalog/cut#install")).toBe("/catalog/cut#install");
    for (const value of [...HOSTILE, undefined, 7]) expect(afterSignIn(value)).toBe("/");
  });

  it("reads ?returnTo= leniently: a hostile or malformed value is dropped, never an error", () => {
    expect(returnToSearchSchema.parse({ returnTo: "/install/cut" })).toEqual({
      returnTo: "/install/cut",
    });
    for (const value of [...HOSTILE, 42, { a: 1 }, "x".repeat(2000)]) {
      expect(returnToSearchSchema.parse({ returnTo: value })).toEqual({ returnTo: undefined });
    }
  });
});
