import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchCatalogSnapshot, linksOf, mapLimit, narrowIndex } from "./fetch-snapshot.ts";

const BASE = "https://catalog.test/";
const AT = "2026-09-28T08:00:00.000Z";
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

/** A 1x1 PNG. */
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

/** A published catalog of two apps: one released, one with its own installer. */
function catalog() {
  const release = JSON.stringify({
    format: 1,
    catalog: { repo: "acme/cut", homepage: "https://cut.example" },
  });
  const installer = JSON.stringify({ repo: "acme/seo" });
  const icon = "<svg xmlns='http://www.w3.org/2000/svg'/>";
  const index = {
    generatedAt: AT,
    stats: `${BASE}stats.json`,
    featured: [],
    apps: [
      {
        slug: "cut",
        name: "Cut",
        summary: "Short links on your own domain.",
        tagline: "Short links on your own domain",
        addedAt: AT,
        version: "1.0.0",
        artifacts: {
          zip: `${BASE}cut.zip`,
          manifest: `${BASE}cut/manifest.json`,
          sig: `${BASE}cut/manifest.sig`,
          digest: sha(release),
        },
        tier: "artifact",
        plan: "free",
        requires: [],
        lastVerified: AT,
        authors: [{ name: "acme", github: "acme" }],
        maintainers: ["acme"],
        media: {
          icon: { url: `${BASE}cut/icon.svg`, sha256: sha(icon) },
          screenshots: [
            { url: `${BASE}cut/01.png`, sha256: sha(png), alt: "Links" },
            { url: `${BASE}cut/02.png`, sha256: sha(png), alt: "Stats" },
          ],
        },
        services: ["kv"],
        categories: ["utilities"],
        license: "MIT",
        revision: 1,
      },
      {
        slug: "seo",
        name: "SEO",
        summary: "Search research.",
        tagline: "Search research",
        addedAt: AT,
        version: "0.1.0",
        tier: "self-deploying",
        plan: "paid",
        requires: ["containers"],
        lastVerified: null,
        authors: [{ name: "acme", github: "acme" }],
        maintainers: ["acme"],
        build: { pin: "a".repeat(40), manifest: `${BASE}seo.json`, manifestDigest: sha(installer) },
        services: ["containers"],
        categories: ["marketing"],
        license: "MIT",
        revision: 1,
      },
    ],
  };
  const stats = {
    generatedAt: AT,
    apps: { cut: { stars: { count: 5, fetchedAt: AT }, installs: null } },
    sources: { github: { ok: true, at: AT }, telemetry: { ok: true, at: AT } },
  };
  return new Map<string, string | Uint8Array<ArrayBuffer>>([
    [`${BASE}index.json`, JSON.stringify(index)],
    [`${BASE}stats.json`, JSON.stringify(stats)],
    [`${BASE}cut/manifest.json`, release],
    [`${BASE}seo.json`, installer],
    [`${BASE}cut/icon.svg`, icon],
    [`${BASE}cut/01.png`, new Uint8Array(png)],
  ]);
}

/** A fetch over `files`; `failures` answers 503 that many times per URL first. */
function fakeFetch(
  files: Map<string, string | Uint8Array<ArrayBuffer>>,
  failures = new Map<string, number>(),
) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const left = failures.get(url) ?? 0;
    if (left > 0) {
      failures.set(url, left - 1);
      return new Response("busy", { status: 503 });
    }
    const body = files.get(url);
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

const options = { baseUrl: BASE, retryDelayMs: 0, now: () => new Date(AT) };

