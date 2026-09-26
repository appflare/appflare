import type { FetchLike } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { fakeKv } from "../test/fake-kv";
import {
  CATALOG_INDEX_KEY,
  CATALOG_UPDATED_AT_KEY,
  catalogIndexUrl,
  DEFAULT_CATALOG_INDEX_URL,
  getCatalogIndex,
  parseCatalogIndex,
  readCachedCatalogIndex,
  refreshCatalogIndex,
} from "./index.server";
import { CATALOG_STATS_KEY, readCatalogStats } from "./stats.server";

const INDEX = {
  generatedAt: "2026-09-22T18:20:44.584Z",
  apps: [
    {
      slug: "cut",
      name: "Cut",
      summary: "Self-hosted link shortener on Workers + KV.",
      version: "0.0.0-20260826.6056400",
      artifacts: {
        zip: "https://github.com/appflare/catalog/releases/download/cut@0.0.0-20260826.6056400/cut-0.0.0-20260826.6056400.zip",
        manifest:
          "https://github.com/appflare/catalog/releases/download/cut@0.0.0-20260826.6056400/manifest.json",
        sig: "https://github.com/appflare/catalog/releases/download/cut@0.0.0-20260826.6056400/manifest.sig",
      },
      digest: "a".repeat(64),
      tier: "artifact",
      plan: "free",
      requires: [],
      lastVerified: null,
      maintainers: ["MendyLanda"],
    },
  ],
};

function serving(body: unknown, status = 200): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    },
  };
}

const NOW = () => new Date("2026-09-22T20:00:00.000Z");

describe("catalog index cache", () => {
  it("uses CATALOG_INDEX_URL when set, else the production default", () => {
    expect(catalogIndexUrl({})).toBe(DEFAULT_CATALOG_INDEX_URL);
    expect(catalogIndexUrl({ CATALOG_INDEX_URL: " http://127.0.0.1:8788/index.json " })).toBe(
      "http://127.0.0.1:8788/index.json",
    );
  });

  it("refresh fetches, validates, and stores the index and the refresh time", async () => {
    const { kv, store } = fakeKv();
    const api = serving(INDEX);
    const snapshot = await refreshCatalogIndex(
      { KV: kv, CATALOG_INDEX_URL: "https://catalog.test/index.json" },
      { fetch: api.fetch, now: NOW },
    );
    expect(api.urls).toEqual(["https://catalog.test/index.json"]);
    expect(snapshot.index.apps[0]?.slug).toBe("cut");
    expect(JSON.parse(store.get(CATALOG_INDEX_KEY) ?? "null")).toEqual(INDEX);
    expect(store.get(CATALOG_UPDATED_AT_KEY)).toBe("2026-09-22T20:00:00.000Z");
  });

  it("does not rewrite an unchanged index (one KV write per refresh)", async () => {
    const { kv, writes } = fakeKv();
    const api = serving(INDEX);
    await refreshCatalogIndex({ KV: kv }, { fetch: api.fetch, now: NOW });
    expect(writes()).toBe(2);
    await refreshCatalogIndex({ KV: kv }, { fetch: api.fetch, now: NOW });
    expect(writes()).toBe(3);
  });

  it("rejects an invalid index and a failing catalog without touching KV", async () => {
    const { kv, writes } = fakeKv();
    await expect(
      refreshCatalogIndex({ KV: kv }, { fetch: serving({ apps: "nope" }).fetch }),
    ).rejects.toThrow(/invalid index.json/);
    await expect(
      refreshCatalogIndex({ KV: kv }, { fetch: serving("", 503).fetch }),
    ).rejects.toThrow(/answered HTTP 503/);
    expect(writes()).toBe(0);
  });

  it("reads from KV, refreshing once on a miss", async () => {
    const { kv } = fakeKv();
    const api = serving(INDEX);
    const first = await getCatalogIndex({ KV: kv }, { fetch: api.fetch, now: NOW });
    const second = await getCatalogIndex({ KV: kv }, { fetch: api.fetch, now: NOW });
    expect(first.ok && second.ok).toBe(true);
    expect(api.urls).toHaveLength(1);
    if (second.ok) expect(second.updatedAt).toBe("2026-09-22T20:00:00.000Z");
  });

  it("reports the error when nothing is cached and the refresh fails", async () => {
    const { kv } = fakeKv();
    const read = await getCatalogIndex(
      { KV: kv },
      {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      },
    );
    expect(read).toEqual({
      ok: false,
      error: `Could not reach the catalog at ${DEFAULT_CATALOG_INDEX_URL}: fetch failed`,
      updatedAt: null,
    });
  });
});

