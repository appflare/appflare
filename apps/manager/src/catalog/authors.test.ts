import { describe, expect, it } from "vitest";
import { appAuthors, authorLinks, authorNames, maintainerProfile } from "./authors";

const gabriel = { name: "Gabriel Massadas", url: "https://massadas.com", github: "G4brym" };
const cloudflare = { name: "Cloudflare", url: "https://www.cloudflare.com", github: "cloudflare" };

describe("appAuthors", () => {
  it("takes the index row's authors over the catalog manifest's", () => {
    expect(
      appAuthors({ authors: [gabriel] }, { repo: "cloudflare/templates", authors: [cloudflare] }),
    ).toEqual([gabriel]);
  });

  it("falls back to the catalog manifest's authors, then to the repository owner", () => {
    expect(appAuthors({}, { repo: "cloudflare/templates", authors: [cloudflare] })).toEqual([
      cloudflare,
    ]);
    expect(appAuthors({}, { repo: "willswire/unifi-ddns" })).toEqual([
      { name: "willswire", github: "willswire" },
    ]);
  });

  it("is empty when neither the index nor a manifest names anyone", () => {
    expect(appAuthors({}, null)).toEqual([]);
  });
});

describe("authorNames", () => {
  it("joins names as a sentence would", () => {
    expect(authorNames([])).toBe("");
    expect(authorNames([gabriel])).toBe("Gabriel Massadas");
    expect(authorNames([gabriel, cloudflare])).toBe("Gabriel Massadas and Cloudflare");
    expect(authorNames([{ name: "A" }, { name: "B" }, { name: "C" }])).toBe("A, B, and C");
  });
});

describe("authorLinks", () => {
  it("lists the website by host, then GitHub, then X", () => {
    expect(authorLinks({ ...cloudflare, x: "Cloudflare" })).toEqual([
      { kind: "website", label: "cloudflare.com", href: "https://www.cloudflare.com" },
      { kind: "github", label: "GitHub", href: "https://github.com/cloudflare" },
      { kind: "x", label: "X", href: "https://x.com/Cloudflare" },
    ]);
  });

  it("gives no links for a name alone", () => {
    expect(authorLinks({ name: "PublicAffairs" })).toEqual([]);
  });
});

describe("maintainerProfile", () => {
  it("links a GitHub user, with or without @", () => {
    expect(maintainerProfile("MendyLanda")).toEqual({
      label: "MendyLanda",
      href: "https://github.com/MendyLanda",
    });
    expect(maintainerProfile("@octocat")).toEqual({
      label: "octocat",
      href: "https://github.com/octocat",
    });
  });

  it("links a team to its page", () => {
    expect(maintainerProfile("@example/maintainers")).toEqual({
      label: "example/maintainers",
      href: "https://github.com/orgs/example/teams/maintainers",
    });
  });

  it("shows anything else without a link", () => {
    expect(maintainerProfile("not a handle")).toEqual({ label: "not a handle", href: null });
  });
});
