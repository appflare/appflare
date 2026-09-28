import { describe, expect, it } from "vitest";
import type { BrowsableApp } from "./browse";
import {
  CATEGORY_ROWS,
  filterPills,
  knowsAddedDates,
  primaryAction,
  RECENTLY_TESTED_CAPTION,
  ROW_LIMIT,
  removePill,
  resultsTitle,
  showRowArrows,
  sinceDay,
  storefrontRows,
  tileKeyTarget,
} from "./storefront";

const NOW = new Date("2026-09-27T12:00:00Z");

function app(overrides: Partial<BrowsableApp> & { slug: string }): BrowsableApp {
  return {
    name: overrides.slug,
    summary: "An app.",
    plan: "free",
    lastVerified: null,
    categories: [],
    primitives: { ids: [] },
    instances: [],
    popularity: null,
    ...overrides,
  };
}

function stars(count: number, active: number | null = null) {
  return {
    stars: count,
    installs30d: null,
    activeInstalls: active,
    installsKnown: active !== null,
  };
}

const ids = (list: ReadonlyArray<{ slug: string }>) => list.map((a) => a.slug);
const context = {
  sourceLabel: (id: string) => (id === "team" ? "Team apps" : id),
  addedDates: true,
};

describe("storefrontRows", () => {
  it("lists new, popular, installed, then the biggest categories, in that order", () => {
    const apps = [
      app({
        slug: "a",
        categories: ["email", "ai"],
        addedAt: "2026-09-25T00:00:00Z",
        popularity: stars(10),
      }),
      app({ slug: "b", categories: ["email"], instances: [{}], popularity: stars(500) }),
      app({ slug: "c", categories: ["ai"] }),
      app({ slug: "d", categories: ["notes"] }),
    ];
    const rows = storefrontRows(apps, NOW);
    expect(rows.map((r) => r.id)).toEqual([
      "new",
      "popular",
      "installed",
      "category-ai",
      "category-email",
    ]);
    expect(rows.map((r) => r.title)).toEqual([
      "New this week",
      "Most popular",
      "Installed on this account",
      "AI",
      "Email",
    ]);
    // A category of one app gets no row.
    expect(rows.some((r) => r.id === "category-notes")).toBe(false);
  });

  it("finds new apps by the day they were added, newest first, within seven days", () => {
    const apps = [
      app({ slug: "old", addedAt: "2026-09-01T00:00:00Z", lastVerified: "2026-09-27T00:00:00Z" }),
      app({ slug: "tuesday", addedAt: "2026-09-22T00:00:00Z" }),
      app({ slug: "friday", addedAt: "2026-09-25T00:00:00Z" }),
      app({ slug: "undated", lastVerified: "2026-09-26T00:00:00Z" }),
    ];
    const row = storefrontRows(apps, NOW).find((r) => r.id === "new");
    expect(row).toMatchObject({ title: "New this week", caption: null, seeAll: { sort: "new" } });
    expect(ids(row?.apps ?? [])).toEqual(["friday", "tuesday"]);
  });

  it("leaves the new row out when the catalog dates its apps and none is from this week", () => {
    const apps = [
      app({ slug: "old", addedAt: "2026-08-01T00:00:00Z", lastVerified: NOW.toISOString() }),
    ];
    expect(storefrontRows(apps, NOW).some((r) => r.id === "new")).toBe(false);
  });

  it("falls back to the most recently tested apps, and says so, when no app has a date added", () => {
    const apps = [
      app({ slug: "older", lastVerified: "2026-09-20T00:00:00Z" }),
      app({ slug: "never" }),
      app({ slug: "newer", lastVerified: "2026-09-26T00:00:00Z" }),
    ];
    expect(knowsAddedDates(apps)).toBe(false);
    const row = storefrontRows(apps, NOW).find((r) => r.id === "new");
    expect(row).toMatchObject({ title: "Recently tested", caption: RECENTLY_TESTED_CAPTION });
    expect(ids(row?.apps ?? [])).toEqual(["newer", "older"]);
    expect(storefrontRows([app({ slug: "never" })], NOW)).toEqual([]);
  });

  it("orders popular apps by active installs, then stars, leaving out apps without numbers", () => {
    const apps = [
      app({ slug: "starred", popularity: stars(9000) }),
      app({ slug: "used", popularity: stars(10, 40) }),
      app({ slug: "unknown" }),
      app({ slug: "few", popularity: stars(3) }),
    ];
    const row = storefrontRows(apps, NOW).find((r) => r.id === "popular");
    expect(ids(row?.apps ?? [])).toEqual(["used", "starred", "few"]);
    expect(row?.caption).toBe("Most installed first, then most starred on GitHub");
    expect(row?.seeAll).toEqual({ sort: "popular" });
    const starsOnly = storefrontRows([app({ slug: "s", popularity: stars(5) })], NOW);
    expect(starsOnly.find((r) => r.id === "popular")?.caption).toBe("Most starred on GitHub");
    expect(storefrontRows([app({ slug: "u" })], NOW).some((r) => r.id === "popular")).toBe(false);
  });

  it("lists installed apps by name, with See all filtering to installed", () => {
    const apps = [
      app({ slug: "zed", name: "Zed", instances: [{}] }),
      app({ slug: "not" }),
      app({ slug: "alpha", name: "Alpha", instances: [{}, {}] }),
    ];
    const row = storefrontRows(apps, NOW).find((r) => r.id === "installed");
    expect(ids(row?.apps ?? [])).toEqual(["alpha", "zed"]);
    expect(row?.seeAll).toEqual({ installed: 1 });
  });

  it("gives the biggest categories a row each, most popular first, capped", () => {
    const categories = Array.from({ length: CATEGORY_ROWS + 2 }, (_, i) => `cat-${i}`);
    const apps = categories.flatMap((category, i) =>
      Array.from({ length: 30 - i }, (_, n) =>
        app({ slug: `${category}-${n}`, categories: [category], popularity: stars(n) }),
      ),
    );
    const rows = storefrontRows(apps, NOW).filter((r) => r.id.startsWith("category-"));
    expect(rows.map((r) => r.id)).toEqual(
      categories.slice(0, CATEGORY_ROWS).map((c) => `category-${c}`),
    );
    expect(rows[0]?.apps).toHaveLength(ROW_LIMIT);
    expect(rows[0]?.apps[0]?.slug).toBe("cat-0-29");
    expect(rows[0]?.seeAll).toEqual({ category: "cat-0" });
  });
});

