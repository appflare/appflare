import { readFileSync } from "node:fs";
import { SERVICE_NAMES } from "@appflare/schema/catalog-display";
import { describe, expect, it } from "vitest";
import { llmsIndex } from "../lib/llms.ts";
import { SITE_URL } from "../lib/shared.ts";
import { accountNeeds, appLinks, appPageTitle, appStats, shortDate } from "./app-page.ts";
import { findApp, findCategory, siteCatalog } from "./data.ts";
import { catalogPageEntries } from "./pages.ts";
import { fixtureUrl } from "./plugin.ts";
import { siteCatalog as deriveSiteCatalog, type SiteApp } from "./site-catalog.ts";
import { parseCatalogSnapshot } from "./snapshot.ts";
import { appsInCategory, searchApps, storefrontRows } from "./storefront.ts";
import { catalogMediaUrl, catalogPagePaths } from "./urls.ts";

const snapshot = parseCatalogSnapshot(
  JSON.parse(readFileSync(fixtureUrl, "utf8")),
  "the checked-in fixture",
);

function app(overrides: Partial<SiteApp> & { slug: string }): SiteApp {
  return {
    name: overrides.slug,
    pitch: "An app",
    summary: "An app.",
    version: "1.0.0",
    plan: "free",
    tier: "artifact",
    requires: [],
    services: [],
    accessIfProtected: false,
    lastVerified: null,
    addedAt: "2026-01-01T00:00:00Z",
    authors: [],
    maintainers: [],
    categories: [],
    license: { expression: "MIT", note: null },
    icon: null,
    cover: null,
    screenshots: [],
    repo: `acme/${overrides.slug}`,
    homepage: `https://github.com/acme/${overrides.slug}`,
    popularity: null,
    ...overrides,
  };
}

describe("the catalog pages", () => {
  it("give every app in the snapshot a page", () => {
    const paths = catalogPagePaths(siteCatalog);
    expect(paths).toContain("/apps/");
    for (const { slug } of snapshot.index.apps) {
      expect(paths).toContain(`/apps/${slug}/`);
      expect(findApp(slug)).toBeDefined();
    }
  });

  it("give every category the apps list a page", () => {
    const paths = catalogPagePaths(siteCatalog);
    const listed = new Set(snapshot.index.apps.flatMap((a) => a.categories));
    expect(listed.size).toBeGreaterThan(0);
    for (const id of listed) {
      expect(paths).toContain(`/categories/${id}/`);
      expect(findCategory(id)?.count).toBe(appsInCategory(siteCatalog.apps, id).length);
    }
    expect(siteCatalog.categories).toHaveLength(listed.size);
  });

  it("are listed in llms.txt, with the categories", () => {
    const index = llmsIndex();
    expect(index).toContain(`## Apps\n\n- [Apps](${SITE_URL}/apps/)`);
    for (const entry of catalogPageEntries(siteCatalog).appPages) {
      expect(index).toContain(`](${SITE_URL}${entry.url}): ${entry.description}`);
    }
    for (const { id } of siteCatalog.categories) {
      expect(index).toContain(`](${SITE_URL}/categories/${id}/)`);
    }
  });

  it("title an app page with its name and tagline", () => {
    expect(appPageTitle({ name: "Cut", pitch: "Short links" }, "Appflare")).toBe(
      "Cut: Short links | Appflare",
    );
  });
});

describe("siteCatalog", () => {
  it("shows stars only while the stats were fresh when the snapshot was taken", () => {
    const fresh = deriveSiteCatalog(snapshot);
    expect(fresh.apps.some((a) => a.popularity?.stars != null)).toBe(true);
    const stale = deriveSiteCatalog({
      ...snapshot,
      takenAt: new Date(Date.parse(snapshot.takenAt) + 73 * 3_600_000).toISOString(),
    });
    expect(stale.apps.every((a) => a.popularity === null)).toBe(true);
  });

  it("keeps no release addresses, and the authors the index lists", () => {
    const [first] = snapshot.index.apps;
    if (first === undefined) throw new Error("empty fixture");
    const derived = deriveSiteCatalog({
      ...snapshot,
      index: { ...snapshot.index, apps: [first] },
    });
    const [only] = derived.apps;
    expect(only?.authors).toEqual(first.authors);
    expect(JSON.stringify(derived)).not.toContain("releases/download");
  });
});

