import type { CatalogStats } from "../catalog-stats";

/**
 * Popularity from the catalog's `stats.json`: GitHub stars of each app's
 * upstream repository and install counts from anonymous manager events.
 * It only orders the catalog and labels cards; nothing else depends on it.
 * The manager and the public site read it the same way.
 */

/**
 * Stats older than this are not shown: the catalog rebuilds them about
 * hourly, so a file this old means the rebuild has stopped, and stale
 * numbers would mislead more than none.
 */
export const STATS_MAX_AGE_MS = 72 * 60 * 60 * 1000;

/** One app's numbers, as the catalog page shows them. */
export interface AppPopularity {
  /** GitHub stars; null when unknown. */
  stars: number | null;
  /** Managers that installed the app in the last 30 days; null when unknown or fewer than 10. */
  installs30d: number | null;
  /** Managers running the app; null when unknown or fewer than 10. */
  activeInstalls: number | null;
  /**
   * The catalog read install counts for this app; with both counts null that
   * means fewer than 10 (published as null), shown as "Fewer than 10".
   */
  installsKnown: boolean;
}

/** The stats when they are recent enough to show, else null. */
export function freshStats(stats: CatalogStats | null, now: Date): CatalogStats | null {
  if (stats === null) return null;
  const age = now.getTime() - Date.parse(stats.generatedAt);
  return age <= STATS_MAX_AGE_MS ? stats : null;
}

/**
 * One app's numbers from fresh stats. Stars need matching repository provenance
 * when the caller knows the public repository. Proven stars are hidden when the
 * caller cannot identify the repository; older callers may still show legacy
 * counts without provenance. Install counts do not depend on the repository.
 */
export function appPopularity(
  stats: CatalogStats | null,
  slug: string,
  expectedRepo?: string,
): AppPopularity | null {
  const entry = stats?.apps[slug];
  if (entry === undefined) return null;
  const stars = entry.stars;
  const sameRepo =
    expectedRepo === undefined
      ? stars?.repo === undefined
      : stars?.repo?.toLowerCase() === expectedRepo.toLowerCase();
  return {
    stars: sameRepo ? (stars?.count ?? null) : null,
    installs30d: entry.installs?.last30d ?? null,
    activeInstalls: entry.installs?.active ?? null,
    installsKnown: entry.installs !== null,
  };
}

/**
 * Most popular first: apps running on the most managers, then installed
 * most in 30 days, then most starred; apps without numbers last. Ties keep
 * the index order (the sort is stable).
 */
export function comparePopularity(a: AppPopularity | null, b: AppPopularity | null): number {
  const keys = (p: AppPopularity | null) => [
    p?.activeInstalls ?? 0,
    p?.installs30d ?? 0,
    p?.stars ?? -1,
  ];
  const ka = keys(a);
  const kb = keys(b);
  for (let i = 0; i < ka.length; i += 1) {
    const diff = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** `apps` ordered by {@link comparePopularity}, without changing the input. */
export function sortByPopularity<T extends { popularity: AppPopularity | null }>(
  apps: readonly T[],
): T[] {
  return [...apps].sort((a, b) => comparePopularity(a.popularity, b.popularity));
}

/** A count for a small label: `950`, `1.2k`, `12k`, `1.3M`. */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? Math.floor(k * 10) / 10 : Math.floor(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? Math.floor(m * 10) / 10 : Math.floor(m)}M`;
}
