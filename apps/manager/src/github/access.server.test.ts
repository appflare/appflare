import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { GitRefError } from "../installs/git-refs";
import { fakeSandbox } from "../test/fake-sandbox";
import { readRepositoryRefs } from "./access.server";
import { releaseTokenOptions, releaseTokenSecret } from "./release-access.server";
import { readGithubTokens } from "./tokens.server";

const MAIN = "6cb1ba365fd6b395a116ab6d1734e19f9d9a0d65";
const AT = new Date("2026-09-26T12:00:00Z");

function pkt(data: string): string {
  return `${(data.length + 4).toString(16).padStart(4, "0")}${data}`;
}

const ADVERTISEMENT = [
  pkt("# service=git-upload-pack\n"),
  "0000",
  pkt(`${MAIN} HEAD\0multi_ack symref=HEAD:refs/heads/main agent=git/github\n`),
  pkt(`${MAIN} refs/heads/main\n`),
  "0000",
].join("");

/** The manager's own fetch: GitHub as a reader without a token sees it. */
function anonymous(publicRepos: readonly string[]) {
  const seen: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    seen.push(input);
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    const repo = /github\.com\/(.+)\.git\/info\/refs/.exec(input)?.[1] ?? "";
    return publicRepos.includes(repo)
      ? new Response(ADVERTISEMENT)
      : new Response("Repository not found.", { status: 401 });
  };
  return { fetch, seen };
}

