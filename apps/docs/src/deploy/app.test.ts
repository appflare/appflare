import { describe, expect, it } from "vitest";
import { appInstallUrl, appParam, deployPathFor, ownerSetupThenInstall } from "./app.ts";

describe("appParam", () => {
  it("reads one catalog slug", () => {
    expect(appParam("?app=open-seo")).toEqual({ kind: "app", slug: "open-seo" });
    expect(appParam("?utm_source=x&app=cut")).toEqual({ kind: "app", slug: "cut" });
    expect(appParam("?app=2fa")).toEqual({ kind: "app", slug: "2fa" });
  });

  it("says when there is none", () => {
    expect(appParam("")).toEqual({ kind: "none" });
    expect(appParam("?repo=a/b")).toEqual({ kind: "none" });
  });

  it.each([
    "?app=",
    "?app=Open-SEO",
    "?app=-cut",
    "?app=cut&app=cut",
    "?app=a%2Fb",
    "?app=..",
    "?app=cut%0A",
    "?app=cut%20",
    "?app=official:cut",
    "?app=javascript:alert(1)",
    `?app=${"a".repeat(64)}`,
  ])("refuses %s", (search) => {
    expect(appParam(search)).toEqual({ kind: "invalid" });
  });
});

describe("deployPathFor", () => {
  it("is exactly /deploy/?app=<slug>", () => {
    expect(deployPathFor("open-seo")).toBe("/deploy/?app=open-seo");
    expect(appParam(new URL(deployPathFor("cut") ?? "", "https://appflare.dev").search)).toEqual({
      kind: "app",
      slug: "cut",
    });
  });

  it("refuses what is not a slug", () => {
    expect(deployPathFor("a/b")).toBeNull();
    expect(deployPathFor("")).toBeNull();
  });
});

describe("appInstallUrl", () => {
  it("is the install link an Install button opens", () => {
    expect(appInstallUrl("https://appflare.example.com", "open-seo")).toBe(
      "https://appflare.example.com/install/open-seo",
    );
  });

  it("refuses an address that is not an origin, or a slug that is not one", () => {
    expect(appInstallUrl("https://appflare.example.com/x", "cut")).toBeNull();
    expect(appInstallUrl("javascript:alert(1)", "cut")).toBeNull();
    expect(appInstallUrl("https://appflare.example.com", "../settings")).toBeNull();
  });
});

describe("ownerSetupThenInstall", () => {
  const claim = "#claim=claim0123456789abcdef";

  it("adds the install link as setup's return path, keeping the claim in the fragment", () => {
    const url = ownerSetupThenInstall(`https://appflare.example.com/setup${claim}`, "open-seo");
    // As Appflare writes it when it sends an install link to setup (`withReturnTo`).
    expect(url).toBe(`https://appflare.example.com/setup?returnTo=%2Finstall%2Fopen-seo${claim}`);
    const parsed = new URL(url ?? "");
    expect(parsed.origin).toBe("https://appflare.example.com");
    expect(parsed.searchParams.get("returnTo")).toBe("/install/open-seo");
    expect(parsed.hash).toBe(claim);
  });

  it("works at a workers.dev address too", () => {
    expect(
      ownerSetupThenInstall(`https://appflare.main-sub.workers.dev/setup${claim}`, "cut"),
    ).toBe(`https://appflare.main-sub.workers.dev/setup?returnTo=%2Finstall%2Fcut${claim}`);
  });

  it("gives nothing for a slug or URL that is not one", () => {
    expect(ownerSetupThenInstall(`https://appflare.example.com/setup${claim}`, "a/b")).toBeNull();
    expect(ownerSetupThenInstall("not a url", "cut")).toBeNull();
  });
});
