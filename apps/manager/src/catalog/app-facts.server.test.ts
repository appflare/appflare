import type { FetchLike } from "@appflare/cf-api";
import type { IndexApp } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { baseCatalog } from "../test/artifact-fixture";
import { fakeKv } from "../test/fake-kv";
import {
  LIST_MANIFEST_FETCHES,
  listAppFacts,
  MANIFEST_FAILURE_TTL_SECONDS,
  manifestFailureKey,
} from "./app-facts.server";
import { catalogManifestCacheKey, manifestCacheKey } from "./app-manifest.server";

function artifactApp(slug: string): IndexApp {
  const base = `https://releases.test/${slug}`;
  return {
    slug,
    name: slug,
    summary: "An app.",
    version: "1.0.0",
    artifacts: {
      zip: `${base}/app.zip`,
      manifest: `${base}/manifest.json`,
      sig: `${base}/manifest.sig`,
    },
    digest: slug
      .padEnd(64, "0")
      .slice(0, 64)
      .replace(/[^0-9a-f]/g, "a"),
    tier: "artifact",
    plan: "free",
    requires: ["r2"],
    lastVerified: null,
    maintainers: ["someone"],
  };
}

/** A fetch that answers 404 for everything and records which apps it was asked about. */
function failingFetch() {
  const urls: string[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    signals.push(init?.signal);
    return new Response("missing", { status: 404 });
  };
  const slugs = () => [...new Set(urls.map((u) => new URL(u).pathname.split("/")[1]))];
  return { fetch, urls, signals, slugs };
}

describe("listAppFacts", () => {
  it("answers without waiting on GitHub and defers at most 4 manifest fetches", async () => {
    const { kv } = fakeKv();
    const apps = ["a", "b", "c", "d", "e", "f"].map(artifactApp);
    const urls: string[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    // GitHub never answers: the list must still come back.
    const hanging: FetchLike = (url, init) => {
      urls.push(url);
      signals.push(init?.signal);
      return new Promise<Response>(() => {});
    };
    const deferred: Promise<unknown>[] = [];
    const facts = await listAppFacts({ KV: kv }, apps, (p) => deferred.push(p), {
      fetch: hanging,
    });
    expect(facts.get("a")).toEqual({
      primitives: { ids: ["r2"], complete: false, keyValueDurableObjects: false },
      categories: [],
    });
    expect(deferred).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const slugs = [...new Set(urls.map((u) => new URL(u).pathname.split("/")[1]))];
    expect(slugs).toHaveLength(LIST_MANIFEST_FETCHES);
    expect(slugs).toEqual(["a", "b", "c", "d"]);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("remembers failures for an hour, so the next view tries the others", async () => {
    const { kv, store } = fakeKv();
    const puts: Array<{ key: string; ttl: number | undefined }> = [];
    const recording = {
      ...kv,
      get: kv.get.bind(kv),
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        puts.push({ key, ttl: options?.expirationTtl });
        return kv.put(key, value, options);
      },
    } as unknown as KVNamespace;
    const apps = ["a", "b", "c", "d", "e", "f"].map(artifactApp);
    const first = failingFetch();
    const firstRun: Promise<unknown>[] = [];
    await listAppFacts({ KV: recording }, apps, (p) => firstRun.push(p), { fetch: first.fetch });
    await Promise.all(firstRun);
    expect(puts).toEqual(
      ["a", "b", "c", "d"].map((slug) => ({
        key: manifestFailureKey({ slug, version: "1.0.0" }),
        ttl: MANIFEST_FAILURE_TTL_SECONDS,
      })),
    );
    expect(store.has(manifestFailureKey({ slug: "a", version: "1.0.0" }))).toBe(true);

    const second = failingFetch();
    const secondRun: Promise<unknown>[] = [];
    await listAppFacts({ KV: recording }, apps, (p) => secondRun.push(p), { fetch: second.fetch });
    await Promise.all(secondRun);
    expect(second.slugs()).toEqual(["e", "f"]);

    const third: Promise<unknown>[] = [];
    await listAppFacts({ KV: recording }, apps, (p) => third.push(p), { fetch: second.fetch });
    expect(third).toEqual([]);
  });

  it("reads a cached manifest without fetching it", async () => {
    const { kv, store } = fakeKv();
    const catalog = baseCatalog({
      categories: ["notes"],
      requires: ["zone"],
      install: { ...baseCatalog().install, tier: "sandbox" },
    });
    const digest = "b".repeat(64);
    store.set(catalogManifestCacheKey(digest), JSON.stringify(catalog));
    const { artifacts: _a, digest: _d, ...row } = artifactApp("cut");
    const app: IndexApp = {
      ...row,
      tier: "sandbox",
      build: {
        pin: catalog.source.sha,
        manifest: "https://site.test/cut.json",
        manifestDigest: digest,
      },
    };
    const upstream = failingFetch();
    const deferred: Promise<unknown>[] = [];
    const facts = await listAppFacts({ KV: kv }, [app], (p) => deferred.push(p), {
      fetch: upstream.fetch,
    });
    expect(facts.get("cut")).toEqual({
      primitives: { ids: ["r2", "zone"], complete: false, keyValueDurableObjects: false },
      categories: ["notes"],
    });
    expect(deferred).toEqual([]);
    expect(upstream.urls).toEqual([]);
  });

  it("answers rows that publish their services and categories with no KV read or fetch", async () => {
    const { kv } = fakeKv();
    const reads: string[] = [];
    const recording = {
      ...kv,
      get: async (key: string) => {
        reads.push(key);
        return kv.get(key);
      },
    } as unknown as KVNamespace;
    const published: IndexApp = {
      ...artifactApp("a"),
      services: ["kv", "cron"],
      categories: ["utilities"],
    };
    const older = artifactApp("b");
    const upstream = failingFetch();
    const deferred: Promise<unknown>[] = [];
    const facts = await listAppFacts(
      { KV: recording },
      [published, older],
      (p) => deferred.push(p),
      {
        fetch: upstream.fetch,
      },
    );
    expect(facts.get("a")).toEqual({
      primitives: { ids: ["kv", "cron"], complete: true, keyValueDurableObjects: false },
      categories: ["utilities"],
    });
    await Promise.all(deferred);
    // Only the older row's manifest is looked up, cached or fetched.
    const olderKeys = [
      manifestCacheKey(older.digest ?? ""),
      manifestFailureKey({ slug: "b", version: "1.0.0" }),
    ];
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((key) => olderKeys.includes(key))).toBe(true);
    expect(upstream.slugs()).toEqual(["b"]);
  });
});
