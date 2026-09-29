import { type CatalogAuthor, type Plan, planSchema } from "@appflare/schema";
import {
  type AppLicense,
  type AppPopularity,
  categoryLabel,
  comparePopularity,
  isCatalogCategory,
  type LicenseFilter,
  licenseKind,
} from "@appflare/schema/catalog-display";
import { z } from "zod";
import { type AppPrimitives, PRIMITIVE_LABELS } from "./primitives";

/**
 * Finding apps on the catalog page: a search over what a person remembers
 * about an app (its name, what it does, who wrote it, what it runs on),
 * filters for the facts that decide whether it fits this account, and the
 * two orders a row's "See all" opens. Runs in the browser over the list the
 * page already loaded; the query lives in the page address so it can be
 * shared.
 */

/** What the search, filters and orders read from one app. */
export interface BrowsableApp {
  slug: string;
  name: string;
  summary: string;
  /** The catalog's one-line pitch. */
  tagline?: string | undefined;
  plan: Plan;
  lastVerified: string | null;
  /** When the entry joined the catalog, when the index says. */
  addedAt?: string | undefined;
  authors?: ReadonlyArray<Pick<CatalogAuthor, "name">> | undefined;
  categories: readonly string[];
  primitives: Pick<AppPrimitives, "ids">;
  instances: readonly unknown[];
  popularity: AppPopularity | null;
  /** The catalog that lists it, for the catalog filter. */
  source?: { id: string } | undefined;
  /** Its license, for the license filter; null or absent while not known. */
  appLicense?: AppLicense | null | undefined;
}

