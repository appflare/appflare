import { describe, expect, it } from "vitest";
import {
  addGithubTokenInput,
  newTokenUrl,
  orderTokensFor,
  repositoryMatchRank,
  repositoryPatterns,
} from "./tokens";

describe("repositoryPatterns", () => {
  it("reads owner/repo, owner/*, URLs and lists however they are separated", () => {
    expect(
      repositoryPatterns(
        "https://github.com/Acme/API.git, acme/*;  Other/site\nhttps://www.github.com/x/y/",
      ),
    ).toEqual(["acme/api", "acme/*", "other/site", "x/y"]);
  });
});

describe("repositoryMatchRank", () => {
  it("ranks the repository itself, then its owner, then everything, then the rest", () => {
    expect(repositoryMatchRank("acme/api", "Acme/API")).toBe(0);
    expect(repositoryMatchRank("acme/*", "acme/api")).toBe(1);
    expect(repositoryMatchRank("acme", "acme/api")).toBe(1);
    expect(repositoryMatchRank("*", "acme/api")).toBe(2);
    expect(repositoryMatchRank("other/api, acme-labs/*", "acme/api")).toBe(3);
    expect(repositoryMatchRank("all private apps", "acme/api")).toBe(2);
  });
});

describe("orderTokensFor", () => {
  it("tries the token naming the repository first, then its owner's, then the others, oldest first", () => {
    const tokens = [
      { id: "a", repositories: "other/site", createdAt: 1 },
      { id: "b", repositories: "acme/*", createdAt: 2 },
      { id: "c", repositories: "acme/web, acme/api", createdAt: 3 },
      { id: "d", repositories: "someone/else", createdAt: 0 },
      { id: "e", repositories: "acme", createdAt: 1 },
    ];
    expect(orderTokensFor(tokens, "acme/api").map((t) => t.id)).toEqual(["c", "e", "b", "d", "a"]);
  });
});

describe("newTokenUrl", () => {
  it("fills in GitHub's fine-grained token page with read-only contents and metadata", () => {
    const url = new URL(newTokenUrl("Acme private", "acme/api, acme/*"));
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      name: "Acme private",
      target_name: "acme",
      contents: "read",
      metadata: "read",
    });
    expect(new URL(newTokenUrl("", "")).searchParams.get("target_name")).toBeNull();
  });
});

describe("addGithubTokenInput", () => {
  it("takes a token-shaped value and trims the fields", () => {
    const parsed = addGithubTokenInput.parse({
      label: " Acme ",
      repositories: " acme/* ",
      token: " github_pat_11ABCDEFG0abcdefghijklmnop ",
    });
    expect(parsed).toEqual({
      label: "Acme",
      repositories: "acme/*",
      token: "github_pat_11ABCDEFG0abcdefghijklmnop",
      forReleases: false,
    });
    expect(
      addGithubTokenInput.safeParse({ label: "a", repositories: "b", token: "not a token!" })
        .success,
    ).toBe(false);
  });
});