async function addToken(id: string, repositories: string, createdAt: number, forReleases = false) {
  await env.DB.prepare(
    "INSERT INTO github_tokens (id, label, repositories, for_releases, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, `label ${id}`, repositories, forReleases ? 1 : 0, createdAt)
    .run();
}

const OTHER = "01J8TOKENAAAAAAAAAAAAAAAAA";
const OWNER = "01J8TOKENBBBBBBBBBBBBBBBBB";
const EXACT = "01J8TOKENCCCCCCCCCCCCCCCCC";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("readRepositoryRefs", () => {
  it("reads a public repository without a token, and never asks the sandbox Worker", async () => {
    await addToken(EXACT, "acme/api", 1);
    const sandbox = fakeSandbox(null);
    const anon = anonymous(["acme/api"]);
    const refs = await readRepositoryRefs(
      { db: env.DB, fetch: anon.fetch, sandbox, now: () => AT },
      "acme/api",
    );
    expect(refs.token).toBeNull();
    expect(refs.refs.get("refs/heads/main")).toBe(MAIN);
    expect(sandbox.githubRequests).toEqual([]);
    expect((await readGithubTokens(env.DB))[0]?.lastUsedAt).toBeNull();
  });

  it("tries the tokens through the sandbox Worker, the one naming the repository first", async () => {
    await addToken(OTHER, "other/site", 1);
    await addToken(OWNER, "acme/*", 2);
    await addToken(EXACT, "acme/web, acme/api", 3);
    const sandbox = fakeSandbox(null, {
      // Only the owner-wide token can read it.
      github: ({ url, tokenSecret, headers }) => {
        expect(url).toBe("https://github.com/acme/api.git/info/refs?service=git-upload-pack");
        expect(headers.get("authorization")).toBeNull();
        return tokenSecret === `GITHUB_TOKEN_${OWNER}`
          ? new Response(ADVERTISEMENT)
          : new Response("", { status: 404 });
      },
    });
    const refs = await readRepositoryRefs(
      { db: env.DB, fetch: anonymous([]).fetch, sandbox, now: () => AT },
      "acme/api",
    );
    expect(refs.token).toEqual({ id: OWNER, label: `label ${OWNER}` });
    expect(sandbox.githubRequests.map((r) => (r as { tokenSecret: string }).tokenSecret)).toEqual([
      `GITHUB_TOKEN_${EXACT}`,
      `GITHUB_TOKEN_${OWNER}`,
    ]);
    const used = await readGithubTokens(env.DB);
    expect(used.find((t) => t.id === OWNER)?.lastUsedAt).toBe(AT.getTime());
    expect(used.find((t) => t.id === EXACT)?.lastUsedAt).toBeNull();
  });

  it("says how to read a private repository when no token can", async () => {
    const anon = anonymous([]);
    const none = readRepositoryRefs({ db: env.DB, fetch: anon.fetch }, "acme/api");
    await expect(none).rejects.toThrow(GitRefError);
    await expect(none).rejects.toThrow(
      /add a GitHub access token that can read it in \[GitHub access settings\]\(\/settings\/building#github-access\)/,
    );

    await addToken(EXACT, "acme/api", 1);
    await expect(readRepositoryRefs({ db: env.DB, fetch: anon.fetch }, "acme/api")).rejects.toThrow(
      /sandbox builds are off/,
    );
    const sandbox = fakeSandbox(null, {
      github: () => {
        throw new Error("the sandbox Worker does not hold the GitHub access token");
      },
    });
    await expect(
      readRepositoryRefs({ db: env.DB, fetch: anon.fetch, sandbox }, "acme/api"),
    ).rejects.toThrow(
      /the GitHub access token in .* cannot read it\. Last problem: .*does not hold/,
    );
  });
});

describe("a token added a moment ago", () => {
  it("says to try again in a minute when the sandbox Worker does not hold it yet", async () => {
    await addToken(EXACT, "acme/api", AT.getTime() - 30_000);
    const sandbox = fakeSandbox(null, {
      github: () => {
        throw new Error("the sandbox Worker does not hold the GitHub access token");
      },
    });
    const reading = readRepositoryRefs(
      { db: env.DB, fetch: anonymous([]).fetch, sandbox, now: () => AT },
      "acme/api",
    );
    await expect(reading).rejects.toThrow(
      `The GitHub access token "label ${EXACT}" was just added, and the sandbox Worker does not have it yet; try again in a minute.`,
    );
  });
});

describe("release downloads", () => {
  it("use the marked token through the sandbox Worker, else GITHUB_TOKEN", async () => {
    const sandbox = fakeSandbox(null, {
      github: ({ url }) =>
        url.endsWith("/missing") ? new Response("", { status: 404 }) : Response.json([]),
    });
    expect(await releaseTokenSecret({ DB: env.DB, SANDBOX: sandbox })).toBeNull();
    await addToken(OTHER, "appflare/appflare", 1, true);
    expect(await releaseTokenSecret({ DB: env.DB })).toBeNull();
    const secret = await releaseTokenSecret({ DB: env.DB, SANDBOX: sandbox });
    expect(secret).toBe(`GITHUB_TOKEN_${OTHER}`);
    // Finding it is not using it.
    expect((await readGithubTokens(env.DB))[0]?.lastUsedAt).toBeNull();

    const viaSandbox = releaseTokenOptions(
      { GITHUB_TOKEN: "env", SANDBOX: sandbox, DB: env.DB },
      secret,
      undefined,
      () => AT,
    );
    expect(viaSandbox.token).toBeUndefined();
    await viaSandbox.github?.("https://api.github.com/repos/appflare/appflare/missing");
    expect((await readGithubTokens(env.DB))[0]?.lastUsedAt).toBeNull();
    await viaSandbox.github?.("https://api.github.com/repos/appflare/appflare/releases", {
      headers: { accept: "application/vnd.github+json", cookie: "dropped" },
    });
    expect((await readGithubTokens(env.DB))[0]?.lastUsedAt).toBe(AT.getTime());
    expect(sandbox.githubRequests.at(-1)).toEqual({
      protocol: 1,
      url: "https://api.github.com/repos/appflare/appflare/releases",
      tokenSecret: `GITHUB_TOKEN_${OTHER}`,
      headers: { accept: "application/vnd.github+json" },
    });
    expect(releaseTokenOptions({ GITHUB_TOKEN: "env" }, secret)).toEqual({ token: "env" });
    expect(releaseTokenOptions({ GITHUB_TOKEN: "env", SANDBOX: sandbox }, null)).toEqual({
      token: "env",
    });
  });
});
