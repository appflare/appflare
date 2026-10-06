import { env } from "cloudflare:workers";
import type { IndexApp } from "@appflare/schema";
import {
  type AppLicense,
  type AppPopularity,
  appPopularity,
} from "@appflare/schema/catalog-display";
import type { AuthSession } from "../auth/guards";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { readCapabilitiesView } from "../capabilities/capabilities.server";
import { settingsPlace } from "../components/settings-links";
import { createDb } from "../db/client";
import { type SandboxReadiness, sandboxReadinessOf } from "../sandbox/readiness";
import { sandboxBound } from "../sandbox/worker-deleted";
import { appFacts } from "./app-facts";
import {
  type ActiveInstalls,
  activeInstalls,
  currentStats,
  type InstalledRef,
  sourceBuildsOffered,
} from "./catalog-entry.server";
import { type FeaturedCard, featuredCard, pickFeatured } from "./featured";
import { dismissedFeaturedIds } from "./featured.server";
import { catalogIndexUrl } from "./index.server";
import { type AppMediaView, appMediaView } from "./media";
import { type CatalogIndexRead, readEnabledCatalogs } from "./merged.server";
import type { AppPrimitives } from "./primitives";
import { appKey, type CatalogSource, unsignedTierRefusal } from "./sources";

/** Catalog browsing. */

export interface CatalogListItem extends IndexApp {
  /** The app key (`sources.ts`): its page is `/catalog/<key>`. */
  key: string;
  /** The catalog that lists it, for its source badge and the source filter. */
  source: CatalogSource;
  /** Installs of this app that are not uninstalled. */
  installs: InstalledRef[];
  /** The entry's images, as manager paths. */
  images: AppMediaView;
  /** Stars and install counts; null when the catalog publishes none (or they are stale). */
  popularity: AppPopularity | null;
  /** The Cloudflare primitives the app uses, as far as its manifests are known. */
  primitives: AppPrimitives;
  /** The catalog manifest's categories; empty until it has been read. */
  categories: string[];
  /** The license, from the index row. */
  appLicense: AppLicense | null;
  /** The line under its name on a catalog tile: the catalog's tagline. */
  pitch: string;
}

export interface CatalogList {
  apps: CatalogListItem[];
  /** Every enabled catalog, the official one first: the source filter's choices. */
  sources: CatalogSource[];
  /** Enabled catalogs whose index could not be read, and why (the others still show). */
  failed: Array<{ source: CatalogSource; error: string }>;
  /** Added catalogs' entries left out because they are not prebuilt releases (`UNSIGNED_INDEX_REFUSAL`). */
  unsigned: Array<{ source: CatalogSource; count: number }>;
  /** ISO 8601 of the last successful refresh. */
  updatedAt: string | null;
  /** Why the index is unavailable (nothing cached and the fetch failed). */
  error: string | null;
  /** Entries of the published catalog this version of Appflare could not read. */
  unreadable: number;
  /** The sponsored item to show this user, if any. */
  featured: FeaturedCard | null;
  /** When the popularity numbers were computed; null when there are none recent enough to show. */
  statsGeneratedAt: string | null;
  /** What the account is known to offer, to mark each app's requirements met or not. */
  capabilities: CapabilitiesView | null;
  /**
   * "From a repository" is offered: the viewer is an admin and the account
   * is on Workers Paid (sandbox builds on, or turned on by the first build).
   */
  repositoryBuilds: boolean;
  /** Sandbox builds: on, turned on by the first build that needs them, or what is missing. */
  sandbox: SandboxReadiness;
}

/**
 * The apps of one catalog's index as list items: an official app's images
 * and popularity, and for any app the facts its index row publishes.
 */
async function listItems(
  read: Extract<CatalogIndexRead, { ok: true }>,
  active: ActiveInstalls,
  stats: Awaited<ReturnType<typeof currentStats>>,
): Promise<CatalogListItem[]> {
  const official = read.source.official;
  const indexUrl = catalogIndexUrl(env);
  // An added catalog lists prebuilt releases only (its index is not signed).
  const apps = read.index.apps.filter(
    (app) => unsignedTierRefusal(read.source.id, app.tier) === null,
  );
  return apps.map((app) => {
    const key = appKey(read.source.id, app.slug);
    return {
      ...app,
      key,
      source: read.source,
      installs: active.bySlug.get(key) ?? [],
      // Images, avatars and popularity come from the official catalog alone.
      images: appMediaView(official ? app.media : undefined, indexUrl),
      popularity: official ? appPopularity(stats, app.slug) : null,
      pitch: app.tagline,
      ...appFacts(app),
    };
  });
}

/**
 * The catalog page: every enabled catalog's apps, the sponsored item for
 * this viewer, and what the account offers to run them.
 */
export async function readCatalogList(session: AuthSession): Promise<CatalogList> {
  const db = createDb(env.DB);
  const [reads, active, capabilities, bound] = await Promise.all([
    readEnabledCatalogs(env),
    activeInstalls(),
    readCapabilitiesView(db),
    sandboxBound(env, db),
  ]);
  const sandbox = sandboxReadinessOf(capabilities, bound);
  const sources = reads.map((r) => r.source);
  const failed = reads.flatMap((r) => (r.ok ? [] : [{ source: r.source, error: r.error }]));
  const readable = reads.filter((r): r is Extract<CatalogIndexRead, { ok: true }> => r.ok);
  if (readable.length === 0) {
    return {
      apps: [],
      sources,
      failed,
      unsigned: [],
      updatedAt: reads[0]?.updatedAt ?? null,
      error:
        reads.length === 0
          ? `Every catalog is turned off. Turn one on in ${settingsPlace("catalogs", "catalogs", "the catalog settings")}.`
          : (failed[0]?.error ?? "The catalog is unavailable."),
      unreadable: 0,
      featured: null,
      statsGeneratedAt: null,
      capabilities: null,
      repositoryBuilds: sourceBuildsOffered(session.user.role, sandbox),
      sandbox,
    };
  }
  // The sponsored slot and popularity are the official catalog's alone.
  const official = readable.find((r) => r.source.official) ?? null;
  const [stats, dismissed] = await Promise.all([
    currentStats(official?.index.stats),
    official === null || official.index.featured.length === 0
      ? new Set<string>()
      : dismissedFeaturedIds(createDb(env.DB), session.user.id),
  ]);
  // One catalog whose items cannot be built is that catalog's failure, not the page's.
  const items = await Promise.all(
    readable.map((r) =>
      listItems(r, active, stats).catch((error: unknown) => {
        failed.push({
          source: r.source,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }),
    ),
  );
  const apps = items.flat();
  const unsigned = readable.flatMap((r) => {
    const count = r.index.apps.filter(
      (app) => unsignedTierRefusal(r.source.id, app.tier) !== null,
    ).length;
    return count === 0 ? [] : [{ source: r.source, count }];
  });
  const item =
    official === null ? null : pickFeatured(official.index.featured, dismissed, new Date());
  const officialApps = official?.index.apps ?? [];
  return {
    apps,
    sources,
    failed,
    unsigned,
    updatedAt: (official ?? readable[0])?.updatedAt ?? null,
    error: null,
    unreadable: readable.reduce((n, r) => n + r.unreadable, 0),
    featured:
      item === null
        ? null
        : featuredCard(
            item,
            catalogIndexUrl(env),
            (slug) => officialApps.find((a) => a.slug === slug)?.name ?? null,
          ),
    statsGeneratedAt: stats?.generatedAt ?? null,
    capabilities,
    repositoryBuilds: sourceBuildsOffered(session.user.role, sandbox),
    sandbox,
  };
}
