import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppPopularity } from "../catalog/popularity";
import { AppGrid, AppRow, RowHeader } from "./catalog-row";
import { CatalogSearch } from "./catalog-search";
import { AppTile, type TileApp, TileMeta } from "./catalog-tile";
import { CategoryCards } from "./category-cards";

function tile(overrides: Partial<TileApp> = {}): TileApp {
  return {
    key: "cut",
    name: "Cut",
    pitch: "Short links on your own domain",
    plan: "paid",
    popularity: null,
    images: { icon: null, cover: null, screenshots: [] },
    instances: [],
    ...overrides,
  };
}

function popularity(stars: number | null): AppPopularity {
  return { stars, installs30d: null, activeInstalls: null, installsKnown: false };
}

/** The first opening tag that carries `attribute`, whatever the order of its attributes. */
function openingTag(html: string, attribute: string): string {
  const tag = html.match(/<[a-z][^>]*>/g)?.find((t) => t.includes(attribute));
  if (tag === undefined) throw new Error(`no element with ${attribute}`);
  return tag;
}

/** Visible and screen-reader text, tags removed. */
function text(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

describe("TileMeta", () => {
  it("shows the plan as one word, with its full name for screen readers", () => {
    const html = renderToStaticMarkup(createElement(TileMeta, { app: tile() }));
    expect(text(html)).toBe("Paid (Workers Paid plan)");
    expect(html).toMatch(/Paid<span class="sr-only"> \(Workers Paid plan\)<\/span>/);
    const free = renderToStaticMarkup(createElement(TileMeta, { app: tile({ plan: "free" }) }));
    expect(text(free)).toBe("Free (Workers Free plan)");
  });

  it("adds the GitHub stars in short form, and nothing when they are unknown", () => {
    const html = renderToStaticMarkup(
      createElement(TileMeta, { app: tile({ popularity: popularity(3812) }) }),
    );
    expect(text(html)).toBe("Paid (Workers Paid plan)·3.8k stars on GitHub");
    const small = renderToStaticMarkup(
      createElement(TileMeta, { app: tile({ popularity: popularity(647) }) }),
    );
    expect(text(small)).toContain("647 stars on GitHub");
    const none = renderToStaticMarkup(
      createElement(TileMeta, { app: tile({ popularity: popularity(null) }) }),
    );
    expect(text(none)).not.toContain("stars");
  });
});

describe("AppTile", () => {
  it("links the icon, name and pitch to the app page, and offers Get when not installed", () => {
    const html = renderToStaticMarkup(createElement(AppTile, { app: tile() }));
    const link = openingTag(html, "data-tile-link");
    expect(link).toMatch(/^<a /);
    expect(link).toContain('href="/catalog/cut"');
    expect(html).toContain("Short links on your own domain");
    expect(html).toContain("line-clamp-2");
    const get = openingTag(html, 'aria-label="Get Cut"');
    expect(get).toMatch(/^<a /);
    expect(get).toContain('href="/catalog/cut"');
    expect(text(html)).toContain("Get");
    expect(text(html)).not.toContain("Manage");
    // No badges, check dot or service icons on a tile.
    expect(html).not.toContain("rounded-full bg-kumo-success");
  });

  it("offers Manage for an installed app, linking to the install", () => {
    const html = renderToStaticMarkup(
      createElement(AppTile, {
        app: tile({
          instances: [
            { installId: "01J", status: "installed", workerName: "cut", instanceName: "cut" },
          ],
        }),
      }),
    );
    expect(html).toContain('href="/apps/01J"');
    expect(html).toContain('aria-label="Manage Cut"');
    expect(text(html)).not.toMatch(/\bGet\b/);
  });

  it("stacks the icon, name, pitch and the metadata line with the action, top to bottom", () => {
    const html = renderToStaticMarkup(
      createElement(AppTile, { app: tile({ popularity: popularity(647) }) }),
    );
    const link = openingTag(html, "data-tile-link");
    // A grid, and nothing that lays the icon out beside the text.
    expect(link).toMatch(/class="grid /);
    expect(link).not.toContain("inline-flex");
    expect(link).not.toContain("items-center");
    // The 64px icon (a monogram here), then the name on one line and the pitch in two.
    expect(html).toContain("width:64px");
    expect(html).toMatch(/truncate[^>]*>Cut</);
    expect(html).toMatch(/line-clamp-2[^>]*>Short links on your own domain</);
    // The link closes before the metadata line, which holds "Paid · ★ 647" and the action.
    const afterLink = html.slice(html.indexOf("</a>"));
    expect(text(afterLink)).toBe("Paid (Workers Paid plan)·647 stars on GitHubGet");
  });
});

describe("rows", () => {
  const noop = () => undefined;

  it("labels the arrow buttons with the row and the list they scroll, disabled at the ends", () => {
    const html = renderToStaticMarkup(
      createElement(RowHeader, {
        title: "Most popular",
        titleId: "t",
        caption: null,
        onSeeAll: noop,
        controls: "list",
        arrows: { back: false, forward: true, onPage: noop },
      }),
    );
    expect(html).toMatch(/<h2[^>]*id="t"[^>]*>Most popular<\/h2>/);
    expect(html).toContain('aria-label="See all: Most popular"');
    // aria-disabled, not disabled: a disabled button would drop keyboard focus at the end.
    const previous = openingTag(html, 'aria-label="Previous apps in Most popular"');
    expect(previous).toContain('aria-disabled="true"');
    expect(previous).not.toContain('disabled=""');
    expect(openingTag(html, 'aria-label="Next apps in Most popular"')).toContain(
      'aria-disabled="false"',
    );
    expect(openingTag(html, 'aria-label="Next apps in Most popular"')).not.toContain('disabled=""');
    expect(html.match(/aria-controls="list"/g)).toHaveLength(2);
  });

  it("leaves the arrows out when they are not shown, keeping See all", () => {
    const html = renderToStaticMarkup(
      createElement(RowHeader, {
        title: "Email",
        titleId: "t",
        caption: "A caption",
        onSeeAll: noop,
        controls: "list",
        arrows: null,
      }),
    );
    expect(html).not.toContain("Previous apps");
    expect(html).toContain("See all");
    expect(html).toContain("A caption");
  });

  it("renders a row as a labelled list of focusable tiles", () => {
    const html = renderToStaticMarkup(
      createElement(AppRow, {
        title: "Email",
        apps: [tile(), tile({ key: "mail", name: "Mail" })],
        onSeeAll: noop,
      }),
    );
    expect(html).toMatch(
      /<section aria-labelledby="([^"]+)"[^>]*>.*<ul[^>]*role="list"[^>]*aria-labelledby="\1"/,
    );
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html.match(/data-tile-link=""/g)).toHaveLength(2);
    // Before the row is measured nothing overflows, so no arrows.
    expect(html).not.toContain("Next apps in Email");
  });

  it("gives row tiles a fixed 14rem width, 1.5rem apart, snapping to their starts", () => {
    const html = renderToStaticMarkup(
      createElement(AppRow, {
        title: "Email",
        apps: [tile(), tile({ key: "mail", name: "Mail" })],
      }),
    );
    expect(openingTag(html, 'role="list"')).toMatch(/\bgap-6\b/);
    expect(openingTag(html, 'role="list"')).toContain("snap-x");
    for (const item of html.match(/<li [^>]*>/g) ?? []) {
      expect(item).toMatch(/\bw-56\b/);
      expect(item).toContain("snap-start");
    }
  });

  it("puts the same tiles in a grid of cells at least 14rem wide, 1.5rem apart", () => {
    const html = renderToStaticMarkup(
      createElement(AppGrid, {
        apps: [tile(), tile({ key: "mail", name: "Mail" })],
        labelledBy: "h",
      }),
    );
    const list = openingTag(html, 'role="list"');
    expect(list).toContain('aria-labelledby="h"');
    expect(list).toContain("minmax(14rem,1fr)");
    expect(list).toMatch(/\bgap-6\b/);
    expect(html.match(/data-tile-link=""/g)).toHaveLength(2);
    expect(html.match(/aria-label="Get /g)).toHaveLength(2);
  });
});

describe("CategoryCards", () => {
  const categories = Array.from({ length: 14 }, (_, i) => ({ id: `cat-${i}`, count: 20 - i }));

  it("shows the first twelve as toggle buttons, with the rest behind Show all", () => {
    const html = renderToStaticMarkup(
      createElement(CategoryCards, { categories, selected: "cat-2", onSelect: () => undefined }),
    );
    expect(html.match(/<button[^>]*aria-pressed=/g)).toHaveLength(12);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(openingTag(html, 'aria-pressed="true"')).toContain("bg-kumo-info-tint");
    expect(openingTag(html, 'aria-pressed="false"')).not.toContain("bg-kumo-info-tint");
    expect(html).toContain("Show all 14 categories");
    expect(text(html)).toContain("20 apps");
  });

  it("shows every category when the selected one is further down", () => {
    const html = renderToStaticMarkup(
      createElement(CategoryCards, { categories, selected: "cat-13", onSelect: () => undefined }),
    );
    expect(html.match(/<button[^>]*aria-pressed=/g)).toHaveLength(14);
    expect(html).not.toContain("Show all 14 categories");
  });
});

describe("CatalogSearch", () => {
  const base = {
    onText: () => undefined,
    onChange: () => undefined,
    onClear: () => undefined,
    sources: [],
  };

  it("shows each active filter as a pill with its own remove button, and one clear control", () => {
    const html = renderToStaticMarkup(
      createElement(CatalogSearch, {
        ...base,
        text: "mail",
        query: { q: "mail", category: "email", plan: "free" },
        pills: [
          { key: "category", label: "Category: Email" },
          { key: "plan", label: "Plan: Free" },
        ],
      }),
    );
    expect(html).toMatch(/<ul[^>]*aria-label="Active filters"/);
    expect(html).toContain('aria-label="Remove Category: Email"');
    expect(html).toContain('aria-label="Remove Plan: Free"');
    expect(html.match(/aria-label="Clear search and filters"/g)).toHaveLength(1);
    const input = openingTag(html, 'aria-label="Search apps"');
    expect(input).toMatch(/^<input /);
    // Not type="search", whose own clear button would double the field's.
    expect(input).toContain('type="text"');
    expect(html).toContain('aria-label="Filters"');
  });

  it("has no clear control and no pills while nothing is typed or filtered", () => {
    const html = renderToStaticMarkup(
      createElement(CatalogSearch, { ...base, text: "", query: {}, pills: [] }),
    );
    expect(html).not.toContain("Clear search");
    expect(html).not.toContain("Active filters");
    expect(html).toContain('placeholder="Search apps by name, purpose or author"');
  });
});
