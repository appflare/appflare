import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { refreshManagerReleases } from "../catalog/manager-releases.server";
import { fakeKv } from "../test/fake-kv";
import { fakeGithub, GITHUB_TOKEN, githubRelease } from "../test/fake-releases";
import { pickReleaseNotes } from "./release-notes";
import { RELEASE_NOTES_KEY, readReleaseNotes, storeReleaseNotes } from "./release-notes.server";

beforeEach(async () => {
  await reset();
});

describe("storeReleaseNotes", () => {
  it("writes only when the notes changed", async () => {
    const { kv, writes } = fakeKv();
    const notes = pickReleaseNotes([{ ...githubRelease("0.4.0"), body: "- abc1234: One." }]);
    expect(await storeReleaseNotes(kv, notes)).toBe(true);
    expect(await storeReleaseNotes(kv, notes)).toBe(false);
    expect(writes()).toBe(1);
    expect(await readReleaseNotes(kv)).toEqual(notes);
    const edited = pickReleaseNotes([{ ...githubRelease("0.4.0"), body: "- abc1234: Two." }]);
    expect(await storeReleaseNotes(kv, edited)).toBe(true);
    expect(writes()).toBe(2);
  });

  it("reads nothing before the first check or from an unreadable entry", async () => {
    expect(await readReleaseNotes(env.KV)).toEqual([]);
    expect(await readReleaseNotes(undefined)).toEqual([]);
    await env.KV.put(RELEASE_NOTES_KEY, "not json");
    expect(await readReleaseNotes(env.KV)).toEqual([]);
    await env.KV.put(RELEASE_NOTES_KEY, JSON.stringify([{ tag: 1 }]));
    expect(await readReleaseNotes(env.KV)).toEqual([]);
  });
});

describe("the release check", () => {
  it("stores the notes from the same releases list, including releases without assets", async () => {
    const github = fakeGithub(null, [
      { ...githubRelease("0.4.0"), body: "### Minor Changes\n\n- e9aef76: Vectorize." },
      { ...githubRelease("0.4.1", { without: ["manifest.sig"] }), body: "Fixes." },
      githubRelease("0.1.2", { tag: "sandbox@0.1.2" }),
    ]);
    const release = await refreshManagerReleases(
      { KV: env.KV, APPFLARE_VERSION: "0.4.0", GITHUB_TOKEN },
      {
        fetch: async (input, init) =>
          github.serve(input, init) ?? new Response(null, { status: 599 }),
      },
    );
    // The update check still skips a release missing an asset.
    expect(release?.version).toBe("0.4.0");
    const notes = await readReleaseNotes(env.KV);
    expect(notes.map((n) => [n.version, n.body])).toEqual([
      ["0.4.1", "Fixes."],
      ["0.4.0", "### Minor Changes\n\n- Vectorize."],
    ]);
    expect(github.requests).toHaveLength(1);
  });

  it("still records the newest release when the notes cannot be stored", async () => {
    const { kv, store } = fakeKv();
    const failingKv = {
      get: async (key: string) => {
        if (key === RELEASE_NOTES_KEY) throw new Error("KV get failed");
        return kv.get(key);
      },
      put: (key: string, value: string) => kv.put(key, value),
    } as unknown as KVNamespace;
    const release = await refreshManagerReleases(
      { KV: failingKv, APPFLARE_VERSION: "0.4.0" },
      { fetch: async () => Response.json([githubRelease("0.5.0")]) },
    );
    expect(release?.version).toBe("0.5.0");
    expect(store.has("manager:latest")).toBe(true);
    expect(store.has(RELEASE_NOTES_KEY)).toBe(false);
  });
});
