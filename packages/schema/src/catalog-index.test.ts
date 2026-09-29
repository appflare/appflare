import { describe, expect, it } from "vitest";
import {
  featuredItemSchema,
  INDEX_ONLY_CATALOG_FIELDS,
  indexAppArtifact,
  indexAppSchema,
  indexJsonSchema,
  isFeaturedItemActive,
} from "./catalog-index";
import { MAX_SCREENSHOTS } from "./media";

/** What every row carries, whatever its tier. */
const rowFacts = {
  addedAt: "2026-09-21T10:00:00Z",
  license: "MIT",
  revision: 1,
  services: ["kv"],
  authors: [{ name: "Mendy Landa", github: "MendyLanda" }],
  categories: ["utilities"],
};

const base = "https://github.com/appflare/catalog/releases/download/cut@0.1.0";

const validIndex = {
  generatedAt: "2026-09-22T12:00:00Z",
  apps: [
    {
      slug: "cut",
      name: "Cut",
      summary: "Self-hosted link shortener on Workers + KV.",
      tagline: "An app on Workers",
      version: "0.1.0",
      artifacts: {
        zip: `${base}/cut-0.1.0.zip`,
        manifest: `${base}/manifest.json`,
        sig: `${base}/manifest.sig`,
        digest: "c".repeat(64),
      },
      tier: "artifact",
      plan: "free",
      requires: [],
      lastVerified: null,
      maintainers: ["MendyLanda"],
      ...rowFacts,
    },
  ],
};

