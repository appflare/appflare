import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { SandboxInfo } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { githubTokenUses } from "./tokens";
import {
  addGithubTokenCore,
  deleteGithubTokenCore,
  type GithubTokenDeps,
  githubTokenCount,
  githubTokenViews,
  readGithubTokens,
} from "./tokens.server";

const TOKEN = "github_pat_11AAAAAAA0secretvalue_DO_NOT_LEAK";
const INFO: SandboxInfo = {
  protocol: 1,
  sandboxVersion: "0.2.0",
  image: "docker.io/mendylanda/appflare-sandbox:0.2.0",
  features: ["self-deploying", "repository-builds", "github-tokens"],
};

function deps(overrides: Partial<GithubTokenDeps> = {}) {
  const secrets = new Map<string, string>();
  const calls: string[] = [];
  let n = 0;
  const d: GithubTokenDeps = {
    db: env.DB,
    sandbox: async () => ({ connected: true, info: INFO }),
    async putSandboxSecret(name, value) {
      calls.push(`PUT ${name}`);
      secrets.set(name, value);
    },
    async deleteSandboxSecret(name) {
      calls.push(`DELETE ${name}`);
      secrets.delete(name);
    },
    now: () => new Date("2026-09-26T12:00:00Z"),
    newId: () => `01J8TOKEN${String(++n).padStart(17, "0")}`,
    ...overrides,
  };
  return { deps: d, secrets, calls };
}

