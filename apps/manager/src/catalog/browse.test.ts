import { describe, expect, it } from "vitest";
import {
  type BrowsableApp,
  browseApps,
  categoriesOf,
  categoryLabel,
  isFiltered,
  matchesFilters,
  matchesSearch,
  sortApps,
} from "./browse";

function app(overrides: Partial<BrowsableApp> & { slug: string }): BrowsableApp {
  return {
    name: overrides.slug,
    summary: "An app.",
    tier: "artifact",
    plan: "free",
    lastVerified: null,
    authors: [],
    categories: [],
    primitives: { ids: [] },
    instances: [],
    popularity: null,
    ...overrides,
  };
}

const cut = app({
  slug: "cut",
  name: "Cut",
  summary: "Self-hosted link shortener on Workers + KV.",
  authors: [{ name: "Mendy Landa" }],
  categories: ["utilities"],
  primitives: { ids: ["kv"] },
  lastVerified: "2026-09-20T00:00:00.000Z",
  popularity: { stars: 17, installs30d: null, activeInstalls: null, installsKnown: true },
});
const flaremo = app({
  slug: "flaremo",
  name: "FlareMo",
  summary: "A Memos-compatible notes app.",
  authors: [{ name: "realchendahuang" }],
  categories: ["productivity", "notes"],
  primitives: { ids: ["d1", "r2", "queues", "vectorize"] },
  lastVerified: "2026-09-24T00:00:00.000Z",
  instances: [{}],
  popularity: { stars: 282, installs30d: null, activeInstalls: null, installsKnown: true },
});
const openSeo = app({
  slug: "open-seo",
  name: "OpenSEO",
  summary: "Self-hosted SEO research, behind Cloudflare Access.",
  authors: [{ name: "Ben Senescu" }, { name: "Every App" }],
  tier: "self-deploying",
  plan: "paid",
  categories: ["marketing"],
  primitives: { ids: ["kv", "d1", "r2", "containers", "access"] },
  popularity: { stars: 20000, installs30d: null, activeInstalls: null, installsKnown: true },
});
const cafe = app({ slug: "cafe", name: "Café Menu", summary: "Menus.", authors: undefined });
const APPS = [cut, flaremo, openSeo, cafe];

const slugs = (list: readonly BrowsableApp[]) => list.map((a) => a.slug);

describe("matchesSearch", () => {
  it("matches name, summary, author, primitive and category words, ignoring case", () => {
    expect(matchesSearch(cut, "cut")).toBe(true);
    expect(matchesSearch(cut, "SHORTENER")).toBe(true);
    expect(matchesSearch(cut, "mendy")).toBe(true);
    expect(matchesSearch(flaremo, "vectorize")).toBe(true);
    expect(matchesSearch(flaremo, "notes")).toBe(true);
    expect(matchesSearch(openSeo, "every app")).toBe(true);
    expect(matchesSearch(openSeo, "cloudflare access")).toBe(true);
  });

  it("finds a primitive by its label or id", () => {
    expect(slugs(APPS.filter((a) => matchesSearch(a, "d1")))).toEqual(["flaremo", "open-seo"]);
    expect(slugs(APPS.filter((a) => matchesSearch(a, "durable")))).toEqual([]);
    expect(slugs(APPS.filter((a) => matchesSearch(a, "containers")))).toEqual(["open-seo"]);
  });

  it("needs every word to match somewhere, and ignores accents", () => {
    expect(matchesSearch(cut, "kv link")).toBe(true);
    expect(matchesSearch(cut, "kv notes")).toBe(false);
    expect(matchesSearch(cafe, "cafe")).toBe(true);
    expect(matchesSearch(cafe, "  ")).toBe(true);
    expect(matchesSearch(cafe, undefined)).toBe(true);
  });
});

