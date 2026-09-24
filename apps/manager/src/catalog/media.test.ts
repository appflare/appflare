import type { FetchLike } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { fakeKv } from "../test/fake-kv";
import { CATALOG_INDEX_KEY } from "./index.server";
import {
  appMediaView,
  findCatalogMedia,
  MAX_MEDIA_BYTES,
  mediaAllowed,
  mediaContentType,
  mediaSrc,
} from "./media";
import { catalogMediaRoute, readLimited, serveCatalogMedia } from "./media.server";

const INDEX_URL = "https://appflare.github.io/catalog/index.json";
const SITE = "https://appflare.github.io/catalog";
const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function index(media: unknown, featured: unknown[] = []) {
  return {
    generatedAt: "2026-09-24T12:00:00.000Z",
    apps: [
      {
        slug: "cut",
        name: "Cut",
        summary: "Links.",
        version: "1.0.0",
        artifacts: {
          zip: "https://github.com/appflare/catalog/releases/download/cut@1.0.0/cut-1.0.0.zip",
          manifest: "https://github.com/appflare/catalog/releases/download/cut@1.0.0/manifest.json",
          sig: "https://github.com/appflare/catalog/releases/download/cut@1.0.0/manifest.sig",
        },
        digest: "a".repeat(64),
        tier: "artifact",
        plan: "free",
        requires: [],
        lastVerified: null,
        maintainers: ["MendyLanda"],
        media,
      },
    ],
    featured,
  };
}

describe("catalog media rules", () => {
  it("allows only images on the index's own origin", () => {
    expect(mediaAllowed(`${SITE}/apps/cut/icon.svg`, INDEX_URL)).toBe(true);
    expect(mediaAllowed("https://tracker.example/pixel.png", INDEX_URL)).toBe(false);
    expect(mediaAllowed("https://appflare.github.io.evil.example/x.png", INDEX_URL)).toBe(false);
    expect(mediaAllowed(`${SITE}/apps/cut/page.html`, INDEX_URL)).toBe(false);
    expect(mediaAllowed("not a url", INDEX_URL)).toBe(false);
  });

  it("maps extensions to content types", () => {
    expect(mediaContentType(`${SITE}/a.PNG`)).toBe("image/png");
    expect(mediaContentType(`${SITE}/a.svg?x=1`)).toBe("image/svg+xml");
    expect(mediaContentType(`${SITE}/a.gif`)).toBeNull();
  });

  it("gives the UI manager paths and drops foreign images", () => {
    const sha = "b".repeat(64);
    expect(mediaSrc({ url: `${SITE}/apps/cut/icon.png`, sha256: sha }, INDEX_URL)).toBe(
      `/api/catalog/media/${sha}`,
    );
    const view = appMediaView(
      {
        icon: { url: "https://elsewhere.example/icon.png", sha256: sha },
        cover: { url: `${SITE}/apps/cut/cover.png`, sha256: sha },
        screenshots: [
          { url: `${SITE}/apps/cut/screenshots/01-links.png`, sha256: sha, alt: "Links" },
          { url: "https://elsewhere.example/s.png", sha256: sha, alt: "Elsewhere" },
        ],
      },
      INDEX_URL,
    );
    expect(view.icon).toBeNull();
    expect(view.cover).toBe(`/api/catalog/media/${sha}`);
    expect(view.screenshots).toEqual([{ src: `/api/catalog/media/${sha}`, alt: "Links" }]);
    expect(appMediaView(undefined, INDEX_URL)).toEqual({
      icon: null,
      cover: null,
      screenshots: [],
    });
  });

  it("finds featured images too", () => {
    const sha = "c".repeat(64);
    const parsed = {
      ...index(undefined),
      apps: [],
      featured: [
        {
          id: "acme",
          title: "Acme",
          text: "Hi.",
          sponsor: { name: "Acme" },
          image: { url: `${SITE}/featured/acme.png`, sha256: sha, alt: "Acme" },
          link: { url: "https://acme.example", label: "Go" },
        },
      ],
    };
    expect(findCatalogMedia(parsed, sha, INDEX_URL)?.url).toBe(`${SITE}/featured/acme.png`);
    expect(findCatalogMedia(parsed, "d".repeat(64), INDEX_URL)).toBeNull();
  });
});

describe("serveCatalogMedia", () => {
  async function setup(bytes: Uint8Array<ArrayBuffer>, listed: string) {
    const { kv, store } = fakeKv();
    store.set(
      CATALOG_INDEX_KEY,
      JSON.stringify(index({ icon: { url: `${SITE}/apps/cut/icon.png`, sha256: listed } })),
    );
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return new Response(bytes);
    };
    return { env: { KV: kv }, fetch, urls };
  }

  it("serves a listed image whose bytes match its digest", async () => {
    const digest = await sha256(PNG);
    const { env, fetch, urls } = await setup(PNG, digest);
    const response = await serveCatalogMedia(env, digest, { fetch });
    expect(response.status).toBe(200);
    expect(urls).toEqual([`${SITE}/apps/cut/icon.png`]);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("refuses bytes that do not match, and digests the index does not list", async () => {
    const digest = await sha256(PNG);
    const tampered = await setup(new Uint8Array([1, 2, 3]), digest);
    expect((await serveCatalogMedia(tampered.env, digest, { fetch: tampered.fetch })).status).toBe(
      502,
    );
    const { env, fetch, urls } = await setup(PNG, digest);
    expect((await serveCatalogMedia(env, "e".repeat(64), { fetch })).status).toBe(404);
    expect((await serveCatalogMedia(env, "../etc", { fetch })).status).toBe(404);
    expect(urls).toEqual([]);
  });

  it("answers 401 without a session and never fetches", async () => {
    const digest = await sha256(PNG);
    const { env, fetch, urls } = await setup(PNG, digest);
    const refused = await catalogMediaRoute(env, digest, async () => false, { fetch });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("cache-control")).toBe("no-store");
    expect(urls).toEqual([]);
    const served = await catalogMediaRoute(env, digest, async () => true, { fetch });
    expect(served.status).toBe(200);
  });

  it("stops reading a body without a length once it passes the limit", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    expect(await readLimited(endless, MAX_MEDIA_BYTES)).toBeNull();
    expect(pulled).toBeLessThanOrEqual(7);
    const small = new Response(PNG).body;
    expect(await readLimited(small, MAX_MEDIA_BYTES)).toEqual(PNG);
    expect(await readLimited(null, MAX_MEDIA_BYTES)).toEqual(new Uint8Array(0));
  });

  it("refuses an oversized image streamed without a content-length", async () => {
    const digest = await sha256(PNG);
    const { env } = await setup(PNG, digest);
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    const response = await serveCatalogMedia(env, digest, {
      fetch: async () => new Response(big),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toMatch(/larger than Appflare serves/);
  });

  it("serves nothing for an image on another origin", async () => {
    const { kv, store } = fakeKv();
    const digest = await sha256(PNG);
    store.set(
      CATALOG_INDEX_KEY,
      JSON.stringify(index({ icon: { url: "https://tracker.example/icon.png", sha256: digest } })),
    );
    const response = await serveCatalogMedia({ KV: kv }, digest, {
      fetch: async () => new Response(PNG),
    });
    expect(response.status).toBe(404);
  });
});