describe("filterPills", () => {
  it("words every active filter plainly, in a fixed order", () => {
    const pills = filterPills(
      {
        q: "mail",
        sort: "popular",
        installed: 1,
        source: "team",
        license: "open-source",
        plan: "free",
        category: "email",
      },
      context,
    );
    expect(pills.map((p) => p.label)).toEqual([
      "Category: Email",
      "Plan: Free",
      "License: Open source",
      "Installed",
      "Catalog: Team apps",
      "Most popular first",
    ]);
    expect(filterPills({ q: "mail" }, context)).toEqual([]);
  });

  it("names the newest order by what it can go by", () => {
    expect(filterPills({ sort: "new" }, context)[0]?.label).toBe("Newest first");
    expect(filterPills({ sort: "new" }, { ...context, addedDates: false })[0]?.label).toBe(
      "Recently tested first",
    );
    expect(filterPills({ plan: "paid" }, context)[0]?.label).toBe("Plan: Paid");
  });

  it("removes exactly one filter", () => {
    const [category] = filterPills({ category: "email", plan: "free" }, context);
    expect(category).toBeDefined();
    if (category !== undefined) expect(removePill(category)).toEqual({ category: undefined });
  });
});

describe("resultsTitle", () => {
  it("names the results after the category, the See all or the search", () => {
    expect(resultsTitle({ category: "email" }, true)).toBe("Email");
    expect(resultsTitle({ category: "email", q: "mail" }, true)).toBe("Results");
    expect(resultsTitle({ installed: 1 }, true)).toBe("Installed on this account");
    expect(resultsTitle({ sort: "popular" }, true)).toBe("Most popular");
    expect(resultsTitle({ sort: "new" }, true)).toBe("Newest apps");
    expect(resultsTitle({ sort: "new" }, false)).toBe("Recently tested");
    expect(resultsTitle({ plan: "free" }, true)).toBe("Results");
  });
});

describe("sinceDay", () => {
  it("counts calendar days, never hours", () => {
    expect(sinceDay("2026-09-27T01:00:00Z", NOW)).toBe("today");
    expect(sinceDay("2026-09-26T23:00:00Z", NOW)).toBe("yesterday");
    expect(sinceDay("2026-09-24T12:00:00Z", NOW)).toBe("3 days ago");
    expect(sinceDay("2026-09-13T12:00:00Z", NOW)).toBe("2 weeks ago");
    expect(sinceDay("2026-07-27T12:00:00Z", NOW)).toBe("2 months ago");
    expect(sinceDay("2024-09-01T12:00:00Z", NOW)).toBe("2 years ago");
    // A clock slightly ahead of the browser's still reads as today.
    expect(sinceDay("2026-09-28T12:00:00Z", NOW)).toBe("today");
  });
});

describe("row keyboard and arrows", () => {
  it("moves between tiles with the arrow keys, Home and End, and stops at the ends", () => {
    expect(tileKeyTarget(2, "ArrowRight", 5)).toBe(3);
    expect(tileKeyTarget(4, "ArrowRight", 5)).toBe(4);
    expect(tileKeyTarget(2, "ArrowLeft", 5)).toBe(1);
    expect(tileKeyTarget(0, "ArrowLeft", 5)).toBe(0);
    expect(tileKeyTarget(3, "Home", 5)).toBe(0);
    expect(tileKeyTarget(1, "End", 5)).toBe(4);
    expect(tileKeyTarget(1, "Enter", 5)).toBeNull();
    expect(tileKeyTarget(0, "ArrowRight", 0)).toBeNull();
  });

  it("shows the arrows only when the tiles overflow and the screen is not narrow", () => {
    expect(showRowArrows({ narrow: false, overflows: true })).toBe(true);
    expect(showRowArrows({ narrow: true, overflows: true })).toBe(false);
    expect(showRowArrows({ narrow: false, overflows: false })).toBe(false);
    expect(showRowArrows({ narrow: true, overflows: false })).toBe(false);
  });
});

describe("primaryAction", () => {
  it("offers Get from the app page, and Manage for an app installed here", () => {
    expect(primaryAction({ key: "cut", name: "Cut", instances: [] })).toEqual({
      label: "Get",
      href: "/catalog/cut",
      ariaLabel: "Get Cut",
    });
    expect(primaryAction({ key: "cut", name: "Cut", instances: [{ installId: "i1" }] })).toEqual({
      label: "Manage",
      href: "/apps/i1",
      ariaLabel: "Manage Cut",
    });
    expect(
      primaryAction({
        key: "cut",
        name: "Cut",
        instances: [{ installId: "i1" }, { installId: "i2" }],
      }).href,
    ).toBe("/catalog/cut");
  });
});
