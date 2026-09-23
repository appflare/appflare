import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeGithub, GITHUB_TOKEN, githubRelease, RELEASES_URL } from "../test/fake-releases";
import {
  isManagerUpdateAvailable,
  MANAGER_LATEST_KEY,
  ManagerReleasesError,
  managerUpdateView,
  pickLatestManagerRelease,
  readManagerLatest,
  refreshManagerReleases,
} from "./manager-releases.server";

beforeEach(async () => {
  await reset();
});

describe("pickLatestManagerRelease", () => {
  it("picks the newest published manager release by semver, not by list order", () => {
    const picked = pickLatestManagerRelease(
      [
        githubRelease("0.9.0"),
        githubRelease("0.10.0"),
        githubRelease("0.1.0"),
        githubRelease("0.10.0-rc.1"),
      ],
      { viaApi: false },
    );
    expect(picked).toEqual({
      version: "0.10.0",
      tag: "manager@0.10.0",
      assets: {
        zip: "https://github.com/appflare/appflare/releases/download/manager@0.10.0/appflare-0.10.0.zip",
        manifest:
          "https://github.com/appflare/appflare/releases/download/manager@0.10.0/manifest.json",
        sig: "https://github.com/appflare/appflare/releases/download/manager@0.10.0/manifest.sig",
      },
      publishedAt: "2026-09-20T10:00:00Z",
    });
  });

  it("skips drafts, pre-releases, other tags, and releases missing an asset", () => {
    const picked = pickLatestManagerRelease(
      [
        githubRelease("0.1.0"),
        githubRelease("0.5.0", { draft: true }),
        githubRelease("0.4.0", { prerelease: true }),
        githubRelease("9.0.0", { tag: "@appflare/cli@9.0.0" }),
        githubRelease("0.3.0", { tag: "manager@v0.3.0" }),
        githubRelease("0.2.0", { without: ["manifest.sig"] }),
        { tag_name: 42 },
        "junk",
      ],
      { viaApi: false },
    );
    expect(picked?.version).toBe("0.1.0");
    expect(pickLatestManagerRelease([], { viaApi: false })).toBeNull();
    expect(pickLatestManagerRelease({ not: "a list" }, { viaApi: false })).toBeNull();
  });

  it("addresses assets by their API URL when a token reads the feed", () => {
    const picked = pickLatestManagerRelease([githubRelease("0.1.0")], { viaApi: true });
    expect(picked?.assets).toEqual({
      zip: "https://api.github.com/repos/appflare/appflare/releases/assets/1",
      manifest: "https://api.github.com/repos/appflare/appflare/releases/assets/2",
      sig: "https://api.github.com/repos/appflare/appflare/releases/assets/3",
    });
  });
});

describe("isManagerUpdateAvailable", () => {
  it("compares by semver and treats a local build as older than every release", () => {
    expect(isManagerUpdateAvailable("0.1.0", "0.2.0")).toBe(true);
    expect(isManagerUpdateAvailable("0.2.0", "0.1.0")).toBe(false);
    expect(isManagerUpdateAvailable("0.1.0", "0.1.0")).toBe(false);
    expect(isManagerUpdateAvailable("0.9.0", "0.10.0")).toBe(true);
    expect(isManagerUpdateAvailable("0.0.0-dev", "0.0.1")).toBe(true);
    expect(isManagerUpdateAvailable("0.0.0-dev", "0.0.0-alpha")).toBe(true);
    expect(isManagerUpdateAvailable("0.1.0", null)).toBe(false);
  });

  it("builds the settings view from the stored release", () => {
    expect(managerUpdateView("0.1.0", null)).toEqual({
      current: "0.1.0",
      latest: null,
      updateAvailable: false,
      checkedAt: null,
    });
  });
});

describe("refreshManagerReleases", () => {
  const now = () => new Date("2026-09-23T12:00:00.000Z");

  it("reads a private feed with the token and stores the newest release in KV", async () => {
    const github = fakeGithub(null, [githubRelease("0.0.1"), githubRelease("0.1.0")]);
    const release = await refreshManagerReleases(
      { KV: env.KV, APPFLARE_VERSION: "0.0.1", GITHUB_TOKEN },
      {
        fetch: async (input, init) =>
          github.serve(input, init) ?? new Response(null, { status: 599 }),
        now,
      },
    );
    expect(release).toMatchObject({ version: "0.1.0", checkedAt: "2026-09-23T12:00:00.000Z" });
    expect(await readManagerLatest(env.KV)).toEqual(release);
    expect(github.requests).toEqual([{ url: RELEASES_URL, authorized: true }]);
  });

  it("explains a 404 without a token, and keeps what it stored before", async () => {
    await env.KV.put(MANAGER_LATEST_KEY, "not json");
    const github = fakeGithub(null, [githubRelease("0.1.0")]);
    const error = await refreshManagerReleases(
      { KV: env.KV, APPFLARE_VERSION: "0.0.1" },
      {
        fetch: async (input, init) =>
          github.serve(input, init) ?? new Response(null, { status: 599 }),
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManagerReleasesError);
    expect((error as Error).message).toMatch(/HTTP 404.*GITHUB_TOKEN/);
    expect(await env.KV.get(MANAGER_LATEST_KEY)).toBe("not json");
    expect(await readManagerLatest(env.KV)).toBeNull();
  });

  it("honors MANAGER_RELEASES_URL and never sends the token to another host", async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const release = await refreshManagerReleases(
      {
        KV: env.KV,
        APPFLARE_VERSION: "0.0.1",
        GITHUB_TOKEN,
        MANAGER_RELEASES_URL: "http://127.0.0.1:8766/releases",
      },
      {
        fetch: async (input, init) => {
          seen.push({ url: input, auth: new Headers(init?.headers).get("authorization") });
          return Response.json([githubRelease("0.2.0")]);
        },
      },
    );
    expect(seen).toEqual([{ url: "http://127.0.0.1:8766/releases?per_page=100", auth: null }]);
    expect(release?.version).toBe("0.2.0");
  });
});
