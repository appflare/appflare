import { describe, expect, it } from "vitest";
import {
  addGithubTokenInput,
  deleteTokenDescription,
  githubTokenUses,
  newTokenUrl,
  orderTokensFor,
  RELEASE_DOWNLOADS_HELP,
  releaseTakeoverNote,
  repositoryMatchRank,
  repositoryPatterns,
  storedRepositories,
} from "./tokens";

describe("repositoryPatterns", () => {
  it("reads owner/repo, owner/*, URLs and lists however they are separated", () => {
    expect(
      repositoryPatterns(
        "https://github.com/Acme/API.git, acme/*;  Other/site\nhttps://www.github.com/x/y/",
      ),
    ).toEqual(["acme/api", "acme/*", "other/site", "x/y"]);
  });

  it("reads a record that names no repositories as none", () => {
    expect(repositoryPatterns(null)).toEqual([]);
    expect(repositoryPatterns(undefined)).toEqual([]);
  });
});

describe("repositoryMatchRank", () => {
  it("ranks the repository itself, its owner, everything, any, then not for it", () => {
    expect(repositoryMatchRank("acme/api", "Acme/API")).toBe(0);
    expect(repositoryMatchRank("acme/*", "acme/api")).toBe(1);
    expect(repositoryMatchRank("acme", "acme/api")).toBe(1);
    expect(repositoryMatchRank("*", "acme/api")).toBe(2);
    expect(repositoryMatchRank("all private apps", "acme/api")).toBe(2);
    expect(repositoryMatchRank(null, "acme/api")).toBe(3);
    expect(repositoryMatchRank("", "acme/api")).toBe(3);
    expect(repositoryMatchRank("other/api, acme-labs/*", "acme/api")).toBe(4);
  });
});

describe("orderTokensFor", () => {
  it("tries the most specific token first: the repository, its owner, everything, then any", () => {
    const tokens = [
      { id: "any", repositories: null, forBuilds: true, createdAt: 0 },
      { id: "star", repositories: "*", forBuilds: true, createdAt: 1 },
      { id: "owner", repositories: "acme/*", forBuilds: true, createdAt: 2 },
      { id: "exact", repositories: "acme/web, acme/api", forBuilds: true, createdAt: 3 },
      { id: "owner-older", repositories: "acme", forBuilds: true, createdAt: 1 },
    ];
    expect(orderTokensFor(tokens, "acme/api").map((t) => t.id)).toEqual([
      "exact",
      "owner-older",
      "owner",
      "star",
      "any",
    ]);
  });

  it("never tries a token for other repositories, nor one not for builds", () => {
    const tokens = [
      { id: "acme", repositories: "acme/*", forBuilds: true, createdAt: 1 },
      { id: "other", repositories: "other/site", forBuilds: true, createdAt: 2 },
      { id: "any", repositories: null, forBuilds: true, createdAt: 3 },
      { id: "empty", repositories: "", forBuilds: true, createdAt: 4 },
      { id: "releases", repositories: null, forBuilds: false, createdAt: 0 },
      { id: "named-releases", repositories: "evil/app", forBuilds: false, createdAt: 0 },
    ];
    expect(orderTokensFor(tokens, "evil/app").map((t) => t.id)).toEqual(["any", "empty"]);
    expect(orderTokensFor(tokens, "acme/api").map((t) => t.id)).toEqual(["acme", "any", "empty"]);
  });
});

describe("githubTokenUses", () => {
  it("says in plain words what each token is used for", () => {
    expect(
      githubTokenUses({
        repositories: "acme/*, https://github.com/Other/Site.git",
        forBuilds: true,
        forReleases: false,
      }),
    ).toEqual(["Builds of acme/*, other/site"]);
    expect(githubTokenUses({ repositories: null, forBuilds: true, forReleases: true })).toEqual([
      "Builds of any private repository",
      "Appflare release downloads",
    ]);
    expect(githubTokenUses({ repositories: null, forBuilds: false, forReleases: true })).toEqual([
      "Appflare release downloads",
    ]);
    // Release downloads moved to another token, and it was for nothing else.
    expect(githubTokenUses({ repositories: null, forBuilds: false, forReleases: false })).toEqual([
      "Not used",
    ]);
  });
});

