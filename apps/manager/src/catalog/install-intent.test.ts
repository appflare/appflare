import { describe, expect, it } from "vitest";
import { installLinkKey, installLinkRepository, prefilledRepository } from "./install-intent";

describe("installLinkKey", () => {
  it("takes a catalog slug, or a catalog's own app key", () => {
    expect(installLinkKey("cut")).toEqual({ key: "cut", plain: true });
    expect(installLinkKey("open-seo")).toEqual({ key: "open-seo", plain: true });
    expect(installLinkKey("acme:cut")).toEqual({ key: "acme:cut", plain: false });
    // The official catalog's key is the plain slug.
    expect(installLinkKey("official:cut")).toEqual({ key: "cut", plain: false });
  });

  it("refuses anything that cannot be a slug", () => {
    for (const raw of [
      "",
      "Cut",
      "-cut",
      "cut/x",
      "../settings",
      "cut%2F",
      "cut?x=1",
      "a".repeat(64),
      "acme:",
      ":cut",
      "ACME:cut",
      "repository:cut",
      "acme:cut:x",
      "javascript:alert(1)",
    ]) {
      expect(installLinkKey(raw), raw).toBeNull();
    }
  });
});

describe("installLinkRepository", () => {
  it("normalises owner and repository, dropping .git", () => {
    expect(installLinkRepository("cloudflare", "agents-starter")).toBe("cloudflare/agents-starter");
    expect(installLinkRepository("MendyLanda", "my.app_1.git")).toBe("MendyLanda/my.app_1");
  });

  it("refuses what GitHub would not name a repository", () => {
    for (const [owner, repo] of [
      ["", "repo"],
      ["owner", ""],
      ["-owner", "repo"],
      ["own--er", "repo"],
      ["owner", ".."],
      ["owner", "."],
      ["owner", "re/po"],
      ["owner", "re po"],
      ["owner", "repo\\x"],
      ["a".repeat(40), "repo"],
      ["owner", "r".repeat(101)],
      ["https:", "evil.example"],
    ] as const) {
      expect(installLinkRepository(owner, repo), `${owner}/${repo}`).toBeNull();
    }
  });
});

describe("prefilledRepository (the catalog page's ?repository=)", () => {
  it("keeps owner/repo and nothing else", () => {
    expect(prefilledRepository("cloudflare/agents-starter")).toBe("cloudflare/agents-starter");
    for (const value of [
      undefined,
      42,
      "cloudflare",
      "https://github.com/cloudflare/agents-starter",
      "cloudflare/agents-starter/tree/main",
      "//evil.example/x",
    ]) {
      expect(prefilledRepository(value), String(value)).toBeNull();
    }
  });
});
