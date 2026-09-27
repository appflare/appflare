import { env, waitUntil } from "cloudflare:workers";
import {
  appWorkers,
  type CatalogAuthor,
  type CatalogManifest,
  hasFixedWorkerName,
  type IndexApp,
} from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { asc, ne } from "drizzle-orm";
import { z } from "zod";
import type { AccountPlan } from "../account/plan";
import { hasRole } from "../auth/roles";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { readCapabilitiesView } from "../capabilities/capabilities.server";
import { getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { installLabel } from "../installs/display-name";
import { type InstallVarField, installVarFields } from "../installs/install-vars";
import { suggestWorkerName } from "../installs/instance-names";
import { entryBindings } from "../jobs/entry-workers";
import { planBindings } from "../jobs/install/bindings";
import { sandboxBinding } from "../sandbox/binding";
import { type SandboxReadiness, sandboxReadinessOf } from "../sandbox/readiness";
import { requireRole, requireSession } from "../server/auth.server";
import { appFacts } from "./app-facts";
import { listAppFacts } from "./app-facts.server";
import { getCatalogManifest } from "./app-manifest.server";
import { moduleBytes } from "./app-page";
import { appAuthors } from "./authors";
import { listCatalogRecords } from "./catalogs.server";
import { cronTriggerCount } from "./cron-triggers";
import { type FeaturedCard, featuredCard, pickFeatured } from "./featured";
import { dismissedFeaturedIds, dismissFeaturedItem } from "./featured.server";
import { CatalogError, catalogIndexUrl } from "./index.server";
import type { AppLicense } from "./license";
import { type AppMediaView, appMediaView } from "./media";
import {
  type CatalogIndexRead,
  findCatalogApp,
  type ListedApp,
  readEnabledCatalogs,
  refreshCustomCatalog,
  refreshOfficialCatalog,
} from "./merged.server";
import { appPitch } from "./pitch";
import { type AppPopularity, appPopularity, freshStats } from "./popularity";
import type { AppPrimitives } from "./primitives";
import { appKey, type CatalogSource, installAppKey, unsignedTierRefusal } from "./sources";
import { readCatalogStats } from "./stats.server";

/** Catalog browsing. */

export interface InstalledRef {
  installId: string;
  status: string;
  workerName: string;
  /** What the UI calls the install (`installLabel`). */
  instanceName: string;
}

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
 * Whether builds from a repository (and from source) are offered to this
 * viewer: admins on Workers Paid. With sandbox builds off the first build
 * turns them on, or its dialog says what is missing.
 */
function sourceBuildsOffered(role: string | null | undefined, sandbox: SandboxReadiness): boolean {
  return hasRole(role, "admin") && sandbox.state !== "needs-plan";
}

/** Popularity for the index's apps, when the index names a stats file and it is recent. */
async function currentStats(indexStatsUrl: string | undefined) {
  if (indexStatsUrl === undefined) return null;
  return freshStats(await readCatalogStats(env.KV), new Date());
}

/** The official catalog's popularity, from its cached stats (the index names the file). */
async function officialStats() {
  const reads = await readEnabledCatalogs(env, { refreshOnMiss: false });
  const official = reads.find((r) => r.source.official);
  return currentStats(official?.ok === true ? official.index.stats : undefined);
}

interface ActiveInstalls {
  /** By app key: an install counts only for the catalog it came from. */
  bySlug: Map<string, InstalledRef[]>;
  /** Worker names held by any active install, whatever the app. */
  workerNames: string[];
}

async function activeInstalls(): Promise<ActiveInstalls> {
  const rows = await createDb(env.DB)
    .select({
      id: installs.id,
      slug: installs.app_slug,
      catalogId: installs.catalog_id,
      status: installs.status,
      worker: installs.worker_name,
      displayName: installs.display_name,
    })
    .from(installs)
    .where(ne(installs.status, "uninstalled"))
    .orderBy(asc(installs.installed_at));
  const bySlug = new Map<string, InstalledRef[]>();
  for (const r of rows) {
    const key = installAppKey({ app_slug: r.slug, catalog_id: r.catalogId });
    const list = bySlug.get(key) ?? [];
    list.push({
      installId: r.id,
      status: r.status,
      workerName: r.worker,
      instanceName: installLabel({ displayName: r.displayName, workerName: r.worker }),
    });
    bySlug.set(key, list);
  }
  return { bySlug, workerNames: rows.map((r) => r.worker) };
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
            ? "Every catalog is turned off. Turn one on in Settings, Catalogs."
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

export interface CatalogDetail {
  app: IndexApp | null;
  /** The app key (`sources.ts`); what the install form and source builds send back. */
  key: string | null;
  /** The catalog that lists it; null when the app was not found. */
  source: CatalogSource | null;
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
   * Sandbox builds: on, turned on first by an install that needs them, or
   * what is missing.
   */
  sandbox: SandboxReadiness;
  /**
   * Distinct cron triggers the artifact declares; 0 when none, or for a
   * sandbox tier app, whose wrangler config is read only when it is built.
   */
  cronTriggers: number;
  /**
   * Bytes of Worker code the install uploads, across the app's Workers; null
   * before a build (sandbox and self-deploying apps) or for an app that only
   * serves static files.
   */
  moduleBytes: number | null;
  /** The account's Workers plan in force: detected, else as Settings records it, else free. */
  accountPlan: AccountPlan;
  /** What the account capability probes found, for the requirement badges. */
  capabilities: CapabilitiesView;
  /** The Cloudflare primitives the app uses, as far as its manifests are known. */
  primitives: AppPrimitives;
  /** The catalog manifest's categories; empty when it could not be loaded. */
  categories: string[];
  /** The license from the index row, else the catalog manifest; null when neither states it. */
  appLicense: AppLicense | null;
  /**
   * "Build from source at a commit" is offered: the viewer is an admin, the
   * account is on Workers Paid, and the app does not deploy itself.
   */
  sourceBuilds: boolean;
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
  // `slug` is the app key: the plain slug, or `<catalog>:<slug>` for a custom catalog.
  .validator(z.object({ slug: z.string().min(1).max(130) }))
  .handler(async ({ data }): Promise<CatalogDetail> => {
    const session = await requireSession();
    const capabilities = await readCapabilitiesView(createDb(env.DB));
    const accountPlan = capabilities.plan.plan;
    const sandbox = sandboxReadinessOf(capabilities, sandboxBinding(env) !== undefined);
    const empty = {
      key: null,
      source: null,
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
      sandbox,
      cronTriggers: 0,
      moduleBytes: null,
      accountPlan,
      capabilities,
      images: appMediaView(undefined, ""),
      popularity: null,
      sourceBuilds: false,
      ...appFacts({ tier: "artifact", requires: [] }, null),
    };
    const read = await findCatalogApp(env, data.slug);
    if (!read.ok) return { app: null, error: read.error, ...empty };
    if (read.listed === null) return { app: null, error: null, ...empty };
    const { app, key, source, trust }: ListedApp = read.listed;
    const [active, stats] = await Promise.all([
      activeInstalls(),
      // Popularity and images are the official catalog's alone.
      source.official ? officialStats() : Promise.resolve(null),
    ]);
    const instances = active.bySlug.get(key) ?? [];
    const shown = {
      key,
      source,
      images: appMediaView(source.official ? app.media : undefined, catalogIndexUrl(env)),
      popularity: source.official ? appPopularity(stats, app.slug) : null,
      ...appFacts(app, null),
    };
    // An added catalog's sandbox or self-deploying entry is trusted by its
    // unsigned index alone: shown, never read or installed.
    const unsigned = unsignedTierRefusal(source.id, app.tier);
    if (unsigned !== null) {
      return {
        ...empty,
        ...shown,
        app,
        authors: appAuthors(app, null),
        instances,
        error: unsigned,
      };
    }
    // Verified with the keys of the catalog that lists it, and no others.
    const manifest = await getCatalogManifest(env, app, trust);
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
        : planBindings(
            install.workerName,
            entryBindings(manifest.manifest),
            manifest.catalog.resources?.hyperdrive ?? [],
            manifest.catalog.resources?.pipelines,
          );
    return {
      ...empty,
      ...shown,
      ...appFacts(app, manifest),
      app,
      catalog: manifest.catalog,
      sourceBuilds:
        app.tier !== "self-deploying" && sourceBuildsOffered(session.user.role, sandbox),
      authors: appAuthors(app, manifest.catalog),
      createsKnown: plan !== null,
      creates:
        plan?.resources.flatMap((r) => [
          // A Pipelines sink's bucket that no R2 binding has is created with the stream.
          ...(r.type === "pipelines" && r.pipeline.bucket.create
            ? [{ kind: "r2" as const, binding: r.pipeline.bucket.key }]
            : []),
          { kind: r.kind, binding: r.binding },
        ]) ?? [],
      durableObjects: plan?.durableObjects.map((d) => d.className) ?? [],
      cronTriggers:
        manifest.manifest === null
          ? 0
          : appWorkers(manifest.manifest).reduce((n, w) => n + cronTriggerCount(w.worker.crons), 0),
      moduleBytes:
        manifest.manifest === null
          ? null
          : moduleBytes(appWorkers(manifest.manifest).map((w) => w.worker)) || null,
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
