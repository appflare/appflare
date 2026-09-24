import { env } from "cloudflare:workers";
import {
  type CatalogAuthor,
  type CatalogManifest,
  hasFixedWorkerName,
  type IndexApp,
} from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { asc, ne } from "drizzle-orm";
import { z } from "zod";
import type { AccountPlan } from "../account/plan";
import { readAccountPlan } from "../account/plan.server";
import { hasRole } from "../auth/roles";
import { getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { type InstallVarField, installVarFields } from "../installs/install-vars";
import { suggestWorkerName } from "../installs/instance-names";
import { planBindings } from "../jobs/install/bindings";
import { sandboxBinding } from "../sandbox/binding";
import { requireRole, requireSession } from "../server/auth.server";
import { getCatalogManifest } from "./app-manifest.server";
import { appAuthors } from "./authors";
import { cronTriggerCount } from "./cron-triggers";
import { type FeaturedCard, featuredCard, pickFeatured } from "./featured";
import { dismissedFeaturedIds, dismissFeaturedItem } from "./featured.server";
import {
  CatalogError,
  catalogIndexUrl,
  getCatalogIndex,
  refreshCatalogIndex,
} from "./index.server";
import { type AppMediaView, appMediaView } from "./media";
import { type AppPopularity, appPopularity, freshStats } from "./popularity";
import { readCatalogStats } from "./stats.server";

/** Catalog browsing. */

export interface InstalledRef {
  installId: string;
  status: string;
  workerName: string;
  instanceName: string;
}

export interface CatalogListItem extends IndexApp {
  /** Installs of this app that are not uninstalled. */
  instances: InstalledRef[];
  /** The entry's images, as manager paths. */
  images: AppMediaView;
  /** Stars and install counts; null when the catalog publishes none (or they are stale). */
  popularity: AppPopularity | null;
}

export interface CatalogList {
  apps: CatalogListItem[];
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
}

/** Popularity for the index's apps, when the index names a stats file and it is recent. */
async function currentStats(indexStatsUrl: string | undefined) {
  if (indexStatsUrl === undefined) return null;
  return freshStats(await readCatalogStats(env.KV), new Date());
}

interface ActiveInstalls {
  bySlug: Map<string, InstalledRef[]>;
  /** Worker names held by any active install, whatever the app. */
  workerNames: string[];
}

async function activeInstalls(): Promise<ActiveInstalls> {
  const rows = await createDb(env.DB)
    .select({
      id: installs.id,
      slug: installs.app_slug,
      status: installs.status,
      worker: installs.worker_name,
      label: installs.instance_name,
    })
    .from(installs)
    .where(ne(installs.status, "uninstalled"))
    .orderBy(asc(installs.installed_at));
  const bySlug = new Map<string, InstalledRef[]>();
  for (const r of rows) {
    const list = bySlug.get(r.slug) ?? [];
    list.push({
      installId: r.id,
      status: r.status,
      workerName: r.worker,
      instanceName: r.label ?? r.worker,
    });
    bySlug.set(r.slug, list);
  }
  return { bySlug, workerNames: rows.map((r) => r.worker) };
}

/** Any signed-in user. */
export const listCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogList> => {
    const session = await requireSession();
    const [read, active] = await Promise.all([getCatalogIndex(env), activeInstalls()]);
    if (!read.ok) {
      return {
        apps: [],
        updatedAt: read.updatedAt,
        error: read.error,
        unreadable: 0,
        featured: null,
        statsGeneratedAt: null,
      };
    }
    const indexUrl = catalogIndexUrl(env);
    const { apps } = read.index;
    const [stats, dismissed] = await Promise.all([
      currentStats(read.index.stats),
      read.index.featured.length === 0
        ? new Set<string>()
        : dismissedFeaturedIds(createDb(env.DB), session.user.id),
    ]);
    const item = pickFeatured(read.index.featured, dismissed, new Date());
    return {
      apps: apps.map((app) => ({
        ...app,
        instances: active.bySlug.get(app.slug) ?? [],
        images: appMediaView(app.media, indexUrl),
        popularity: appPopularity(stats, app.slug),
      })),
      updatedAt: read.updatedAt,
      error: null,
      unreadable: read.unreadable,
      featured:
        item === null
          ? null
          : featuredCard(item, indexUrl, (slug) => apps.find((a) => a.slug === slug)?.name ?? null),
      statsGeneratedAt: stats?.generatedAt ?? null,
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

/** Admin only: re-fetch `index.json` now. */
export const refreshCatalog = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ updatedAt: string | null; count: number }> => {
    await requireRole("admin");
    try {
      const snapshot = await refreshCatalogIndex(env);
      return { updatedAt: snapshot.updatedAt, count: snapshot.index.apps.length };
    } catch (error) {
      if (error instanceof CatalogError) throw new Error(error.message);
      throw error;
    }
  },
);

export interface CatalogDetail {
  app: IndexApp | null;
  /** The entry's cover and screenshots (and icon), as manager paths. */
  images: AppMediaView;
  /** Stars and install counts; null when the catalog publishes none (or they are stale). */
  popularity: AppPopularity | null;
  /** The signed catalog manifest (form definitions, links, license). */
  catalog: CatalogManifest | null;
  /**
   * Who wrote the app: the index's authors, else the catalog manifest's
   * (the owner of its repository when it lists none); empty when neither loaded.
   */
  authors: CatalogAuthor[];
  /** Resources the install will create, by binding (`kv`, `d1`, ...). */
  creates: Array<{ kind: string; binding: string }>;
  durableObjects: string[];
  /** Why the index or the manifest could not be loaded. */
  error: string | null;
  /** Installs of this app that are not uninstalled, oldest first. */
  instances: InstalledRef[];
  /** Worker name to prefill: the catalog's, or the next free `<name>-N`. */
  suggestedWorkerName: string | null;
  /** The app only works under its catalog Worker name, so it installs once. */
  fixedWorkerName: boolean;
  /** The install form's settings, one per catalog var. */
  varFields: InstallVarField[];
  /**
   * The account's workers.dev subdomain, to show `{{workerUrl}}` filled in
   * on the form; null when it is not known (the install fills it in).
   */
  subdomain: string | null;
  /**
   * False for a sandbox tier app: its bindings come from the wrangler config
   * at the pinned commit, known only once it is built.
   */
  createsKnown: boolean;
  /** This manager has its `SANDBOX` binding (sandbox tier apps need it). */
  sandboxConnected: boolean;
  /**
   * Distinct cron triggers the artifact declares; 0 when none, or for a
   * sandbox tier app, whose wrangler config is read only when it is built.
   */
  cronTriggers: number;
  /** The account's Workers plan as Settings records it (free when never set). */
  accountPlan: AccountPlan;
}

/**
 * Worker names in the account, for admins only (members cannot install, so
 * the extra API call would be wasted). Best effort: the install checks again.
 */
async function accountWorkerNames(role: string | null | undefined): Promise<string[]> {
  if (!hasRole(role, "admin")) return [];
  try {
    return (await (await getCfClient(env)).workers.listScripts()).map((s) => s.id);
  } catch {
    return [];
  }
}

/**
 * The account's workers.dev subdomain: cached by the first install, else
 * looked up for admins (who can install) and cached the same way. Best
 * effort; null when unknown.
 */
async function accountSubdomain(role: string | null | undefined): Promise<string | null> {
  const orm = createDb(env.DB);
  const cached = (await readSettings(orm, [SETTING.accountSubdomain])).account_subdomain;
  if (cached) return cached;
  if (!hasRole(role, "admin")) return null;
  try {
    const found = (await (await getCfClient(env)).workers.getAccountSubdomain()).subdomain;
    await writeSettings(orm, { [SETTING.accountSubdomain]: found });
    return found;
  } catch {
    return null;
  }
}

/** Any signed-in user. */
export const getCatalogEntry = createServerFn({ method: "GET" })
  .validator(z.object({ slug: z.string().min(1).max(100) }))
  .handler(async ({ data }): Promise<CatalogDetail> => {
    const session = await requireSession();
    const accountPlan = await readAccountPlan(createDb(env.DB));
    const empty = {
      catalog: null,
      authors: [],
      creates: [],
      durableObjects: [],
      instances: [],
      suggestedWorkerName: null,
      fixedWorkerName: false,
      varFields: [],
      subdomain: null,
      createsKnown: true,
      sandboxConnected: sandboxBinding(env) !== undefined,
      cronTriggers: 0,
      accountPlan,
      images: appMediaView(undefined, ""),
      popularity: null,
    };
    const read = await getCatalogIndex(env);
    if (!read.ok) return { app: null, error: read.error, ...empty };
    const app = read.index.apps.find((a) => a.slug === data.slug) ?? null;
    if (app === null) return { app: null, error: null, ...empty };
    const [active, stats] = await Promise.all([activeInstalls(), currentStats(read.index.stats)]);
    const instances = active.bySlug.get(app.slug) ?? [];
    const shown = {
      images: appMediaView(app.media, catalogIndexUrl(env)),
      popularity: appPopularity(stats, app.slug),
    };
    const manifest = await getCatalogManifest(env, app);
    if (!manifest.ok) {
      return {
        ...empty,
        ...shown,
        app,
        authors: appAuthors(app, null),
        instances,
        error: manifest.error,
      };
    }
    const { install } = manifest.catalog;
    const fixed = hasFixedWorkerName(install);
    const [accountNames, subdomain] = await Promise.all([
      fixed ? [] : accountWorkerNames(session.user.role),
      accountSubdomain(session.user.role),
    ]);
    const taken = fixed ? [] : [...active.workerNames, ...accountNames];
    const plan =
      manifest.manifest === null
        ? null
        : planBindings(install.workerName, manifest.manifest.worker.bindings);
    return {
      ...empty,
      ...shown,
      app,
      catalog: manifest.catalog,
      authors: appAuthors(app, manifest.catalog),
      createsKnown: plan !== null,
      creates: plan?.resources.map((r) => ({ kind: r.kind, binding: r.binding })) ?? [],
      durableObjects: plan?.durableObjects.map((d) => d.className) ?? [],
      cronTriggers: cronTriggerCount(manifest.manifest?.worker.crons ?? []),
      error: null,
      instances,
      suggestedWorkerName: fixed
        ? install.workerName
        : suggestWorkerName(install.workerName, taken),
      fixedWorkerName: fixed,
      // A sandbox tier app's wrangler config is read only when it is built, so
      // before that every var is a text field.
      varFields: installVarFields(
        manifest.manifest ?? { catalog: manifest.catalog, worker: { bindings: [] } },
      ),
      subdomain,
    };
  });
