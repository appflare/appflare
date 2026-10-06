import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeGithub, GITHUB_TOKEN, githubRelease, RELEASES_URL } from "../test/fake-releases";
import { RELEASE_BODY_MAX_CHARS } from "../whats-new/release-notes";
import { readReleaseNotes } from "../whats-new/release-notes.server";
import {
  isManagerUpdateAvailable,
  MANAGER_FEED_LIMITED_KEY,
  MANAGER_LATEST_KEY,
  MANAGER_RELEASES_FRESH_KEY,
  MANAGER_RELEASES_KEY,
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
        githubRelease("9.0.0", { tag: "create-appflare@9.0.0" }),
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

describe("refreshManagerReleases without a token", () => {
  const LATEST_PAGE = "https://github.com/appflare/appflare/releases/latest";
  const LIST = `${RELEASES_URL}?per_page=100`;
  const DOWNLOAD = "https://github.com/appflare/appflare/releases/download";
  const at = (iso: string) => () => new Date(iso);

  /**
   * GitHub as a public appflare/appflare looks to a request without a token:
   * github.com redirects to the latest release; the API answers the list with
   * an ETag (304 when it matches), or whatever `list` returns instead.
   */
  function publicGithub(state: {
    latest: string | null;
    releases: unknown[];
    list?: () => Response | null;
  }) {
    const seen: Array<{ url: string; ifNoneMatch: string | null; auth: boolean }> = [];
    const etag = () => `W/"${state.releases.length}"`;
    const fetch = async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: input,
        ifNoneMatch: headers.get("if-none-match"),
        auth: headers.has("authorization"),
      });
      if (input === LATEST_PAGE) {
        if (init?.redirect !== "manual") return new Response("followed", { status: 599 });
        return state.latest === null
          ? new Response("Not Found", { status: 404 })
          : new Response(null, {
              status: 302,
              headers: {
                location: `https://github.com/appflare/appflare/releases/tag/${state.latest}`,
              },
            });
      }
      if (input === LIST) {
        const instead = state.list?.() ?? null;
        if (instead !== null) return instead;
        if (headers.get("if-none-match") === etag()) return new Response(null, { status: 304 });
        return Response.json(state.releases, { headers: { etag: etag() } });
      }
      return new Response(null, { status: 599 });
    };
    const urls = () => seen.map((s) => s.url);
    return { fetch, seen, urls };
  }

  it("finds the newest release on github.com and reads the API list only once a day", async () => {
    const gh = publicGithub({
      latest: "manager@0.2.0",
      releases: [
        { ...githubRelease("0.2.0"), body: "Two." },
        githubRelease("0.1.0"),
        githubRelease("0.1.0", { tag: "sandbox@0.1.0" }),
      ],
    });
    const env0 = { KV: env.KV, APPFLARE_VERSION: "0.1.0" };
    const first = await refreshManagerReleases(env0, {
      fetch: gh.fetch,
      now: at("2026-10-06T12:00:00Z"),
    });
    expect(first).toEqual({
      version: "0.2.0",
      tag: "manager@0.2.0",
      assets: {
        zip: `${DOWNLOAD}/manager%400.2.0/appflare-0.2.0.zip`,
        manifest: `${DOWNLOAD}/manager%400.2.0/manifest.json`,
        sig: `${DOWNLOAD}/manager%400.2.0/manifest.sig`,
      },
      publishedAt: "2026-09-20T10:00:00Z",
      checkedAt: "2026-10-06T12:00:00.000Z",
    });
    expect(gh.urls()).toEqual([LATEST_PAGE, LIST]);
    expect(gh.seen.every((s) => !s.auth)).toBe(true);
    expect((await readReleaseNotes(env.KV)).map((n) => n.version)).toEqual(["0.2.0", "0.1.0"]);
    // Only manager releases are cached, with the list's ETag.
    const cached = await env.KV.getWithMetadata(MANAGER_RELEASES_KEY);
    expect(JSON.parse(cached.value ?? "[]")).toHaveLength(2);
    expect(cached.metadata).toMatchObject({ etag: 'W/"3"' });

    // Half an hour later: the redirect alone.
    const second = await refreshManagerReleases(env0, {
      fetch: gh.fetch,
      now: at("2026-10-06T12:30:00Z"),
    });
    expect(second).toEqual({ ...first, checkedAt: "2026-10-06T12:30:00.000Z" });
    expect(gh.urls()).toEqual([LATEST_PAGE, LIST, LATEST_PAGE]);

    // Once the day's freshness mark expires: the list again, conditionally.
    await env.KV.delete(MANAGER_RELEASES_FRESH_KEY);
    await refreshManagerReleases(env0, { fetch: gh.fetch, now: at("2026-10-07T12:30:00Z") });
    expect(gh.seen.at(-1)).toEqual({ url: LIST, ifNoneMatch: 'W/"3"', auth: false });
  });

  it("reads the list again for a release it lacks, and trusts the redirect while the list lags", async () => {
    const state = { latest: "manager@0.1.0", releases: [githubRelease("0.1.0")] as unknown[] };
    const gh = publicGithub(state);
    const env0 = { KV: env.KV, APPFLARE_VERSION: "0.1.0" };
    await refreshManagerReleases(env0, { fetch: gh.fetch });
    state.latest = "manager@0.2.0";
    const release = await refreshManagerReleases(env0, { fetch: gh.fetch });
    // GitHub's list lags behind a new release: 304, still without 0.2.0.
    expect(gh.seen.at(-1)).toEqual({ url: LIST, ifNoneMatch: 'W/"1"', auth: false });
    expect(release).toMatchObject({
      version: "0.2.0",
      publishedAt: null,
      assets: { manifest: `${DOWNLOAD}/manager%400.2.0/manifest.json` },
    });
    expect((await readReleaseNotes(env.KV)).map((n) => n.version)).toEqual(["0.1.0"]);
  });

  it("remembers a rate-limit refusal until GitHub's reset, and still finds the release", async () => {
    const reset = Date.parse("2026-10-06T12:20:00Z") / 1000;
    let refuse = true;
    const gh = publicGithub({
      latest: "manager@0.2.0",
      releases: [githubRelease("0.2.0")],
      list: () =>
        refuse
          ? new Response('{"message":"API rate limit exceeded"}', {
              status: 403,
              headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
            })
          : null,
    });
    const env0 = { KV: env.KV, APPFLARE_VERSION: "0.1.0" };
    const release = await refreshManagerReleases(env0, {
      fetch: gh.fetch,
      now: at("2026-10-06T12:00:00Z"),
    });
    expect(release?.version).toBe("0.2.0");
    expect(await readManagerLatest(env.KV)).toEqual(release);
    expect(JSON.parse((await env.KV.get(MANAGER_FEED_LIMITED_KEY)) ?? "null")).toEqual({
      until: reset * 1000,
      authenticated: false,
    });
    // Before the reset the API is not asked at all.
    refuse = false;
    await refreshManagerReleases(env0, { fetch: gh.fetch, now: at("2026-10-06T12:10:00Z") });
    expect(gh.urls()).toEqual([LATEST_PAGE, LIST, LATEST_PAGE]);
    // After it, the list is read and the notes arrive.
    await refreshManagerReleases(env0, { fetch: gh.fetch, now: at("2026-10-06T12:30:00Z") });
    expect(gh.urls()).toEqual([LATEST_PAGE, LIST, LATEST_PAGE, LATEST_PAGE, LIST]);
    expect((await readReleaseNotes(env.KV)).map((n) => n.version)).toEqual(["0.2.0"]);
  });

  it("says when GitHub will be asked again when nothing else answers", async () => {
    const gh = publicGithub({
      latest: null,
      releases: [],
      list: () => new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    });
    const env0 = { KV: env.KV, APPFLARE_VERSION: "0.1.0" };
    const run = (iso: string) =>
      refreshManagerReleases(env0, { fetch: gh.fetch, now: at(iso) }).catch((e: unknown) => e);
    const error = await run("2026-10-06T12:00:00Z");
    expect(error).toBeInstanceOf(ManagerReleasesError);
    expect((error as Error).message).toMatch(
      /^GitHub is limiting requests .* asks again after 12:02 UTC \(in about 2 minutes\)\.$/,
    );
    const again = await run("2026-10-06T12:01:00Z");
    expect((again as Error).message).toMatch(/after 12:02 UTC \(in about 1 minute\)\.$/);
    expect(gh.urls()).toEqual([LATEST_PAGE, LIST, LATEST_PAGE]);
  });

  it("with a token reads the list every time, with its ETag, and ignores a refusal made without one", async () => {
    await env.KV.put(
      MANAGER_FEED_LIMITED_KEY,
      JSON.stringify({ until: Date.parse("2026-10-06T13:00:00Z"), authenticated: false }),
    );
    const seen: Array<string | null> = [];
    const fetch = async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (input !== `${RELEASES_URL}?per_page=100`) return new Response(null, { status: 599 });
      if (headers.get("authorization") !== `Bearer ${GITHUB_TOKEN}`) {
        return new Response(null, { status: 404 });
      }
      seen.push(headers.get("if-none-match"));
      if (headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304 });
      return Response.json([githubRelease("0.2.0")], { headers: { etag: '"v1"' } });
    };
    const env0 = { KV: env.KV, APPFLARE_VERSION: "0.1.0", GITHUB_TOKEN };
    const now = at("2026-10-06T12:00:00Z");
    const first = await refreshManagerReleases(env0, { fetch, now });
    const second = await refreshManagerReleases(env0, { fetch, now });
    expect(seen).toEqual([null, '"v1"']);
    expect(second).toEqual(first);
    expect(second?.assets.zip).toBe(
      "https://api.github.com/repos/appflare/appflare/releases/assets/1",
    );
  });

  it("uses the list when the redirect points at a release that is not Appflare's", async () => {
    const gh = publicGithub({
      latest: "sandbox@0.9.0",
      releases: [githubRelease("0.2.0"), githubRelease("0.9.0", { tag: "sandbox@0.9.0" })],
    });
    const release = await refreshManagerReleases(
      { KV: env.KV, APPFLARE_VERSION: "0.1.0" },
      { fetch: gh.fetch },
    );
    expect(release).toMatchObject({ version: "0.2.0", tag: "manager@0.2.0" });
    expect(gh.urls()).toEqual([LATEST_PAGE, LIST]);
  });

  it("never offers a release the redirect no longer points at, even while the cached list has it", async () => {
    const state = {
      latest: "manager@0.3.0",
      releases: [
        { ...githubRelease("0.3.0"), body: "Three." },
        { ...githubRelease("0.2.0"), body: "Two.", published_at: "2026-09-10T10:00:00Z" },
      ] as unknown[],
    };
    const gh = publicGithub(state);
    const env0 = { KV: env.KV, APPFLARE_VERSION: "0.1.0" };
    expect((await refreshManagerReleases(env0, { fetch: gh.fetch }))?.version).toBe("0.3.0");
    // 0.3.0 is pulled (made a pre-release, or deleted): latest points back at
    // 0.2.0, and the cached list, still fresh, is not read again.
    state.latest = "manager@0.2.0";
    const release = await refreshManagerReleases(env0, { fetch: gh.fetch });
    expect(gh.urls()).toEqual([LATEST_PAGE, LIST, LATEST_PAGE]);
    expect(release).toMatchObject({ version: "0.2.0", publishedAt: "2026-09-10T10:00:00Z" });
    expect(await readManagerLatest(env.KV)).toEqual(release);
    expect((await readReleaseNotes(env.KV)).map((n) => n.version)).toEqual(["0.2.0"]);
  });

  it("names the token when GitHub limits requests made with it", async () => {
    const fetch = async () =>
      new Response('{"message":"API rate limit exceeded for user ID 1."}', {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Date.parse("2026-10-06T12:40:00Z") / 1000),
        },
      });
    const error = await refreshManagerReleases(
      { KV: env.KV, APPFLARE_VERSION: "0.1.0", GITHUB_TOKEN },
      { fetch, now: at("2026-10-06T12:00:00Z") },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManagerReleasesError);
    expect((error as Error).message).toBe(
      "GitHub is limiting requests made with Appflare's GitHub token right now. Appflare asks again after 12:40 UTC (in about 40 minutes).",
    );
    expect(JSON.parse((await env.KV.get(MANAGER_FEED_LIMITED_KEY)) ?? "null")).toEqual({
      until: Date.parse("2026-10-06T12:40:00Z"),
      authenticated: true,
    });
  });

  it("takes a secondary-limit 403 for a rate limit by its message", async () => {
    const gh = publicGithub({
      latest: null,
      releases: [],
      list: () =>
        new Response('{"message":"You have exceeded a secondary rate limit."}', { status: 403 }),
    });
    const error = await refreshManagerReleases(
      { KV: env.KV, APPFLARE_VERSION: "0.1.0" },
      { fetch: gh.fetch, now: at("2026-10-06T12:00:00Z") },
    ).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/asks again after 12:01 UTC/);
  });

  it("rewrites the cached list only when its releases change, not its ETag", async () => {
    const puts: string[] = [];
    const kv = new Proxy(env.KV, {
      get(target, prop) {
        if (prop === "put") {
          return (key: string, ...rest: unknown[]) => {
            puts.push(key);
            return (target.put as (...a: unknown[]) => Promise<void>)(key, ...rest);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let etag = 0;
    const long = `- abc1234: ${"x".repeat(RELEASE_BODY_MAX_CHARS + 500)}`;
    const fetch = async () => {
      etag += 1; // GitHub's ETag moves with every asset download count.
      return Response.json(
        [{ ...githubRelease("0.2.0"), body: long, assets: [], download_count: etag }],
        { headers: { etag: `"${etag}"` } },
      );
    };
    const env0 = { KV: kv, APPFLARE_VERSION: "0.1.0", GITHUB_TOKEN };
    await refreshManagerReleases(env0, { fetch });
    await refreshManagerReleases(env0, { fetch });
    expect(puts.filter((key) => key === MANAGER_RELEASES_KEY)).toHaveLength(1);
    const cached = JSON.parse((await env.KV.get(MANAGER_RELEASES_KEY)) ?? "[]");
    expect(cached[0].body.length).toBeLessThanOrEqual(RELEASE_BODY_MAX_CHARS + 3);
    expect(cached[0].body.endsWith("\n\n…")).toBe(true);
    const [note] = await readReleaseNotes(env.KV);
    expect(note?.body).toBe(cached[0].body);
  });
});
