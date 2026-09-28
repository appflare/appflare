import { describe, expect, it } from "vitest";
import {
  type BrowsableApp,
  browseApps,
  browseNavigation,
  browseSearchSchema,
  canonicalCategory,
  categoryCounts,
  categoryLabel,
  compareNewest,
  isFiltered,
  MAX_QUERY_LENGTH,
  matchesFilters,
  matchesSearch,
  showsResults,
  sortApps,
} from "./browse";

function app(overrides: Partial<BrowsableApp> & { slug: string }): BrowsableApp {
  return {
    name: overrides.slug,
    summary: "An app.",
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
  tagline: "Short links on your own domain",
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
  plan: "paid",
  categories: ["marketing"],
  primitives: { ids: ["kv", "d1", "r2", "containers", "access"] },
  popularity: { stars: 20000, installs30d: null, activeInstalls: null, installsKnown: true },
});
const cafe = app({ slug: "cafe", name: "Café Menu", summary: "Menus.", authors: undefined });
const APPS = [cut, flaremo, openSeo, cafe];

const slugs = (list: readonly BrowsableApp[]) => list.map((a) => a.slug);

describe("matchesSearch", () => {
  it("matches name, pitch, summary, author, service and category words, ignoring case", () => {
    expect(matchesSearch(cut, "cut")).toBe(true);
    expect(matchesSearch(cut, "SHORTENER")).toBe(true);
    expect(matchesSearch(cut, "own domain")).toBe(true);
    expect(matchesSearch(cut, "mendy")).toBe(true);
    expect(matchesSearch(flaremo, "vectorize")).toBe(true);
    expect(matchesSearch(flaremo, "notes")).toBe(true);
    expect(matchesSearch(openSeo, "every app")).toBe(true);
    expect(matchesSearch(openSeo, "cloudflare access")).toBe(true);
  });

  it("finds a service by its label or id", () => {
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
  it("filters on installed, plan, category and catalog", () => {
    expect(slugs(APPS.filter((a) => matchesFilters(a, { installed: 1 })))).toEqual(["flaremo"]);
    expect(slugs(APPS.filter((a) => matchesFilters(a, { plan: "paid" })))).toEqual(["open-seo"]);
    expect(slugs(APPS.filter((a) => matchesFilters(a, { category: "notes" })))).toEqual([
      "flaremo",
    ]);
    const fromTeam = app({ slug: "team-app", source: { id: "team" } });
    expect(matchesFilters(fromTeam, { source: "team" })).toBe(true);
    expect(matchesFilters(cut, { source: "team" })).toBe(false);
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
  it("puts the most popular first, and keeps the index order without numbers", () => {
    expect(slugs(sortApps(APPS))).toEqual(["open-seo", "flaremo", "cut", "cafe"]);
    expect(slugs(sortApps(APPS, "popular"))).toEqual(["open-seo", "flaremo", "cut", "cafe"]);
    const unrated = APPS.map((a) => ({ ...a, popularity: null }));
    expect(slugs(sortApps(unrated))).toEqual(slugs(APPS));
  });

  it("puts the newest first: by the day added, then by the latest test", () => {
    expect(slugs(sortApps(APPS, "new"))).toEqual(["flaremo", "cut", "open-seo", "cafe"]);
    const added = [
      { ...cut, addedAt: "2026-09-01T00:00:00Z" },
      { ...cafe, addedAt: "2026-09-25T00:00:00Z" },
      flaremo,
    ];
    expect(slugs(sortApps(added, "new"))).toEqual(["cafe", "cut", "flaremo"]);
    expect(
      compareNewest({ addedAt: "not a date", lastVerified: null }, { lastVerified: null }),
    ).toBe(0);
  });

  it("searches, filters and orders together without changing the input", () => {
    const input = [...APPS];
    expect(slugs(browseApps(input, { q: "self-hosted" }))).toEqual(["open-seo", "cut"]);
    expect(slugs(browseApps(input, { q: "r2", plan: "paid" }))).toEqual(["open-seo"]);
    expect(slugs(browseApps(input, { sort: "new" }))).toEqual([
      "flaremo",
      "cut",
      "open-seo",
      "cafe",
    ]);
    expect(slugs(input)).toEqual(slugs(APPS));
  });

  it("shows results for a search, a filter or a See all order; only the first two filter", () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ q: "  " })).toBe(false);
    expect(isFiltered({ q: "kv" })).toBe(true);
    expect(isFiltered({ category: "notes" })).toBe(true);
    expect(isFiltered({ installed: 1 })).toBe(true);
    expect(isFiltered({ sort: "popular" })).toBe(false);
    expect(showsResults({ sort: "popular" })).toBe(true);
    expect(showsResults({ q: "  " })).toBe(false);
    expect(showsResults({})).toBe(false);
  });
});