describe("media", () => {
  it("keeps an image only when the catalog's own site hosts it", () => {
    const [first] = snapshot.index.apps;
    if (first === undefined) throw new Error("empty fixture");
    const elsewhere = { url: "https://evil.example/cover.png", sha256: "a".repeat(64) };
    const derived = deriveSiteCatalog({
      ...snapshot,
      index: {
        ...snapshot.index,
        apps: [
          {
            ...first,
            media: {
              icon: {
                url: "https://appflare.github.io/catalog/apps/x/icon.png",
                sha256: "b".repeat(64),
              },
              cover: elsewhere,
              screenshots: [
                { ...elsewhere, alt: "Elsewhere" },
                {
                  url: "https://appflare.github.io.evil.example/s.png",
                  sha256: "c".repeat(64),
                  alt: "Lookalike",
                },
                {
                  url: "https://appflare.github.io/catalog/apps/x/1.png",
                  sha256: "d".repeat(64),
                  alt: "Here",
                },
              ],
            },
          },
        ],
        featured: [
          {
            id: "promo",
            title: "Promo",
            text: "A sponsored item.",
            sponsor: { name: "Acme" },
            link: { url: "https://acme.example", label: "Visit" },
            image: { ...elsewhere, alt: "Promo" },
          },
        ],
      },
    });
    const [only] = derived.apps;
    expect(only?.icon).toBe("https://appflare.github.io/catalog/apps/x/icon.png");
    expect(only?.cover).toBeNull();
    expect(only?.screenshots.map((s) => s.alt)).toEqual(["Here"]);
    expect(derived.featured?.image).toBeNull();
    expect(catalogMediaUrl("not a url")).toBeNull();
  });
});

describe("storefrontRows", () => {
  const now = new Date("2026-09-28T12:00:00Z");

  it("puts new apps first, then the most popular, then the biggest categories", () => {
    const apps = [
      app({ slug: "a", addedAt: "2026-09-27T00:00:00Z", categories: ["email"] }),
      app({ slug: "b", addedAt: "2026-01-01T00:00:00Z", categories: ["email"] }),
      app({
        slug: "c",
        categories: ["notes"],
        popularity: { stars: 50, installs30d: null, activeInstalls: null, installsKnown: false },
      }),
    ];
    const categories = [
      { id: "email", label: "Email", count: 2 },
      { id: "notes", label: "Notes", count: 1 },
    ];
    const rows = storefrontRows(apps, categories, now);
    expect(rows.map((r) => r.id)).toEqual(["new", "popular", "category-email"]);
    expect(rows[0]?.apps.map((a) => a.slug)).toEqual(["a"]);
    expect(rows[1]?.caption).toBe("Most starred on GitHub");
    expect(rows[2]?.seeAll).toBe("/categories/email/");
  });

  it("shows no new row when no app joined the catalog this week", () => {
    const apps = [
      app({ slug: "old", addedAt: "2026-09-01T00:00:00Z" }),
      app({ slug: "older", addedAt: "2026-08-01T00:00:00Z" }),
    ];
    expect(storefrontRows(apps, [], now).map((r) => r.id)).not.toContain("new");
  });
});