/** The orders a row's "See all" opens: most popular first, or newest first. */
export const CATALOG_SORTS = ["popular", "new"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export interface BrowseQuery {
  /** Free text; every word must match. */
  q?: string | undefined;
  category?: string | undefined;
  plan?: Plan | undefined;
  /** Only apps whose license is of this kind; an app whose license is not known yet matches none. */
  license?: LicenseFilter | undefined;
  /** `1`: only apps installed on this account (the address reads `installed=1`). */
  installed?: 1 | undefined;
  /** A catalog id: only that catalog's apps. */
  source?: string | undefined;
  /** Every app in this order, as a row's "See all" asks. */
  sort?: CatalogSort | undefined;
}

/** The longest search the address keeps; longer words are cut to it. */
export const MAX_QUERY_LENGTH = 200;

/**
 * How a change to the query goes into the browser's history: typing replaces
 * the current entry, so Back does not step through every letter; a choice
 * (a category, a filter, a pill removed, "See all", clearing) adds one, so
 * Back undoes it.
 */
export function browseNavigation(patch: BrowseQuery, change: "typing" | "choice") {
  return {
    search: <T extends BrowseQuery>(prev: T): T => ({ ...prev, ...patch }),
    replace: change === "typing",
    resetScroll: false,
  } as const;
}

/** A search parameter that is dropped, not an error, when a link carries a value this page does not know. */
function lenient<T extends z.ZodType>(schema: T) {
  return schema.optional().catch(undefined);
}

/**
 * The catalog page's address (`/catalog?q=…&category=…&plan=…&installed=1`).
 * Unknown values are dropped, so an old or edited link still opens the page;
 * `installed=yes` from older links reads as `installed=1`.
 */
export const browseSearchSchema = z.object({
  // Cut, not refused: a refused value would empty the field at the 201st character.
  q: lenient(z.string().transform((s) => s.slice(0, MAX_QUERY_LENGTH))),
  category: lenient(z.string().min(1).max(60)),
  plan: lenient(planSchema),
  license: lenient(z.enum(["open-source", "source-available", "none"])),
  installed: lenient(
    z.union([z.literal(1), z.literal(true), z.enum(["1", "true", "yes"])]).transform((): 1 => 1),
  ),
  source: lenient(z.string().min(1).max(64)),
  sort: lenient(z.enum(CATALOG_SORTS)),
});

/** Lower case without accents, so "cafe" finds "Café". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Everything one app can be found by, folded. */
function haystack(app: BrowsableApp): string {
  return fold(
    [
      app.name,
      app.slug,
      app.tagline ?? "",
      app.summary,
      ...(app.authors ?? []).map((a) => a.name),
      ...app.primitives.ids.flatMap((id) => [PRIMITIVE_LABELS[id], id]),
      // The id and its label, so either finds the app.
      ...app.categories.flatMap((c) => [c, categoryLabel(c)]),
    ].join("\n"),
  );
}

/** Whether `app` matches every word of `q` (an empty query matches everything). */
export function matchesSearch(app: BrowsableApp, q: string | undefined): boolean {
  const terms = fold(q ?? "")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const text = haystack(app);
  return terms.every((term) => text.includes(term));
}

/** Whether `app` passes the query's filters (search not included). */
export function matchesFilters(app: BrowsableApp, query: BrowseQuery): boolean {
  if (query.installed === 1 && app.instances.length === 0) return false;
  if (query.plan !== undefined && app.plan !== query.plan) return false;
  if (query.category !== undefined && !inCategory(app, query.category)) return false;
  if (query.source !== undefined && app.source?.id !== query.source) return false;
  if (query.license !== undefined) {
    if (app.appLicense == null || licenseKind(app.appLicense) !== query.license) return false;
  }
  return true;
}

/** A time for ordering; missing or unreadable times sort last. */
function timeOf(iso: string | null | undefined): number {
  const time = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Newest first: by the day the entry joined the catalog, then by its latest test. */
export function compareNewest(
  a: Pick<BrowsableApp, "addedAt" | "lastVerified">,
  b: Pick<BrowsableApp, "addedAt" | "lastVerified">,
): number {
  const added = timeOf(b.addedAt) - timeOf(a.addedAt);
  if (added !== 0 && !Number.isNaN(added)) return added;
  const tested = timeOf(b.lastVerified) - timeOf(a.lastVerified);
  return Number.isNaN(tested) ? 0 : tested;
}

/**
 * `apps` in `sort`'s order; without one, most popular first. Apps without
 * popularity numbers keep the index order (every sort is stable). Never
 * changes the input.
 */
export function sortApps<T extends BrowsableApp>(apps: readonly T[], sort?: CatalogSort): T[] {
  const copy = [...apps];
  if (sort === "new") return copy.sort(compareNewest);
  return copy.sort((a, b) => comparePopularity(a.popularity, b.popularity));
}

/** The apps to show for `query`: searched, filtered, then ordered. */
export function browseApps<T extends BrowsableApp>(apps: readonly T[], query: BrowseQuery): T[] {
  const shown = apps.filter((app) => matchesFilters(app, query) && matchesSearch(app, query.q));
  return sortApps(shown, query.sort);
}

/** Whether any search or filter is set (a "See all" order does not count). */
export function isFiltered(query: BrowseQuery): boolean {
  return (
    (query.q ?? "").trim() !== "" ||
    query.installed !== undefined ||
    query.plan !== undefined ||
    query.category !== undefined ||
    query.source !== undefined ||
    query.license !== undefined
  );
}

/** Whether the page lists results in place of its rows: a search, a filter or a "See all". */
export function showsResults(query: BrowseQuery): boolean {
  return isFiltered(query) || query.sort !== undefined;
}

/**
 * Every category of the catalog's list (`CATALOG_CATEGORIES`) the apps use,
 * with its number of apps: the most apps first, then by label. An id a
 * custom catalog uses that this version does not know gets no card or row
 * of its own; the app is still found by search and shows the id on its page.
 */
export function categoryCounts(
  apps: ReadonlyArray<Pick<BrowsableApp, "categories">>,
): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const app of apps) {
    for (const category of new Set(app.categories.filter(isCatalogCategory))) {
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([id, count]) => ({ id, count }))
    .sort(
      (a, b) => b.count - a.count || categoryLabel(a.id).localeCompare(categoryLabel(b.id), "en"),
    );
}

/** Whether `app` is listed under `category`. */
export function inCategory(app: Pick<BrowsableApp, "categories">, category: string): boolean {
  return app.categories.includes(category);
}