describe("parseCatalogIndex", () => {
  it("keeps the entries this manager can read and leaves out the rest", () => {
    const { artifacts: _a, digest: _d, ...entry } = INDEX.apps[0] ?? { artifacts: 0, digest: 0 };
    const sandbox = {
      ...entry,
      slug: "built",
      tier: "sandbox",
      build: {
        pin: "b".repeat(40),
        manifest: "https://appflare.github.io/catalog/apps/built/appflare.json",
        manifestDigest: "c".repeat(64),
      },
    };
    const future = { ...INDEX.apps[0], slug: "future", tier: "hologram" };
    const parsed = parseCatalogIndex({ ...INDEX, apps: [INDEX.apps[0], sandbox, future] });
    expect(parsed?.index.apps.map((a) => a.slug)).toEqual(["cut", "built"]);
    expect(parsed?.index.apps[1]?.build?.pin).toBe("b".repeat(40));
    expect(parsed?.unreadable.map((u) => u.slug)).toEqual(["future"]);
    expect(parsed?.unreadable[0]?.problem).toMatch(/tier/);
    expect(parseCatalogIndex({ apps: [] })).toBeNull();
  });

  it("caches every entry as published and counts the unreadable ones on each read", async () => {
    const { kv } = fakeKv();
    const future = { ...INDEX.apps[0], slug: "future", tier: "hologram" };
    const api = serving({ ...INDEX, apps: [INDEX.apps[0], future] });
    const refreshed = await refreshCatalogIndex({ KV: kv }, { fetch: api.fetch, now: NOW });
    expect(refreshed.unreadable).toBe(1);
    const read = await getCatalogIndex({ KV: kv }, { fetch: api.fetch, now: NOW });
    expect(read.ok && read.unreadable).toBe(1);
    expect(read.ok && read.index.apps.map((a) => a.slug)).toEqual(["cut"]);
    expect(api.urls).toHaveLength(1);
  });

  it("reads featured items one by one and keeps the stats URL", () => {
    const item = {
      id: "acme",
      title: "Acme",
      text: "Deploy faster.",
      sponsor: { name: "Acme" },
      link: { url: "https://acme.example", label: "Learn more" },
    };
    const parsed = parseCatalogIndex({
      ...INDEX,
      featured: [
        item,
        { ...item, id: "Not An Id" },
        { ...item, id: "promotes-unknown", slug: "nope" },
        { ...item, id: "promotes-cut", slug: "cut" },
        item,
      ],
      stats: "https://catalog.test/stats.json",
    });
    expect(parsed?.index.featured.map((f) => f.id)).toEqual(["acme", "promotes-cut"]);
    expect(parsed?.index.stats).toBe("https://catalog.test/stats.json");
    expect(parsed?.raw.featured).toHaveLength(5);
    const bare = parseCatalogIndex({ ...INDEX, stats: "javascript:alert(1)" });
    expect(bare?.index.featured).toEqual([]);
    expect(bare?.index.stats).toBeUndefined();
  });

  it("gives cached readers (usage data, jobs) the apps of an index with featured items and media", async () => {
    const { kv, store } = fakeKv();
    const [cut] = INDEX.apps;
    const media = {
      icon: { url: "https://appflare.github.io/catalog/apps/cut/icon.svg", sha256: "b".repeat(64) },
      screenshots: [],
    };
    store.set(
      CATALOG_INDEX_KEY,
      JSON.stringify({
        ...INDEX,
        apps: [{ ...cut, media }],
        featured: [
          {
            id: "acme",
            title: "Acme",
            text: "Hi.",
            sponsor: { name: "Acme" },
            link: { url: "https://acme.example", label: "Go" },
          },
        ],
        stats: "https://appflare.github.io/catalog/stats.json",
      }),
    );
    const index = await readCachedCatalogIndex(kv);
    expect(index?.apps.map((a) => [a.slug, a.version])).toEqual([["cut", cut?.version]]);
    expect(index?.featured).toHaveLength(1);
  });
});

/** A catalog site that answers with ETags and honours `If-None-Match`. */
function site(files: Record<string, { body: unknown; etag: string }>) {
  const requests: Array<{ url: string; ifNoneMatch: string | null }> = [];
  const fetch: FetchLike = async (url, init) => {
    const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
    requests.push({ url, ifNoneMatch });
    const file = files[url];
    if (file === undefined) return new Response("not found", { status: 404 });
    if (ifNoneMatch === file.etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(file.body), { headers: { etag: file.etag } });
  };
  return { fetch, requests, files };
}

const STATS_URL = "https://catalog.test/stats.json";
const INDEX_URL = "https://catalog.test/index.json";
const STATS = {
  generatedAt: "2026-09-22T19:23:00.000Z",
  apps: { cut: { stars: { count: 42, fetchedAt: "2026-09-22T19:23:00.000Z" }, installs: null } },
  sources: {
    github: { ok: true, at: "2026-09-22T19:23:00.000Z" },
    telemetry: { ok: false, at: null },
  },
};

