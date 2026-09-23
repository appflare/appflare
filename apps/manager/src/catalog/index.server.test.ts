import type { FetchLike } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import {
  CATALOG_INDEX_KEY,
  CATALOG_UPDATED_AT_KEY,
  catalogIndexUrl,
  DEFAULT_CATALOG_INDEX_URL,
  getCatalogApp,
  getCatalogIndex,
  refreshCatalogIndex,
} from "./index.server";

/** In-memory KV with a write counter (the free plan allows 1,000 writes a day). */
function fakeKv() {
  const store = new Map<string, string>();
  let writes = 0;
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      writes += 1;
      store.set(key, value);
    },
  };
  return { kv: kv as unknown as KVNamespace, store, writes: () => writes };
}

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

  it("finds one app by slug", async () => {
    const { kv } = fakeKv();
    const api = serving(INDEX);
    expect(await getCatalogApp({ KV: kv }, "cut", { fetch: api.fetch })).toMatchObject({
      ok: true,
      app: { slug: "cut" },
    });
    expect(await getCatalogApp({ KV: kv }, "nope", { fetch: api.fetch })).toEqual({
      ok: true,
      app: null,
    });
  });
});