describe("searchApps", () => {
  const apps = [
    app({ slug: "cafe", name: "Café Menu", services: ["d1"] }),
    app({ slug: "inbox", name: "Inbox", categories: ["email"], authors: [{ name: "Ada" }] }),
  ];

  it("finds apps by every word, without accents, by category, author and service", () => {
    expect(searchApps(apps, "cafe").map((a) => a.slug)).toEqual(["cafe"]);
    expect(searchApps(apps, "email ada").map((a) => a.slug)).toEqual(["inbox"]);
    expect(searchApps(apps, "D1 database").map((a) => a.slug)).toEqual(["cafe"]);
    expect(searchApps(apps, "email cafe")).toEqual([]);
    expect(searchApps(apps, "  ").map((a) => a.slug)).toEqual(["cafe", "inbox"]);
  });
});

describe("an app page", () => {
  it("says an app needs what it requires and uses what was worked out", () => {
    const needs = accountNeeds(
      app({ slug: "x", plan: "paid", requires: ["r2", "something-new"], services: ["kv", "r2"] }),
    );
    expect(needs.items).toEqual([
      { key: "plan", name: "Workers Paid plan", words: "This app needs it" },
      { key: "kv", name: "KV storage", words: "This app uses it" },
      { key: "r2", name: "R2 storage", words: "This app needs it" },
      { key: "something-new", name: "Something new", words: null },
    ]);
    expect(needs.note).toBeNull();
  });

  it("says Cloudflare Access is needed only if protected when the entry does not require it", () => {
    const access = { slug: "x", requires: ["access"], services: ["access"] };
    expect(accountNeeds(app({ ...access, accessIfProtected: true })).items).toEqual([
      { key: "access", name: SERVICE_NAMES.access, words: "Only if you protect it" },
    ]);
    expect(accountNeeds(app(access)).items).toEqual([
      { key: "access", name: SERVICE_NAMES.access, words: "This app needs it" },
    ]);
  });

  it("lists a requirement that is not a service by its own name", () => {
    const needs = accountNeeds(app({ slug: "x", requires: ["something-new"] }));
    expect(needs.items).toEqual([{ key: "something-new", name: "Something new", words: null }]);
    expect(needs.note).toBeNull();
    expect(accountNeeds(app({ slug: "x", tier: "self-deploying" })).note).toMatch(/installer/);
  });

  it("leaves out a star count of zero", () => {
    const popularity = { stars: 0, installs30d: null, activeInstalls: null, installsKnown: false };
    const ids = appStats(app({ slug: "x", popularity }), new Date()).map((s) => s.id);
    expect(ids).not.toContain("stars");
  });

  it("shows stars and installs only when known, and a date build by its day", () => {
    const now = new Date("2026-09-28T00:00:00Z");
    const stats = appStats(
      app({
        slug: "x",
        version: "0.0.0-20260921.4fd08b5",
        license: { expression: "NONE", note: null },
        lastVerified: "2025-12-30T10:00:00Z",
        popularity: { stars: 1234, installs30d: null, activeInstalls: null, installsKnown: true },
      }),
      now,
    );
    expect(stats.map((s) => [s.id, s.value])).toEqual([
      ["stars", "1.2k"],
      ["installs", "Under 10"],
      ["plan", "Free"],
      ["license", "No license"],
      ["version", "Sep 21"],
      ["tested", "Dec 30, 2025"],
    ]);
    expect(stats.find((s) => s.id === "license")?.tone).toBe("warning");
    expect(appStats(app({ slug: "y" }), now).map((s) => s.id)).toEqual([
      "plan",
      "license",
      "version",
      "tested",
    ]);
    expect(shortDate("2026-01-02T23:00:00Z", now)).toBe("Jan 2");
  });

  it("links the source code, and the website unless it is the repository", () => {
    expect(appLinks({ repo: "acme/cut", homepage: "https://github.com/acme/cut/" })).toHaveLength(
      1,
    );
    expect(appLinks({ repo: "acme/cut", homepage: "https://www.cut.example/" })[1]).toEqual({
      kind: "website",
      label: "Website",
      href: "https://www.cut.example/",
      detail: "cut.example",
    });
  });
});