describe("indexJsonSchema", () => {
  it("accepts a valid index.json", () => {
    const parsed = indexJsonSchema.parse(validIndex);
    expect(parsed.apps[0]?.slug).toBe("cut");
    expect(parsed.apps[0]?.lastVerified).toBeNull();
  });

  it("rejects an index with a non-URL artifact and unknown tier", () => {
    const invalid = {
      ...validIndex,
      apps: [
        {
          ...validIndex.apps[0],
          tier: "docker",
          artifacts: { zip: "not a url", manifest: "x", sig: "y" },
        },
      ],
    };
    const result = indexJsonSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("requires the facts every catalog writes on every row", () => {
    const row = validIndex.apps[0] ?? {};
    for (const field of [...Object.keys(rowFacts), "tagline"]) {
      const { [field as keyof typeof row]: _, ...without } = row;
      expect(indexAppSchema.safeParse(without).success, field).toBe(false);
    }
  });

  it("names the catalog fields only the index shows", () => {
    expect(INDEX_ONLY_CATALOG_FIELDS).toEqual(["authors", "tagline", "licenseNote"]);
  });

  it("accepts rows with authors, at least one", () => {
    const row = validIndex.apps[0];
    const authors = [{ name: "Mendy Landa", github: "MendyLanda" }];
    expect(indexAppSchema.parse({ ...row, authors }).authors).toEqual(authors);
    expect(indexAppSchema.safeParse({ ...row, authors: [] }).success).toBe(false);
    expect(
      indexAppSchema.safeParse({ ...row, authors: [{ name: "A", url: "http://a.example" }] })
        .success,
    ).toBe(false);
  });

  it("accepts rows with services and categories as plain strings", () => {
    const row = validIndex.apps[0];
    const facts = {
      services: ["kv", "a-service-added-later"],
      keyValueDurableObjects: true,
      categories: ["utilities"],
    };
    expect(indexAppSchema.parse({ ...row, ...facts })).toMatchObject(facts);
    // A custom catalog may name a category this version does not know.
    expect(indexAppSchema.safeParse({ ...row, categories: ["gardening"] }).success).toBe(true);
    expect(indexAppSchema.safeParse({ ...row, categories: [] }).success).toBe(false);
    // At most three, as in the catalog manifest.
    const three = ["utilities", "developer-tools", "gardening"];
    expect(indexAppSchema.safeParse({ ...row, categories: three }).success).toBe(true);
    expect(indexAppSchema.safeParse({ ...row, categories: [...three, "media"] }).success).toBe(
      false,
    );
    expect(indexAppSchema.safeParse({ ...row, services: [""] }).success).toBe(false);
    expect(indexAppSchema.safeParse({ ...row, categories: "utilities" }).success).toBe(false);
  });

  it("holds the slug to lowercase letters, digits and dashes", () => {
    const row = validIndex.apps[0];
    expect(indexAppSchema.safeParse({ ...row, slug: "open-seo" }).success).toBe(true);
    for (const slug of ["", "My_App", "-cut", "a".repeat(64)]) {
      expect(indexAppSchema.safeParse({ ...row, slug }).success).toBe(false);
    }
  });

  it("accepts a revision and a revised catalog manifest on a release row", () => {
    const row = validIndex.apps[0];
    const catalogManifest = {
      url: "https://appflare.github.io/catalog/apps/cut/manifest.json",
      sha256: "d".repeat(64),
      keyId: "catalog-2026-09",
      signature: "c2lnbmF0dXJl",
    };
    expect(indexAppSchema.parse({ ...row, revision: 2, catalogManifest })).toMatchObject({
      revision: 2,
      catalogManifest,
    });
    // A revised manifest is never listed unsigned.
    const { signature: _s, ...unsigned } = catalogManifest;
    expect(indexAppSchema.safeParse({ ...row, catalogManifest: unsigned }).success).toBe(false);
    expect(indexAppSchema.parse(row).revision).toBe(1);
    expect(indexAppSchema.safeParse({ ...row, revision: 0 }).success).toBe(false);
    expect(indexAppSchema.safeParse({ ...row, revision: 1.5 }).success).toBe(false);
    expect(
      indexAppSchema.safeParse({
        ...row,
        catalogManifest: { ...catalogManifest, url: "http://appflare.github.io/x.json" },
      }).success,
    ).toBe(false);
    // Only a release has a signed catalog manifest to revise.
    const { artifacts: _a, ...noRelease } = row ?? {};
    expect(
      indexAppSchema.safeParse({
        ...noRelease,
        tier: "sandbox",
        build: {
          pin: "a".repeat(40),
          manifest: "https://appflare.github.io/catalog/apps/cut/manifest.json",
          manifestDigest: "e".repeat(64),
        },
        catalogManifest,
      }).success,
    ).toBe(false);
  });
});

describe("indexAppSchema for sandbox tier entries", () => {
  const [artifactApp] = validIndex.apps;
  if (artifactApp === undefined) throw new Error("the fixture index has no app");
  const sandboxApp = {
    slug: "flaremo",
    name: "FlareMo",
    summary: "Memos on Workers.",
    tagline: "An app on Workers",
    version: "0.20.1",
    tier: "sandbox",
    plan: "paid",
    requires: [],
    lastVerified: null,
    maintainers: ["someone"],
    ...rowFacts,
    build: {
      pin: "a".repeat(40),
      manifest: "https://appflare.github.io/catalog/apps/flaremo/appflare.json",
      manifestDigest: "d".repeat(64),
      buildCommand: "pnpm build",
      expectedMinutes: 12,
      instanceType: "standard-2",
    },
  };

  it("accepts a sandbox entry without artifacts or digest", () => {
    const parsed = indexAppSchema.parse(sandboxApp);
    expect(parsed.build?.expectedMinutes).toBe(12);
    expect(indexAppArtifact(parsed)).toBeNull();
  });

  it("keeps artifact tier entries unchanged", () => {
    const parsed = indexAppSchema.parse(artifactApp);
    expect(parsed).toEqual(artifactApp);
    expect(indexAppArtifact(parsed)?.digest).toBe("c".repeat(64));
  });

  it("refuses an artifact entry without artifacts, and a sandbox entry without build", () => {
    const { artifacts: _a, ...bare } = artifactApp;
    expect(indexAppSchema.safeParse(bare).success).toBe(false);
    const { build: _b, ...unbuilt } = sandboxApp;
    expect(indexAppSchema.safeParse(unbuilt).success).toBe(false);
  });

  it("refuses artifacts without a digest", () => {
    const { digest: _d, ...half } = artifactApp.artifacts;
    expect(indexAppSchema.safeParse({ ...artifactApp, artifacts: half }).success).toBe(false);
  });

  it("refuses a build with a short pin or an unknown instance type", () => {
    expect(
      indexAppSchema.safeParse({ ...sandboxApp, build: { ...sandboxApp.build, pin: "abc" } })
        .success,
    ).toBe(false);
    expect(
      indexAppSchema.safeParse({
        ...sandboxApp,
        build: { ...sandboxApp.build, instanceType: "basic" },
      }).success,
    ).toBe(false);
  });
});

describe("index media", () => {
  const [row] = validIndex.apps;
  if (row === undefined) throw new Error("the fixture index has no app");
  const site = "https://appflare.github.io/catalog/apps/cut";

  it("accepts an icon, a cover and screenshots, and defaults screenshots to none", () => {
    const media = {
      icon: { url: `${site}/icon.svg`, sha256: "a".repeat(64) },
      cover: { url: `${site}/cover.png`, sha256: "b".repeat(64) },
      screenshots: [
        { url: `${site}/screenshots/01-links.png`, sha256: "c".repeat(64), alt: "Links" },
      ],
    };
    expect(indexAppSchema.parse({ ...row, media }).media).toEqual(media);
    expect(indexAppSchema.parse({ ...row, media: {} }).media).toEqual({ screenshots: [] });
  });

  it("refuses http URLs, bad digests and screenshots without alt text", () => {
    const bad = [
      { icon: { url: "http://appflare.github.io/icon.png", sha256: "a".repeat(64) } },
      { cover: { url: `${site}/cover.png`, sha256: "short" } },
      { screenshots: [{ url: `${site}/s.png`, sha256: "a".repeat(64) }] },
    ];
    for (const media of bad) {
      expect(indexAppSchema.safeParse({ ...row, media }).success).toBe(false);
    }
  });

  it("takes at most the screenshots the media limits allow", () => {
    const shot = (i: number) => ({ url: `${site}/s${i}.png`, sha256: "a".repeat(64), alt: "S" });
    const screenshots = Array.from({ length: MAX_SCREENSHOTS + 1 }, (_, i) => shot(i));
    expect(indexAppSchema.safeParse({ ...row, media: { screenshots } }).success).toBe(false);
    expect(
      indexAppSchema.safeParse({ ...row, media: { screenshots: screenshots.slice(1) } }).success,
    ).toBe(true);
  });
});

describe("featured items and the stats URL", () => {
  const item = {
    id: "acme-2026-10",
    title: "Acme Edge",
    text: "Deploy faster.",
    sponsor: { name: "Acme", url: "https://acme.example" },
    link: { url: "https://acme.example/edge", label: "Learn more" },
  };
  const { link: _link, ...unlinked } = item;

  it("defaults featured to an empty array and accepts a stats URL", () => {
    const parsed = indexJsonSchema.parse({
      ...validIndex,
      stats: "https://appflare.github.io/catalog/stats.json",
    });
    expect(parsed.featured).toEqual([]);
    expect(parsed.stats).toBe("https://appflare.github.io/catalog/stats.json");
  });

  it("accepts an item with a link, or one promoting an app in the index", () => {
    expect(featuredItemSchema.parse(item).id).toBe("acme-2026-10");
    const featured = [{ ...unlinked, slug: "cut" }];
    expect(indexJsonSchema.safeParse({ ...validIndex, featured }).success).toBe(true);
  });

  it("refuses an item with neither link nor slug, a bad id or window, or an unknown slug", () => {
    expect(featuredItemSchema.safeParse(unlinked).success).toBe(false);
    expect(featuredItemSchema.safeParse({ ...item, id: "Acme" }).success).toBe(false);
    expect(
      featuredItemSchema.safeParse({
        ...item,
        startsAt: "2026-10-02T00:00:00Z",
        endsAt: "2026-10-01T00:00:00Z",
      }).success,
    ).toBe(false);
    const featured = [{ ...item, slug: "nope" }];
    expect(indexJsonSchema.safeParse({ ...validIndex, featured }).success).toBe(false);
  });

  it("refuses two items with the same id", () => {
    expect(indexJsonSchema.safeParse({ ...validIndex, featured: [item, item] }).success).toBe(
      false,
    );
  });

  it("knows when an item is inside its window", () => {
    const windowed = { startsAt: "2026-10-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" };
    expect(isFeaturedItemActive(windowed, new Date("2026-09-30T23:59:59Z"))).toBe(false);
    expect(isFeaturedItemActive(windowed, new Date("2026-10-15T00:00:00Z"))).toBe(true);
    expect(isFeaturedItemActive(windowed, new Date("2026-11-01T00:00:00Z"))).toBe(false);
    expect(isFeaturedItemActive({}, new Date())).toBe(true);
  });
});