describe("fetchCatalogSnapshot", () => {
  it("takes the index, the stats, each app's links, and the icons and first screenshots for cards", async () => {
    const { fetch, calls } = fakeFetch(catalog());
    const { snapshot, ogIcons, ogScreenshots } = await fetchCatalogSnapshot({ ...options, fetch });
    expect(snapshot.takenAt).toBe(AT);
    expect(snapshot.index.apps.map((app) => app.slug)).toEqual(["cut", "seo"]);
    expect(snapshot.stats?.apps.cut?.stars?.count).toBe(5);
    expect(snapshot.links).toEqual({
      cut: { repo: "acme/cut", homepage: "https://cut.example" },
      // No homepage in the manifest: the repository is the homepage.
      seo: { repo: "acme/seo", homepage: "https://github.com/acme/seo" },
    });
    expect(ogIcons.cut).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(ogScreenshots).toEqual({
      cut: { src: `data:image/png;base64,${png.toString("base64")}`, width: 1, height: 1 },
    });
    // Only the first screenshot is drawn, so only it is fetched.
    expect(calls).not.toContain(`${BASE}cut/02.png`);
  });

  it("tries again after a failed request", async () => {
    const { fetch, calls } = fakeFetch(catalog(), new Map([[`${BASE}seo.json`, 2]]));
    await fetchCatalogSnapshot({ ...options, fetch });
    expect(calls.filter((url) => url === `${BASE}seo.json`)).toHaveLength(3);
  });

  it("fails when a file cannot be fetched, so the build fails", async () => {
    const { fetch } = fakeFetch(catalog(), new Map([[`${BASE}seo.json`, 3]]));
    await expect(fetchCatalogSnapshot({ ...options, fetch })).rejects.toThrow(
      /Could not fetch https:\/\/catalog\.test\/seo\.json after 3 tries: HTTP 503/,
    );
  });

  it("fails when a manifest does not match the digest the index gives", async () => {
    const files = catalog();
    files.set(`${BASE}seo.json`, JSON.stringify({ repo: "evil/seo" }));
    const { fetch, calls } = fakeFetch(files);
    await expect(fetchCatalogSnapshot({ ...options, fetch })).rejects.toThrow(/digest/);
    expect(calls.filter((url) => url === `${BASE}seo.json`)).toHaveLength(1);
  });

  it("fails on an index the schema refuses", async () => {
    const files = catalog();
    const index = JSON.parse(String(files.get(`${BASE}index.json`) ?? "{}"));
    index.apps[0].slug = "Cut";
    files.set(`${BASE}index.json`, JSON.stringify(index));
    const { fetch } = fakeFetch(files);
    await expect(fetchCatalogSnapshot({ ...options, fetch })).rejects.toThrow(
      /apps\.0\.slug: must be lowercase letters, digits and dashes/,
    );
  });

  it("keeps only the named apps when asked, for the checked-in fixture", async () => {
    const { fetch, calls } = fakeFetch(catalog());
    const { snapshot, ogIcons, ogScreenshots } = await fetchCatalogSnapshot({
      ...options,
      fetch,
      only: ["seo"],
      ogMedia: false,
    });
    expect(snapshot.index.apps.map((app) => app.slug)).toEqual(["seo"]);
    expect(Object.keys(snapshot.stats?.apps ?? {})).toEqual([]);
    expect(ogIcons).toEqual({});
    expect(ogScreenshots).toEqual({});
    expect(calls).not.toContain(`${BASE}cut/manifest.json`);
  });
});

describe("the helpers", () => {
  it("run work a few items at a time, keeping the order", async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, n));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(most).toBe(2);
  });

  it("read a manifest's links, refusing what is not a repository", () => {
    expect(linksOf({ repo: "acme/cut", homepage: "https://cut.example" })).toEqual({
      repo: "acme/cut",
      homepage: "https://cut.example",
    });
    expect(() => linksOf({ repo: "not a repo" })).toThrow(/owner\/repo/);
    expect(() => linksOf(undefined)).toThrow();
  });

  it("drop sponsored items for apps left out", () => {
    const index = {
      apps: [{ slug: "a" }, { slug: "b" }],
      featured: [{ id: "x", slug: "b" }, { id: "y" }, { id: "z", slug: "a" }],
    };
    expect(narrowIndex(index, ["a"])).toEqual({
      apps: [{ slug: "a" }],
      featured: [{ id: "y" }, { id: "z", slug: "a" }],
    });
  });
});