describe("matchesFilters", () => {
  it("filters on installed, plan, tier and category", () => {
    expect(slugs(APPS.filter((a) => matchesFilters(a, { installed: "yes" })))).toEqual(["flaremo"]);
    expect(slugs(APPS.filter((a) => matchesFilters(a, { installed: "no" })))).toEqual([
      "cut",
      "open-seo",
      "cafe",
    ]);
    expect(slugs(APPS.filter((a) => matchesFilters(a, { plan: "paid" })))).toEqual(["open-seo"]);
    expect(slugs(APPS.filter((a) => matchesFilters(a, { tier: "artifact" })))).toEqual([
      "cut",
      "flaremo",
      "cafe",
    ]);
    expect(slugs(APPS.filter((a) => matchesFilters(a, { category: "notes" })))).toEqual([
      "flaremo",
    ]);
    expect(APPS.every((a) => matchesFilters(a, {}))).toBe(true);
  });

  it("filters on the kind of license, leaving out apps whose license is not known yet", () => {
    const licensed = [
      app({ slug: "mit", appLicense: { expression: "MIT", note: null } }),
      app({ slug: "busl", appLicense: { expression: "BUSL-1.1", note: null } }),
      app({ slug: "noted", appLicense: { expression: "MIT", note: "Commons Clause applies." } }),
      app({ slug: "none", appLicense: { expression: "NONE", note: null } }),
      app({ slug: "free-text", appLicense: { expression: "MIT License", note: null } }),
      app({ slug: "custom", appLicense: { expression: "SEE LICENSE IN LICENSE", note: null } }),
      app({ slug: "unknown", appLicense: null }),
      app({ slug: "older" }),
    ];
    const kind = (license: "open-source" | "source-available" | "none") =>
      slugs(licensed.filter((a) => matchesFilters(a, { license })));
    expect(kind("open-source")).toEqual(["mit"]);
    expect(kind("source-available")).toEqual(["busl", "noted"]);
    expect(kind("none")).toEqual(["none"]);
    expect(licensed.every((a) => matchesFilters(a, {}))).toBe(true);
    expect(isFiltered({ license: "none" })).toBe(true);
  });
});

describe("sortApps and browseApps", () => {
  it("sorts by popularity when there are numbers, else keeps the index order", () => {
    expect(slugs(sortApps(APPS, "popular", true))).toEqual(["open-seo", "flaremo", "cut", "cafe"]);
    expect(slugs(sortApps(APPS, "popular", false))).toEqual(slugs(APPS));
  });

  it("sorts by name and by the most recent install check (never checked last)", () => {
    expect(slugs(sortApps(APPS, "name", false))).toEqual(["cafe", "cut", "flaremo", "open-seo"]);
    expect(slugs(sortApps(APPS, "checked", false))).toEqual(["flaremo", "cut", "open-seo", "cafe"]);
  });

  it("searches, filters and sorts together without changing the input", () => {
    const input = [...APPS];
    expect(slugs(browseApps(input, { q: "self-hosted", sort: "name" }, true))).toEqual([
      "cut",
      "open-seo",
    ]);
    expect(slugs(browseApps(input, { q: "r2", installed: "no" }, true))).toEqual(["open-seo"]);
    expect(slugs(input)).toEqual(slugs(APPS));
  });

  it("knows when a search or filter is set (the sort does not count)", () => {
    expect(isFiltered({ sort: "name" })).toBe(false);
    expect(isFiltered({ q: "  " })).toBe(false);
    expect(isFiltered({ q: "kv" })).toBe(true);
    expect(isFiltered({ category: "notes" })).toBe(true);
  });
});

describe("categories", () => {
  it("lists each category once, by label", () => {
    expect(categoriesOf(APPS)).toEqual(["marketing", "notes", "productivity", "utilities"]);
    expect(categoriesOf([{ categories: ["ai", "bots"] }, { categories: ["ai"] }])).toEqual([
      "ai",
      "bots",
    ]);
  });

  it("labels slugs in sentence case, keeping acronyms", () => {
    expect(categoryLabel("ai")).toBe("AI");
    expect(categoryLabel("email")).toBe("Email");
    expect(categoryLabel("link-shortener")).toBe("Link shortener");
    expect(categoryLabel("dns-tools")).toBe("DNS tools");
  });
});
