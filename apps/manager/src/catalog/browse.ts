import type { CatalogAuthor, InstallTier, Plan } from "@appflare/schema";
import { type AppPopularity, comparePopularity } from "./popularity";
import { type AppPrimitives, PRIMITIVE_LABELS } from "./primitives";

/**
 * Finding apps on the catalog page: a search over what a person remembers
 * about an app (its name, what it does, who wrote it, what it runs on),
 * filters for the facts that decide whether it fits this account, and the
 * order. Runs in the browser over the list the page already loaded.
 */

/** What the search, filters and sort read from one app. */
export interface BrowsableApp {
  slug: string;
  name: string;
  summary: string;
  tier: InstallTier;
  plan: Plan;
  lastVerified: string | null;
  authors?: ReadonlyArray<Pick<CatalogAuthor, "name">> | undefined;
  categories: readonly string[];
  primitives: Pick<AppPrimitives, "ids">;
  instances: readonly unknown[];
  popularity: AppPopularity | null;
  /** The catalog that lists it, for the source filter. */
  source?: { id: string } | undefined;
}

export const SORTS = {
  popular: "Most popular",
  name: "Name",
  checked: "Recently checked",
} as const;
export type Sort = keyof typeof SORTS;

export interface BrowseQuery {
  /** Free text; every word must match. */
  q?: string | undefined;
  installed?: "yes" | "no" | undefined;
  plan?: Plan | undefined;
  tier?: InstallTier | undefined;
  category?: string | undefined;
  /** A catalog id: only that catalog's apps. */
  source?: string | undefined;
  sort?: Sort | undefined;
}

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
      app.summary,
      ...(app.authors ?? []).map((a) => a.name),
      ...app.primitives.ids.flatMap((id) => [PRIMITIVE_LABELS[id], id]),
      ...app.categories,
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
  if (query.installed === "yes" && app.instances.length === 0) return false;
  if (query.installed === "no" && app.instances.length > 0) return false;
  if (query.plan !== undefined && app.plan !== query.plan) return false;
  if (query.tier !== undefined && app.tier !== query.tier) return false;
  if (query.category !== undefined && !app.categories.includes(query.category)) return false;
  if (query.source !== undefined && app.source?.id !== query.source) return false;
  return true;
}

/** Most recently checked first; never checked last. */
function compareChecked(a: BrowsableApp, b: BrowsableApp): number {
  const time = (app: BrowsableApp) =>
    app.lastVerified === null ? Number.NEGATIVE_INFINITY : Date.parse(app.lastVerified);
  return time(b) - time(a);
}

/**
 * `apps` in the query's order: "popular" (the default) keeps the index order
 * when the catalog publishes no popularity numbers. Every sort is stable, so
 * ties keep the index order. Never changes the input.
 */
export function sortApps<T extends BrowsableApp>(
  apps: readonly T[],
  sort: Sort,
  hasStats: boolean,
): T[] {
  const copy = [...apps];
  if (sort === "name") return copy.sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (sort === "checked") return copy.sort(compareChecked);
  return hasStats ? copy.sort((a, b) => comparePopularity(a.popularity, b.popularity)) : copy;
}

/** The apps to show for `query`: searched, filtered, then sorted. */
export function browseApps<T extends BrowsableApp>(
  apps: readonly T[],
  query: BrowseQuery,
  hasStats: boolean,
): T[] {
  const shown = apps.filter((app) => matchesFilters(app, query) && matchesSearch(app, query.q));
  return sortApps(shown, query.sort ?? "popular", hasStats);
}

/** Whether any search or filter is set (the sort does not count). */
export function isFiltered(query: BrowseQuery): boolean {
  return (
    (query.q ?? "").trim() !== "" ||
    query.installed !== undefined ||
    query.plan !== undefined ||
    query.tier !== undefined ||
    query.category !== undefined ||
    query.source !== undefined
  );
}

/** Every category the apps list, sorted by label. */
export function categoriesOf(apps: ReadonlyArray<Pick<BrowsableApp, "categories">>): string[] {
  const all = new Set(apps.flatMap((a) => a.categories));
  return [...all].sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b), "en"));
}

const CATEGORY_WORDS: Readonly<Record<string, string>> = { ai: "AI", dns: "DNS", seo: "SEO" };

/** A category slug as a label: `ai` → "AI", `link-shortener` → "Link shortener". */
export function categoryLabel(category: string): string {
  const words = category.split(/[-_\s]+/).filter((w) => w.length > 0);
  return words
    .map((word, i) => {
      const known = CATEGORY_WORDS[word.toLowerCase()];
      if (known !== undefined) return known;
      return i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
    })
    .join(" ");
}
