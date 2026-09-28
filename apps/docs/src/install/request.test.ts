import { describe, expect, it } from "vitest";
import {
  appRequest,
  catalogAppForRepo,
  type InstallApp,
  installPagePath,
  installTarget,
  isInstallRequest,
  repoRequestFromSearch,
  requestLabel,
  sameRequest,
} from "./request.ts";

const apps: InstallApp[] = [
  { slug: "2fa", name: "2FA", pitch: "Codes", icon: null, repo: "wuzf/2fa" },
  {
    slug: "cattopic",
    name: "CattoPic",
    pitch: "Pictures",
    icon: null,
    repo: "Yuri-NagaSaki/CattoPic",
  },
];

describe("appRequest", () => {
  it("takes a catalog slug and nothing else", () => {
    expect(appRequest("2fa")).toEqual({ kind: "app", slug: "2fa" });
    for (const slug of ["", "Cut", "-cut", "cut/../x", "a".repeat(64), "acme:cut"]) {
      expect(appRequest(slug), slug).toBeNull();
    }
  });
});

describe("repoRequestFromSearch", () => {
  it("reads owner/repo and a github.com address, reduced to owner/repo", () => {
    expect(repoRequestFromSearch("?repo=MendyLanda/cut")).toEqual({
      kind: "repo",
      repo: "MendyLanda/cut",
    });
    expect(repoRequestFromSearch("?repo=https://github.com/MendyLanda/cut")).toEqual({
      kind: "repo",
      repo: "MendyLanda/cut",
    });
    expect(
      repoRequestFromSearch(`?repo=${encodeURIComponent("https://github.com/o/r.git/")}`),
    ).toEqual({
      kind: "repo",
      repo: "o/r",
    });
    expect(repoRequestFromSearch("?utm_source=readme&repo=o/r")).toEqual({
      kind: "repo",
      repo: "o/r",
    });
  });

  it("refuses other hosts, branches, extra repositories and things that are not repositories", () => {
    for (const search of [
      "",
      "?repo=",
      "?repo=cut",
      "?repo=https://gitlab.com/o/r",
      "?repo=https://github.com/o/r/tree/main",
      "?repo=o/r/extra",
      "?repo=o/..",
      "?repo=-o/r",
      "?repo=javascript:alert(1)",
      "?repo=o/r&repo=p/q",
      "?next=https://evil.example",
      // A malformed escape once the query is decoded.
      "?repo=https://github.com/a/%25E0",
    ]) {
      expect(repoRequestFromSearch(search), search).toBeNull();
    }
  });
});

describe("installTarget", () => {
  it("is the saved origin plus one of the two fixed paths", () => {
    expect(installTarget("https://appflare.example.com", { kind: "app", slug: "2fa" })).toBe(
      "https://appflare.example.com/install/2fa",
    );
    expect(installTarget("http://localhost:8787", { kind: "repo", repo: "o/r.js" })).toBe(
      "http://localhost:8787/install/github/o/r.js",
    );
  });

  it("refuses an address that is not a checked origin, or a part that is not valid", () => {
    const app = { kind: "app", slug: "2fa" } as const;
    for (const origin of [
      "javascript:alert(1)",
      "https://appflare.example.com/",
      "https://appflare.example.com/x",
      "//evil.example",
      "http://evil.example",
      "https://user:pw@appflare.example.com",
    ]) {
      expect(installTarget(origin, app), origin).toBeNull();
    }
    const origin = "https://appflare.example.com";
    expect(installTarget(origin, { kind: "app", slug: "../settings" })).toBeNull();
    expect(installTarget(origin, { kind: "repo", repo: "o/r/../../x" })).toBeNull();
    expect(installTarget(origin, { kind: "repo", repo: "o/r?next=x" })).toBeNull();
  });
});

describe("requests", () => {
  it("checks a request read back from storage", () => {
    expect(isInstallRequest({ kind: "app", slug: "2fa" })).toBe(true);
    expect(isInstallRequest({ kind: "repo", repo: "o/r" })).toBe(true);
    expect(isInstallRequest({ kind: "app", slug: "../x" })).toBe(false);
    expect(isInstallRequest({ kind: "repo", repo: "o" })).toBe(false);
    expect(isInstallRequest({ kind: "url", url: "https://x" })).toBe(false);
    expect(isInstallRequest("2fa")).toBe(false);
  });

  it("matches a repository whatever its case", () => {
    expect(sameRequest({ kind: "repo", repo: "O/R" }, { kind: "repo", repo: "o/r" })).toBe(true);
    expect(sameRequest({ kind: "app", slug: "o" }, { kind: "repo", repo: "o/r" })).toBe(false);
    expect(catalogAppForRepo(apps, "yuri-nagasaki/cattopic")?.slug).toBe("cattopic");
    expect(catalogAppForRepo(apps, "o/r")).toBeUndefined();
  });

  it("links to this site's install pages and names what they install", () => {
    expect(installPagePath({ kind: "app", slug: "2fa" })).toBe("/install/2fa/");
    expect(installPagePath({ kind: "repo", repo: "o/r" })).toBe("/install/?repo=o/r");
    expect(
      repoRequestFromSearch(installPagePath({ kind: "repo", repo: "o/r.js" }).slice(9)),
    ).toEqual({
      kind: "repo",
      repo: "o/r.js",
    });
    expect(requestLabel({ kind: "app", slug: "2fa" }, apps)).toBe("2FA");
    expect(requestLabel({ kind: "app", slug: "gone" }, apps)).toBe("gone");
    expect(requestLabel({ kind: "repo", repo: "o/r" }, apps)).toBe("o/r");
  });
});