describe("browseNavigation (history)", () => {
  it("replaces the history entry while typing, and adds one for every other change", () => {
    expect(browseNavigation({ q: "no" }, "typing")).toMatchObject({
      replace: true,
      resetScroll: false,
    });
    expect(browseNavigation({ category: "email" }, "choice").replace).toBe(false);
  });

  it("merges the change into the current query, removing what it sets to undefined", () => {
    const { search } = browseNavigation({ category: undefined, plan: "free" }, "choice");
    expect(search({ q: "mail", category: "email", sort: "popular" })).toEqual({
      q: "mail",
      category: undefined,
      plan: "free",
      sort: "popular",
    });
  });
});

describe("browseSearchSchema (deep links)", () => {
  it("reads a shared address", () => {
    expect(
      browseSearchSchema.parse({
        q: "notes",
        category: "email",
        plan: "free",
        license: "open-source",
        installed: 1,
        source: "team",
        sort: "popular",
      }),
    ).toEqual({
      q: "notes",
      category: "email",
      plan: "free",
      license: "open-source",
      installed: 1,
      source: "team",
      sort: "popular",
    });
  });

  it("reads installed=1 however the address spells it, including older links", () => {
    for (const installed of [1, "1", true, "true", "yes"]) {
      expect(browseSearchSchema.parse({ installed }).installed).toBe(1);
    }
    expect(browseSearchSchema.parse({ installed: "no" }).installed).toBeUndefined();
    expect(browseSearchSchema.parse({ installed: 0 }).installed).toBeUndefined();
  });

  it("cuts an over-long search instead of dropping it, so the field never empties", () => {
    const long = "x".repeat(MAX_QUERY_LENGTH + 1);
    expect(browseSearchSchema.parse({ q: long }).q).toBe("x".repeat(MAX_QUERY_LENGTH));
    expect(browseSearchSchema.parse({ q: "notes" }).q).toBe("notes");
  });

  it("drops values it does not know instead of failing, and keys it does not use", () => {
    expect(
      browseSearchSchema.parse({
        plan: "enterprise",
        license: "gpl",
        sort: "name",
        tier: "artifact",
        category: "",
        q: 42,
      }),
    ).toEqual({});
  });
});

describe("categories", () => {
  it("counts each category once per app, the biggest first, ties by label", () => {
    expect(
      categoryCounts([
        { categories: ["notes", "ai"] },
        { categories: ["ai", "ai"] },
        { categories: ["bots"] },
      ]),
    ).toEqual([
      { id: "ai", count: 2 },
      { id: "bots", count: 1 },
      { id: "notes", count: 1 },
    ]);
    expect(categoryCounts([])).toEqual([]);
  });

  it("counts a folded category toward the one it became, once per app", () => {
    expect(
      categoryCounts([
        { categories: ["games"] },
        { categories: ["gaming"] },
        { categories: ["games", "gaming"] },
        { categories: ["notes"] },
      ]),
    ).toEqual([
      { id: "games", count: 3 },
      { id: "notes", count: 1 },
    ]);
    expect(categoryLabel("games")).toBe("Games");
  });

  it("filters and searches a folded category as the one it became", () => {
    const chess = app({ slug: "chess", categories: ["games"] });
    const snake = app({ slug: "snake", categories: ["gaming"] });
    const notes = app({ slug: "notes", categories: ["notes"] });
    const all = [chess, snake, notes];
    expect(slugs(browseApps(all, { category: "games" }))).toEqual(["chess", "snake"]);
    expect(slugs(browseApps(all, { category: "gaming" }))).toEqual(["chess", "snake"]);
    expect(slugs(all.filter((a) => matchesSearch(a, "games")))).toEqual(["chess", "snake"]);
    expect(slugs(all.filter((a) => matchesSearch(a, "gaming")))).toEqual(["snake"]);
  });

  it("maps each folded category to the one it became", () => {
    expect(canonicalCategory("blogging")).toBe("cms");
    expect(canonicalCategory("gaming")).toBe("games");
    expect(canonicalCategory("social")).toBe("community");
    expect(canonicalCategory("storage")).toBe("files");
    expect(canonicalCategory("games")).toBe("games");
    expect(canonicalCategory("something-new")).toBe("something-new");
  });

  it("labels slugs in sentence case, keeping acronyms", () => {
    expect(categoryLabel("ai")).toBe("AI");
    expect(categoryLabel("email")).toBe("Email");
    expect(categoryLabel("link-shortener")).toBe("Link shortener");
    expect(categoryLabel("dns-tools")).toBe("DNS tools");
  });
});