describe("conditional refresh", () => {
  const env = (kv: KVNamespace) => ({ KV: kv, CATALOG_INDEX_URL: INDEX_URL });

  it("sends the cached ETag and keeps the cached index on a 304", async () => {
    const { kv, writes } = fakeKv();
    const s = site({ [INDEX_URL]: { body: INDEX, etag: '"v1"' } });
    await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    expect(writes()).toBe(2);
    const again = await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    expect(s.requests.map((r) => r.ifNoneMatch)).toEqual([null, '"v1"']);
    expect(again.index.apps[0]?.slug).toBe("cut");
    // Only the refresh time is written on a 304.
    expect(writes()).toBe(3);
  });

  it("never rewrites the same content; a redeploy's new ETag is stored once", async () => {
    const { kv, writes, meta } = fakeKv();
    const s = site({ [INDEX_URL]: { body: INDEX, etag: '"v1"' } });
    await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    const first = meta.get(CATALOG_INDEX_KEY) as { sha256?: string };
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The same bytes redeployed: new ETag, same sha256, so one write keeps
    // the next refreshes conditional.
    s.files[INDEX_URL] = { body: INDEX, etag: '"v2"' };
    await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    expect(writes()).toBe(4);
    expect(meta.get(CATALOG_INDEX_KEY)).toMatchObject({ etag: '"v2"', sha256: first.sha256 });
    // A server that sends no ETag and the same content: nothing but the refresh time.
    const bare = fakeKv();
    const plain = serving(INDEX);
    await refreshCatalogIndex(env(bare.kv), { fetch: plain.fetch, now: NOW });
    await refreshCatalogIndex(env(bare.kv), { fetch: plain.fetch, now: NOW });
    expect(bare.writes()).toBe(3);
  });

  it("adds the digest once to a copy an older manager cached, then leaves it alone", async () => {
    const { kv, writes, store } = fakeKv();
    store.set(CATALOG_INDEX_KEY, JSON.stringify(INDEX));
    await refreshCatalogIndex(env(kv), { fetch: serving(INDEX).fetch, now: NOW });
    expect(writes()).toBe(2);
    await refreshCatalogIndex(env(kv), { fetch: serving(INDEX).fetch, now: NOW });
    expect(writes()).toBe(3);
  });

  it("never sends an ETag cached for another URL", async () => {
    const { kv } = fakeKv();
    const s = site({
      [INDEX_URL]: { body: INDEX, etag: '"v1"' },
      "https://other.test/index.json": { body: INDEX, etag: '"v1"' },
    });
    await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    await refreshCatalogIndex(
      { KV: kv, CATALOG_INDEX_URL: "https://other.test/index.json" },
      { fetch: s.fetch, now: NOW },
    );
    expect(s.requests.map((r) => r.ifNoneMatch)).toEqual([null, null]);
  });

  it("fetches the stats the index names, conditionally, and caches them only when they change", async () => {
    const { kv, writes, store } = fakeKv();
    const s = site({
      [INDEX_URL]: { body: { ...INDEX, stats: STATS_URL }, etag: '"i1"' },
      [STATS_URL]: { body: STATS, etag: '"s1"' },
    });
    await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    expect((await readCatalogStats(kv))?.apps.cut?.stars?.count).toBe(42);
    expect(writes()).toBe(3);
    await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    expect(s.requests.filter((r) => r.url === STATS_URL).map((r) => r.ifNoneMatch)).toEqual([
      null,
      '"s1"',
    ]);
    expect(writes()).toBe(4);
    s.files[STATS_URL] = {
      body: { ...STATS, generatedAt: "2026-09-22T20:23:00.000Z" },
      etag: '"s2"',
    };
    await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    expect(JSON.parse(store.get(CATALOG_STATS_KEY) ?? "{}").generatedAt).toBe(
      "2026-09-22T20:23:00.000Z",
    );
  });

  it("keeps the last stats and the index when the stats fetch fails or is invalid", async () => {
    const { kv } = fakeKv();
    const s = site({
      [INDEX_URL]: { body: { ...INDEX, stats: STATS_URL }, etag: '"i1"' },
      [STATS_URL]: { body: STATS, etag: '"s1"' },
    });
    await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    s.files[STATS_URL] = { body: { apps: "nope" }, etag: '"s2"' };
    const snapshot = await refreshCatalogIndex(env(kv), { fetch: s.fetch, now: NOW });
    expect(snapshot.index.apps).toHaveLength(1);
    expect((await readCatalogStats(kv))?.generatedAt).toBe(STATS.generatedAt);
  });
});
