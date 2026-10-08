import {
  type CatalogAuthor,
  type FeaturedItem,
  type InstallTier,
  indexAccessNeededOnlyIfProtected,
  isFeaturedItemActive,
  type Plan,
} from "@appflare/schema";
import {
  type AppLicense,
  type AppPopularity,
  appPitch,
  appPopularity,
  categoryLabel,
  freshStats,
} from "@appflare/schema/catalog-display";
import type { InstallForm } from "./install-form.ts";
import type { CatalogSnapshot } from "./snapshot.ts";
import { catalogMediaUrl } from "./urls.ts";

/**
 * The catalog as the pages use it: each app with what its pages show and
 * nothing else (no release addresses or digests), worked out once from the
 * snapshot. The snapshot's time is the site's "now": stars show only when the
 * stats were fresh then, and "new this week" counts back from it.
 */

export interface SiteApp {
  slug: string;
  name: string;
  /** The one line under the name: the tagline. */
  pitch: string;
  summary: string;
  /** What the app does for people, one line each; empty when the catalog lists none. */
  features: string[];
  /** Well-known products the app can replace; empty when the catalog lists none. */
  alternativeTo: string[];
  version: string;
  plan: Plan;
  tier: InstallTier;
  requires: string[];
  /** The services the catalog worked out. */
  services: string[];
  /**
   * The app lists Cloudflare Access without requiring protection
   * (`indexAccessNeededOnlyIfProtected`): it needs it only if protected.
   */
  accessIfProtected: boolean;
  lastVerified: string | null;
  addedAt: string;
  authors: CatalogAuthor[];
  maintainers: string[];
  /** Category ids, each once. */
  categories: string[];
  license: AppLicense;
  icon: string | null;
  cover: string | null;
  screenshots: Array<{ url: string; alt: string }>;
  repo: string;
  /** The build repository when it differs from the public repository. */
  sourceRepo?: string;
  homepage: string;
  /** Null when the stats were stale or do not list the app. */
  popularity: AppPopularity | null;
  /** What Appflare's install form asks for this app; null when the snapshot does not say. */
  installForm: InstallForm | null;
}

/** A sponsored item, its image kept only when the catalog's own site hosts it. */
export type SiteFeatured = Omit<FeaturedItem, "image"> & {
  image: { url: string; alt: string } | null;
};

export interface SiteCategory {
  id: string;
  label: string;
  count: number;
}

export interface SiteCatalog {
  /** When the snapshot was taken. */
  takenAt: string;
  /** When the catalog published the index. */
  generatedAt: string;
  apps: SiteApp[];
  /** The sponsored item to show, if one is active. */
  featured: SiteFeatured | null;
  /** Every category the apps list, the most apps first, then by label. */
  categories: SiteCategory[];
}

/** Every category the apps list with its number of apps: the most first, then by label. */
export function categoryCounts(apps: ReadonlyArray<Pick<SiteApp, "categories">>): SiteCategory[] {
  const counts = new Map<string, number>();
  for (const app of apps) {
    for (const id of app.categories) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts]
    .map(([id, count]) => ({ id, label: categoryLabel(id), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en"));
}

export function siteCatalog(snapshot: CatalogSnapshot): SiteCatalog {
  const now = new Date(snapshot.takenAt);
  const stats = freshStats(snapshot.stats, now);
  const apps = snapshot.index.apps.map((app): SiteApp => {
    const links = snapshot.links[app.slug];
    // The snapshot's own check guarantees every app has its links.
    if (links === undefined) throw new Error(`No links for "${app.slug}"`);
    // Old snapshots without an upstream override retain their legacy counts.
    // New indexes, overridden repositories and proven counts must match the
    // repository read from the manifest, even if stats and index updates race.
    const expectedRepo =
      app.repo !== undefined ||
      links.sourceRepo !== undefined ||
      stats?.apps[app.slug]?.stars?.repo !== undefined
        ? links.repo
        : undefined;
    return {
      slug: app.slug,
      name: app.name,
      pitch: appPitch(app),
      summary: app.summary,
      features: app.features ?? [],
      alternativeTo: app.alternativeTo ?? [],
      version: app.version,
      plan: app.plan,
      tier: app.tier,
      requires: app.requires,
      services: app.services,
      accessIfProtected: indexAccessNeededOnlyIfProtected(app),
      lastVerified: app.lastVerified,
      addedAt: app.addedAt,
      authors: app.authors,
      maintainers: app.maintainers,
      categories: [...new Set(app.categories)],
      license: { expression: app.license, note: app.licenseNote ?? null },
      icon: catalogMediaUrl(app.media?.icon?.url),
      cover: catalogMediaUrl(app.media?.cover?.url),
      screenshots: (app.media?.screenshots ?? []).flatMap(({ url, alt }) => {
        const checked = catalogMediaUrl(url);
        return checked === null ? [] : [{ url: checked, alt }];
      }),
      repo: links.repo,
      ...(links.sourceRepo === undefined ? {} : { sourceRepo: links.sourceRepo }),
      homepage: links.homepage,
      popularity: appPopularity(stats, app.slug, expectedRepo),
      installForm: snapshot.forms?.[app.slug] ?? null,
    };
  });
  const slugs = new Set(apps.map((app) => app.slug));
  const active = snapshot.index.featured.find(
    (item) => isFeaturedItemActive(item, now) && (item.slug === undefined || slugs.has(item.slug)),
  );
  const image = active?.image;
  const featured: SiteFeatured | null =
    active === undefined
      ? null
      : {
          ...active,
          image:
            image === undefined || catalogMediaUrl(image.url) === null
              ? null
              : { url: image.url, alt: image.alt },
        };
  return {
    takenAt: snapshot.takenAt,
    generatedAt: snapshot.index.generatedAt,
    apps,
    featured,
    categories: categoryCounts(apps),
  };
}
