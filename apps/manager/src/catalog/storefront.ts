import {
  categoryLabel,
  comparePopularity,
  LICENSE_FILTERS,
  PLAN_WORDS,
} from "@appflare/schema/catalog-display";
import {
  type BrowsableApp,
  type BrowseQuery,
  type CatalogSort,
  categoryCounts,
  compareNewest,
  inCategory,
} from "./browse";

/**
 * What the catalog page shows before anyone searches: rows of apps picked
 * for a first look (new, most popular, installed here, the biggest
 * categories), the filters in the search field as plain-worded pills, and
 * the small rules its tiles and rows follow. Pure, so the page's choices can
 * be tested without a browser.
 */

/** Apps in one row at most; "See all" lists the rest. */
export const ROW_LIMIT = 15;

/** Rows for the categories with the most apps. */
export const CATEGORY_ROWS = 6;

/** Category cards shown before "Show all N categories". */
export const COLLAPSED_CATEGORIES = 12;

const DAY_MS = 86_400_000;

/** How far back "New this week" looks. */
export const NEW_WINDOW_MS = 7 * DAY_MS;

export interface StorefrontRow<T> {
  /** Stable id: `new`, `popular`, `installed` or `category-<id>`. */
  id: string;
  title: string;
  /** One quiet line under the title, when the row needs explaining. */
  caption: string | null;
  apps: T[];
  /** The query "See all" opens: the filter or order that lists every app of the row. */
  seeAll: BrowseQuery;
}

/** The caption of the "new" row while the catalog does not say when apps were added. */
export const RECENTLY_TESTED_CAPTION =
  "Newest test results first, until the catalog says when each app was added.";

function time(iso: string | null | undefined): number {
  const value = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(value) ? Number.NEGATIVE_INFINITY : value;
}

/** Whether the catalog says when any of `apps` was added (older indexes do not). */
export function knowsAddedDates(apps: ReadonlyArray<Pick<BrowsableApp, "addedAt">>): boolean {
  return apps.some((app) => app.addedAt !== undefined);
}

/**
 * Apps added in the last seven days, newest first. While the catalog does
 * not say when apps were added, the most recently tested apps stand in,
 * under a title and caption that say so.
 */
function newRow<T extends BrowsableApp>(apps: readonly T[], now: Date): StorefrontRow<T> | null {
  if (knowsAddedDates(apps)) {
    const since = now.getTime() - NEW_WINDOW_MS;
    const fresh = apps.filter((app) => time(app.addedAt) >= since);
    if (fresh.length === 0) return null;
    return {
      id: "new",
      title: "New this week",
      caption: null,
      apps: [...fresh].sort(compareNewest).slice(0, ROW_LIMIT),
      seeAll: { sort: "new" },
    };
  }
  const tested = apps.filter((app) => app.lastVerified !== null);
  if (tested.length === 0) return null;
  return {
    id: "new",
    title: "Recently tested",
    caption: RECENTLY_TESTED_CAPTION,
    apps: [...tested].sort(compareNewest).slice(0, ROW_LIMIT),
    seeAll: { sort: "new" },
  };
}

/** Most active installs first, then most GitHub stars; only apps the catalog has numbers for. */
function popularRow<T extends BrowsableApp>(apps: readonly T[]): StorefrontRow<T> | null {
  const counted = apps.filter(
    (app) =>
      app.popularity !== null &&
      (app.popularity.stars !== null ||
        app.popularity.activeInstalls !== null ||
        app.popularity.installs30d !== null),
  );
  if (counted.length === 0) return null;
  const installs = counted.some(
    (app) => app.popularity?.activeInstalls != null || app.popularity?.installs30d != null,
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
    seeAll: { sort: "popular" },
  };
}

function installedRow<T extends BrowsableApp>(apps: readonly T[]): StorefrontRow<T> | null {
  const installed = apps.filter((app) => app.installs.length > 0);
  if (installed.length === 0) return null;
  return {
    id: "installed",
    title: "Installed on this account",
    caption: null,
    apps: [...installed].sort((a, b) => a.name.localeCompare(b.name, "en")).slice(0, ROW_LIMIT),
    seeAll: { installed: 1 },
  };
}

/** A row for each of the biggest categories (two apps or more), most popular first. */
function categoryRows<T extends BrowsableApp>(apps: readonly T[]): Array<StorefrontRow<T>> {
  return categoryCounts(apps)
    .filter(({ count }) => count >= 2)
    .slice(0, CATEGORY_ROWS)
    .map(({ id }) => ({
      id: `category-${id}`,
      title: categoryLabel(id),
      caption: null,
      apps: apps
        .filter((app) => inCategory(app, id))
        .sort((a, b) => comparePopularity(a.popularity, b.popularity))
        .slice(0, ROW_LIMIT),
      seeAll: { category: id },
    }));
}

