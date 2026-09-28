import { categoryLabel, comparePopularity, serviceName } from "@appflare/schema/catalog-display";
import type { SiteApp, SiteCategory } from "./site-catalog.ts";
import { categoryPath } from "./urls.ts";

/**
 * What the apps page shows before anyone searches, by the same rules as the
 * catalog page in Appflare itself: apps added this week (or, while the
 * catalog does not say when apps were added, the most recently tested),
 * the most popular, and a row for each of the biggest categories. Also the
 * search over the whole list, which runs in the browser.
 */

/** Apps in one row at most; the category page or the full list has the rest. */
export const ROW_LIMIT = 15;

/** Rows for the categories with the most apps. */
export const CATEGORY_ROWS = 6;

const DAY_MS = 86_400_000;

/** How far back "New this week" looks. */
export const NEW_WINDOW_MS = 7 * DAY_MS;

export interface StorefrontRow {
  /** `new`, `popular` or `category-<id>`. */
  id: string;
  title: string;
  /** One quiet line under the title, when the row needs explaining. */
  caption: string | null;
  apps: SiteApp[];
  /** Where "See all" goes; null when the row already shows every app it could. */
  seeAll: string | null;
}

/** The caption of the "new" row while the catalog does not say when apps were added. */
export const RECENTLY_TESTED_CAPTION =
  "Newest test results first, until the catalog says when each app was added.";

function time(iso: string | null): number {
  const value = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/** Newest first: by the day the entry joined the catalog, then by its latest test. */
function compareNewest(a: SiteApp, b: SiteApp): number {
  const added = time(b.addedAt) - time(a.addedAt);
  if (added !== 0 && !Number.isNaN(added)) return added;
  const tested = time(b.lastVerified) - time(a.lastVerified);
  return Number.isNaN(tested) ? 0 : tested;
}

function newRow(apps: readonly SiteApp[], now: Date): StorefrontRow | null {
  if (apps.some((app) => app.addedAt !== null)) {
    const since = now.getTime() - NEW_WINDOW_MS;
    const fresh = apps.filter((app) => time(app.addedAt) >= since);
    if (fresh.length === 0) return null;
    return {
      id: "new",
      title: "New this week",
      caption: null,
      apps: [...fresh].sort(compareNewest).slice(0, ROW_LIMIT),
      seeAll: null,
    };
  }
  const tested = apps.filter((app) => app.lastVerified !== null);
  if (tested.length === 0) return null;
  return {
    id: "new",
    title: "Recently tested",
    caption: RECENTLY_TESTED_CAPTION,
    apps: [...tested].sort(compareNewest).slice(0, ROW_LIMIT),
    seeAll: null,
  };
}

/** Most installed first, then most starred; only apps the catalog has numbers for. */
function popularRow(apps: readonly SiteApp[]): StorefrontRow | null {
  const counted = apps.filter(
    ({ popularity: p }) =>
      p !== null && (p.stars !== null || p.activeInstalls !== null || p.installs30d !== null),
  );
  if (counted.length === 0) return null;
  const installs = counted.some(
    ({ popularity: p }) => p?.activeInstalls != null || p?.installs30d != null,
  );
  return {
    id: "popular",
    title: "Most popular",
    caption: installs
      ? "Most installed first, then most starred on GitHub"
      : "Most starred on GitHub",
    apps: [...counted]
      .sort((a, b) => comparePopularity(a.popularity, b.popularity))
      .slice(0, ROW_LIMIT),
    seeAll: null,
  };
}

/** The apps listed under `category`, most popular first. */
export function appsInCategory(apps: readonly SiteApp[], category: string): SiteApp[] {
  return apps
    .filter((app) => app.categories.includes(category))
    .sort((a, b) => comparePopularity(a.popularity, b.popularity));
}

/** The rows of the apps page, in page order. */
export function storefrontRows(
  apps: readonly SiteApp[],
  categories: readonly SiteCategory[],
  now: Date,
): StorefrontRow[] {
  const rows = [newRow(apps, now), popularRow(apps)];
  for (const { id } of categories.filter((c) => c.count >= 2).slice(0, CATEGORY_ROWS)) {
    rows.push({
      id: `category-${id}`,
      title: categoryLabel(id),
      caption: null,
      apps: appsInCategory(apps, id).slice(0, ROW_LIMIT),
      seeAll: categoryPath(id),
    });
  }
  return rows.filter((row): row is StorefrontRow => row !== null);
}

/** Every app by name. */
export function appsByName(apps: readonly SiteApp[]): SiteApp[] {
  return [...apps].sort((a, b) => a.name.localeCompare(b.name, "en"));
}

/** Lower case without accents, so "cafe" finds "Café". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Everything one app can be found by: its name, what it does, who wrote it, what it runs on. */
function haystack(app: SiteApp): string {
  const services = (app.services ?? []).flatMap((id) => [id, serviceName(id) ?? ""]);
  return fold(
    [
      app.name,
      app.slug,
      app.pitch,
      app.summary,
      ...app.authors.map((author) => author.name),
      ...app.categories.flatMap((id) => [id, categoryLabel(id)]),
      ...services,
    ].join("\n"),
  );
}

/** The apps matching every word of `query`, by name; every app for an empty query. */
export function searchApps(apps: readonly SiteApp[], query: string): SiteApp[] {
  const terms = fold(query)
    .split(/\s+/)
    .filter((term) => term.length > 0);
  const matched =
    terms.length === 0
      ? apps
      : apps.filter((app) => {
          const text = haystack(app);
          return terms.every((term) => text.includes(term));
        });
  return appsByName(matched);
}