/** Every value of every row of every table: where a token must never be. */
async function everythingInD1(): Promise<string> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  const dump: unknown[] = [];
  for (const { name } of results) {
    dump.push((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results);
  }
  return JSON.stringify(dump);
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("addGithubTokenCore", () => {
  it("stores the value as a sandbox Worker secret and records only its name and description", async () => {
    const { deps: d, secrets, calls } = deps();
    const { id } = await addGithubTokenCore(d, {
      label: "Acme private",
      repositories: "acme/*",
      token: TOKEN,
    });
    expect(calls).toEqual([`PUT GITHUB_TOKEN_${id}`]);
    expect(secrets.get(`GITHUB_TOKEN_${id}`)).toBe(TOKEN);
    expect(await readGithubTokens(env.DB)).toEqual([
      {
        id,
        label: "Acme private",
        repositories: "acme/*",
        forBuilds: true,
        forReleases: false,
        createdAt: Date.parse("2026-09-26T12:00:00Z"),
        lastUsedAt: null,
      },
    ]);
    expect(await everythingInD1()).not.toContain(TOKEN);
    expect(await githubTokenCount(env.DB)).toBe(1);
  });

  it("records a token that names no repositories, and one only for release downloads", async () => {
    const { deps: d } = deps();
    const any = await addGithubTokenCore(d, { label: "Any", repositories: "", token: TOKEN });
    const updates = await addGithubTokenCore(d, {
      label: "Updates",
      token: TOKEN,
      forBuilds: false,
      forReleases: true,
    });
    const records = await readGithubTokens(env.DB);
    expect(
      records.map(({ id, repositories, forBuilds, forReleases }) => ({
        id,
        repositories,
        forBuilds,
        forReleases,
      })),
    ).toEqual([
      { id: any.id, repositories: null, forBuilds: true, forReleases: false },
      { id: updates.id, repositories: null, forBuilds: false, forReleases: true },
    ]);
  });

  it("leaves a token only for release downloads used for nothing when another takes that over", async () => {
    const { deps: d } = deps();
    const old = await addGithubTokenCore(d, {
      label: "Old updates",
      token: TOKEN,
      forBuilds: false,
      forReleases: true,
    });
    await addGithubTokenCore(d, { label: "New", token: TOKEN, forReleases: true });
    const views = githubTokenViews(await readGithubTokens(env.DB));
    const left = views.find((t) => t.id === old.id);
    expect(left).toMatchObject({ forBuilds: false, forReleases: false });
    expect(left && githubTokenUses(left)).toEqual(["Not used"]);
  });

  it("refuses a token used for nothing, before storing anything", async () => {
    const { deps: d, calls } = deps();
    await expect(
      addGithubTokenCore(d, { label: "x", token: TOKEN, forBuilds: false, forReleases: false }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(await githubTokenCount(env.DB)).toBe(0);
  });

  it("keeps at most one token for release downloads", async () => {
    const { deps: d } = deps();
    const first = await addGithubTokenCore(d, {
      label: "one",
      repositories: "a/*",
      token: TOKEN,
      forReleases: true,
    });
    const second = await addGithubTokenCore(d, {
      label: "two",
      repositories: "b/*",
      token: TOKEN,
      forReleases: true,
    });
    const marked = (await readGithubTokens(env.DB)).filter((t) => t.forReleases).map((t) => t.id);
    expect(marked).toEqual([second.id]);
    expect(marked).not.toContain(first.id);
  });

  it("takes the record back when the secret cannot be written, leaving no orphan", async () => {
    const { deps: d } = deps();
    const kept = await addGithubTokenCore(d, {
      label: "one",
      repositories: "a/*",
      token: TOKEN,
      forReleases: true,
    });
    let recordedBeforeWrite = false;
    const failing = deps({
      newId: () => "01J8TOKENFAILING0000000000",
      async putSandboxSecret() {
        recordedBeforeWrite = (await githubTokenCount(env.DB)) === 2;
        throw new Error("Cloudflare API 500");
      },
    });
    await expect(
      addGithubTokenCore(failing.deps, {
        label: "two",
        repositories: "b/*",
        token: TOKEN,
        forReleases: true,
      }),
    ).rejects.toThrow("Cloudflare API 500");
    expect(recordedBeforeWrite).toBe(true);
    expect(await readGithubTokens(env.DB)).toMatchObject([{ id: kept.id, forReleases: true }]);
  });

  it("refuses without sandbox builds, with a sandbox Worker too old, or while it runs a job", async () => {
    const off = deps({ sandbox: async () => ({ connected: false, info: null }) });
    await expect(
      addGithubTokenCore(off.deps, { label: "a", repositories: "a/*", token: TOKEN }),
    ).rejects.toThrow(/kept on the sandbox Worker. Enable sandbox builds/);
    const old = deps({
      sandbox: async () => ({
        connected: true,
        info: { ...INFO, sandboxVersion: "0.1.3", features: ["repository-builds"] },
      }),
    });
    await expect(
      addGithubTokenCore(old.deps, { label: "a", repositories: "a/*", token: TOKEN }),
    ).rejects.toThrow(/0\.1\.3 cannot use GitHub access tokens yet/);
    await env.DB.prepare(
      "INSERT INTO jobs (id, kind, status, input_json) VALUES ('j1', 'sandbox_update', 'running', '{}')",
    ).run();
    const busy = deps();
    await expect(
      addGithubTokenCore(busy.deps, { label: "a", repositories: "a/*", token: TOKEN }),
    ).rejects.toThrow(/busy/);
    for (const attempt of [off, old, busy]) expect(attempt.calls).toEqual([]);
    expect(await githubTokenCount(env.DB)).toBe(0);
  });
});

describe("deleteGithubTokenCore", () => {
  it("deletes the secret from the sandbox Worker, then the record", async () => {
    const { deps: d, secrets, calls } = deps();
    const { id } = await addGithubTokenCore(d, { label: "a", repositories: "a/*", token: TOKEN });
    await deleteGithubTokenCore(d, id);
    expect(calls).toEqual([`PUT GITHUB_TOKEN_${id}`, `DELETE GITHUB_TOKEN_${id}`]);
    expect(secrets.size).toBe(0);
    expect(await githubTokenCount(env.DB)).toBe(0);
    await expect(deleteGithubTokenCore(d, id)).rejects.toThrow(/no such token/);
  });

  it("only forgets the record when sandbox builds are off (the secret went with the Worker)", async () => {
    const { deps: d } = deps();
    const { id } = await addGithubTokenCore(d, { label: "a", repositories: "a/*", token: TOKEN });
    const off = deps({ sandbox: async () => ({ connected: false, info: null }) });
    await deleteGithubTokenCore(off.deps, id);
    expect(off.calls).toEqual([]);
    expect(await githubTokenCount(env.DB)).toBe(0);
  });
});