describe("releaseTakeoverNote", () => {
  it("says the current token will be used for nothing when that was its only use", () => {
    expect(releaseTakeoverNote({ label: "Updates", forBuilds: false })).toBe(
      '"Updates" is used for this now. Only one token can be, so ticking it here moves it to this one. "Updates" will then be used for nothing; you can delete it.',
    );
    expect(releaseTakeoverNote({ label: "Acme", forBuilds: true })).not.toContain("nothing");
  });
});

describe("deleteTokenDescription", () => {
  it("names only what the token was used for", () => {
    const releasesOnly = deleteTokenDescription({ forBuilds: false, forReleases: true });
    expect(releasesOnly).toContain("downloads its own releases without it");
    expect(releasesOnly).not.toContain("rebuilt");
    const buildsOnly = deleteTokenDescription({ forBuilds: true, forReleases: false });
    expect(buildsOnly).toContain("cannot be rebuilt");
    expect(buildsOnly).not.toContain("releases");
  });
});

describe("RELEASE_DOWNLOADS_HELP", () => {
  it("says what it is for, when it is needed, and the access the token needs", () => {
    expect(RELEASE_DOWNLOADS_HELP).toContain(
      "While Appflare's own repository on GitHub is private",
    );
    expect(RELEASE_DOWNLOADS_HELP).toContain(
      "read-only access to the contents of appflare/appflare",
    );
  });
});

describe("newTokenUrl", () => {
  it("points a token only for release downloads at Appflare's own repository owner", () => {
    const url = new URL(newTokenUrl("Updates", "acme/*", { forBuilds: false, forReleases: true }));
    expect(url.searchParams.get("target_name")).toBe("appflare");
    expect(url.searchParams.get("description")).toBe(
      "Appflare: read-only access to download its releases",
    );
    expect(url.searchParams.get("contents")).toBe("read");
  });

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
      forBuilds: true,
      forReleases: false,
    });
    expect(
      addGithubTokenInput.safeParse({ label: "a", repositories: "b", token: "not a token!" })
        .success,
    ).toBe(false);
  });

  it("takes no repositories at all, for builds of any repository or for release downloads only", () => {
    const TOKEN = "github_pat_11ABCDEFG0abcdefghijklmnop";
    const any = addGithubTokenInput.parse({ label: "Any", token: TOKEN });
    expect(storedRepositories(any)).toBeNull();
    const blank = addGithubTokenInput.parse({ label: "Blank", repositories: "  ", token: TOKEN });
    expect(storedRepositories(blank)).toBeNull();
    const releases = addGithubTokenInput.parse({
      label: "Updates",
      repositories: "acme/*",
      token: TOKEN,
      forBuilds: false,
      forReleases: true,
    });
    // Not used for builds: a description would order nothing, so none is kept.
    expect(storedRepositories(releases)).toBeNull();
    expect(storedRepositories({ repositories: " acme/* ", forBuilds: true })).toBe("acme/*");
  });

  it("refuses a token used for nothing", () => {
    const result = addGithubTokenInput.safeParse({
      label: "Nothing",
      token: "github_pat_11ABCDEFG0abcdefghijklmnop",
      forBuilds: false,
      forReleases: false,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("Choose what Appflare uses the token for.");
  });

  it("checks a description when one is given", () => {
    const TOKEN = "github_pat_11ABCDEFG0abcdefghijklmnop";
    for (const repositories of [
      "acme/api",
      "acme/*, other/site",
      "acme",
      "*",
      "https://github.com/Acme/API.git",
    ]) {
      expect(
        addGithubTokenInput.safeParse({ label: "a", repositories, token: TOKEN }).success,
      ).toBe(true);
    }
    const result = addGithubTokenInput.safeParse({
      label: "a",
      repositories: "acme/api/extra",
      token: TOKEN,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'Name repositories as owner/repo, or owner/* for all of an owner\'s, separated by commas. "acme/api/extra" is neither.',
    );
  });
});
