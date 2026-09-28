import { env, waitUntil } from "cloudflare:workers";
import type { IndexApp } from "@appflare/schema";
import {
  type AppLicense,
  type AppPopularity,
  appPitch,
  appPopularity,
} from "@appflare/schema/catalog-display";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { readCapabilitiesView } from "../capabilities/capabilities.server";
import { invalidateScriptsCache } from "../cloudflare/scripts-cache.server";
import { settingsPlace } from "../components/settings-links";
import { createDb } from "../db/client";
import { sandboxBinding } from "../sandbox/binding";
import { type SandboxReadiness, sandboxReadinessOf } from "../sandbox/readiness";
import { requireRole, requireSession } from "../server/auth.server";
import { appFacts } from "./app-facts";
import { listAppFacts } from "./app-facts.server";
import {
  type ActiveInstalls,
  activeInstalls,
  type CatalogDetail,
  currentStats,
  type InstalledRef,
  readCatalogEntry,
  sourceBuildsOffered,
} from "./catalog-entry.server";
import { listCatalogRecords } from "./catalogs.server";
import { type FeaturedCard, featuredCard, pickFeatured } from "./featured";
import { dismissedFeaturedIds, dismissFeaturedItem } from "./featured.server";
import { CatalogError, catalogIndexUrl } from "./index.server";
import { type AppMediaView, appMediaView } from "./media";
import {
  type CatalogIndexRead,
  readEnabledCatalogs,
  refreshCustomCatalog,
  refreshOfficialCatalog,
} from "./merged.server";
import type { AppPrimitives } from "./primitives";
import { appKey, type CatalogSource, unsignedTierRefusal } from "./sources";

export type { CatalogDetail, InstalledRef } from "./catalog-entry.server";

/** Catalog browsing. */

export interface CatalogListItem extends IndexApp {
  /** The app key (`sources.ts`): its page is `/catalog/<key>`. */
  key: string;
  /** The catalog that lists it, for its source badge and the source filter. */
  source: CatalogSource;
  /** Installs of this app that are not uninstalled. */
  instances: InstalledRef[];
  /** The entry's images, as manager paths. */
  images: AppMediaView;
  /** Stars and install counts; null when the catalog publishes none (or they are stale). */
  popularity: AppPopularity | null;
  /** The Cloudflare primitives the app uses, as far as its manifests are known. */
  primitives: AppPrimitives;
  /** The catalog manifest's categories; empty until it has been read. */
  categories: string[];
  /** The license from the index row, else the catalog manifest; null until either states it. */
  appLicense: AppLicense | null;
  /** The line under its name on a catalog tile: the tagline, else the summary's first clause. */
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
 * and popularity, and for any app the facts its manifests give (verified
 * with that catalog's keys).
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
  // Manifests not cached yet are fetched after the response, for the next view.
  const facts = await listAppFacts(env, apps, waitUntil, read.trust);
  return apps.map((app) => {
    const key = appKey(read.source.id, app.slug);
    return {
      ...app,
      key,
      source: read.source,
      instances: active.bySlug.get(key) ?? [],
      // Images, avatars and popularity come from the official catalog alone.
      images: appMediaView(official ? app.media : undefined, indexUrl),
      popularity: official ? appPopularity(stats, app.slug) : null,
      pitch: appPitch(app),
      ...(facts.get(app.slug) ?? appFacts(app, null)),
    };
  });
}

/** Any signed-in user. */
export const listCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogList> => {
    const session = await requireSession();
    const [reads, active, capabilities] = await Promise.all([
      readEnabledCatalogs(env),
      activeInstalls(),
      readCapabilitiesView(createDb(env.DB)),
    ]);
    const sandbox = sandboxReadinessOf(capabilities, sandboxBinding(env) !== undefined);
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
  },
);

/**
 * Any signed-in user: hide a sponsored item for themselves. Members browse
 * the catalog too, so this needs a session, not the admin role.
 */
export const dismissFeatured = createServerFn({ method: "POST" })
  .validator(z.object({ itemId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const session = await requireSession();
    await dismissFeaturedItem(createDb(env.DB), session.user.id, data.itemId);
    return { ok: true };
  });

/**
 * Admin only: re-fetch every enabled catalog's `index.json` now. Throws
 * only when none could be fetched; otherwise `failed` names the others.
 */
export const refreshCatalog = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ updatedAt: string | null; count: number; failed: string[] }> => {
    await requireRole("admin");
    // A refresh asks for everything the catalog pages show to be read again.
    invalidateScriptsCache();
    const records = (await listCatalogRecords(createDb(env.DB))).filter((r) => r.enabled);
    let count = 0;
    let updatedAt: string | null = null;
    const failed: string[] = [];
    const errors: string[] = [];
    for (const record of records) {
      try {
        const snapshot =
          record.kind === "official"
            ? await refreshOfficialCatalog(env)
            : await refreshCustomCatalog(env, record);
        count += snapshot.index.apps.length;
        updatedAt ??= snapshot.updatedAt;
      } catch (error) {
        if (!(error instanceof CatalogError)) throw error;
        failed.push(record.label);
        errors.push(error.message);
      }
    }
    if (records.length > 0 && failed.length === records.length) {
      throw new Error(errors[0] ?? "No catalog could be refreshed.");
    }
    return { updatedAt, count, failed };
  },
);

/** Any signed-in user. */
export const getCatalogEntry = createServerFn({ method: "GET" })
  // `slug` is the app key: the plain slug, or `<catalog>:<slug>` for a custom catalog.
  .validator(z.object({ slug: z.string().min(1).max(130) }))
  .handler(async ({ data }): Promise<CatalogDetail> => readCatalogEntry(data.slug, requireSession));