/** The rows of the catalog page without a search or filter, in page order. */
export function storefrontRows<T extends BrowsableApp>(
  apps: readonly T[],
  now: Date,
): Array<StorefrontRow<T>> {
  return [newRow(apps, now), popularRow(apps), installedRow(apps), ...categoryRows(apps)].filter(
    (row): row is StorefrontRow<T> => row !== null,
  );
}

const SORT_WORDS: Record<CatalogSort, string> = {
  popular: "Most popular first",
  new: "Newest first",
};

/** One active filter as a pill in the search field: its words, and the query key its × clears. */
export interface FilterPill {
  key: Exclude<keyof BrowseQuery, "q">;
  label: string;
}

/**
 * Every filter in the query, in a fixed order, worded plainly ("Category:
 * Email", "Plan: Free", "Installed"). The search words are not a pill: they
 * are the text in the field.
 */
export function filterPills(
  query: BrowseQuery,
  context: {
    /** A catalog's name, for the catalog filter. */
    sourceLabel: (id: string) => string;
    /** Whether "newest" can go by the day apps were added (else by their latest test). */
    addedDates: boolean;
  },
): FilterPill[] {
  const pills: FilterPill[] = [];
  if (query.category !== undefined) {
    pills.push({ key: "category", label: `Category: ${categoryLabel(query.category)}` });
  }
  if (query.plan !== undefined) {
    pills.push({ key: "plan", label: `Plan: ${PLAN_WORDS[query.plan].word}` });
  }
  if (query.license !== undefined) {
    pills.push({ key: "license", label: `License: ${LICENSE_FILTERS[query.license]}` });
  }
  if (query.installed !== undefined) pills.push({ key: "installed", label: "Installed" });
  if (query.source !== undefined) {
    pills.push({ key: "source", label: `Catalog: ${context.sourceLabel(query.source)}` });
  }
  if (query.sort !== undefined) {
    pills.push({
      key: "sort",
      label:
        query.sort === "new" && !context.addedDates
          ? "Recently tested first"
          : SORT_WORDS[query.sort],
    });
  }
  return pills;
}

/** The query change that removes `pill`. */
export function removePill(pill: FilterPill): BrowseQuery {
  const patch: BrowseQuery = {};
  patch[pill.key] = undefined;
  return patch;
}

/** The heading over the results: what they are, as plainly as the query allows. */
export function resultsTitle(query: BrowseQuery, addedDates: boolean): string {
  const searched = (query.q ?? "").trim() !== "";
  if (!searched && query.category !== undefined) return categoryLabel(query.category);
  if (searched) return "Results";
  if (query.installed !== undefined) return "Installed on this account";
  if (query.sort === "popular") return "Most popular";
  if (query.sort === "new") return addedDates ? "Newest apps" : "Recently tested";
  return "Results";
}

const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/**
 * How long ago `iso` was, in calendar days of the browser's time zone, so
 * never in hours: "today", "yesterday", "3 days ago", "2 weeks ago",
 * "last month".
 */
export function sinceDay(iso: string, now: Date): string {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.max(0, Math.round((startOf(now) - startOf(new Date(iso))) / DAY_MS));
  if (days < 7) return relative.format(-days, "day");
  if (days < 30) return relative.format(-Math.floor(days / 7), "week");
  if (days < 365) return relative.format(-Math.floor(days / 30), "month");
  return relative.format(-Math.floor(days / 365), "year");
}

/**
 * Where a key press moves focus among a row's tiles: the previous or next
 * tile with the arrow keys, the first or last with Home and End; null for
 * any other key, which keeps its usual meaning.
 */
export function tileKeyTarget(index: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowLeft":
      return Math.max(index - 1, 0);
    case "ArrowRight":
      return Math.min(index + 1, count - 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Whether a row shows its previous and next arrows: only when its tiles do
 * not all fit, and never on a narrow (phone) screen, where rows are swiped
 * and "See all" stays.
 */
export function showRowArrows(state: { narrow: boolean; overflows: boolean }): boolean {
  return state.overflows && !state.narrow;
}

/** A tile's one action: Manage the app where it is installed, else Get it from its page. */
export function primaryAction(app: {
  key: string;
  name: string;
  installs: ReadonlyArray<{ installId: string }>;
}): { label: "Get" | "Manage"; href: string; ariaLabel: string } {
  const [first, second] = app.installs;
  if (first === undefined) {
    return { label: "Get", href: `/catalog/${app.key}`, ariaLabel: `Get ${app.name}` };
  }
  // With several installs the app's page lists them all.
  return {
    label: "Manage",
    href: second === undefined ? `/apps/${first.installId}` : `/catalog/${app.key}`,
    ariaLabel: `Manage ${app.name}`,
  };
}
