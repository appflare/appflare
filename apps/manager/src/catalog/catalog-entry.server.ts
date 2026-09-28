import { env } from "cloudflare:workers";
import {
  appWorkers,
  type CatalogAuthor,
  type CatalogManifest,
  hasFixedWorkerName,
  type IndexApp,
  type IndexJson,
} from "@appflare/schema";
import {
  type AppLicense,
  type AppPopularity,
  appPopularity,
  freshStats,
} from "@appflare/schema/catalog-display";
import { asc, ne } from "drizzle-orm";
import type { AccountPlan } from "../account/plan";
import type { AuthSession } from "../auth/guards";
import { hasRole } from "../auth/roles";
import type { CapabilitiesView } from "../capabilities/capabilities";
import { readCapabilitiesView } from "../capabilities/capabilities.server";
import { getCfClient } from "../cloudflare/client.server";
import { cachedScriptNames } from "../cloudflare/scripts-cache.server";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { distinctLabels } from "../installs/display-name";
import { namedInstall } from "../installs/install-names.server";
import { type InstallVarField, installVarFields } from "../installs/install-vars";
import { suggestWorkerName } from "../installs/instance-names";
import { entryBindings } from "../jobs/entry-workers";
import { planBindings } from "../jobs/install/bindings";
import { sandboxBinding } from "../sandbox/binding";
import { type SandboxReadiness, sandboxReadinessOf } from "../sandbox/readiness";
import { appFacts } from "./app-facts";
import { getCatalogManifest } from "./app-manifest.server";
import { moduleBytes } from "./app-page";
import { appAuthors } from "./authors";
import { cronTriggerCount } from "./cron-triggers";
import { catalogIndexUrl } from "./index.server";
import { type AppMediaView, appMediaView } from "./media";
import { finishCatalogLookup, type ListedApp, startCatalogLookup } from "./merged.server";
import type { AppPrimitives } from "./primitives";
import {
  type CatalogSource,
  installAppKey,
  OFFICIAL_CATALOG_ID,
  parseAppKey,
  unsignedTierRefusal,
} from "./sources";
import { readCatalogStats } from "./stats.server";

/** A catalog app's page, and what the catalog list shares with it. */

export interface InstalledRef {
  installId: string;
  status: string;
  workerName: string;
  /** What the UI calls the install (`distinctLabels`). */
  instanceName: string;
}

/**
 * Whether builds from a repository (and from source) are offered to this
 * viewer: admins on Workers Paid. With sandbox builds off the first build
 * turns them on, or its dialog says what is missing.
 */
export function sourceBuildsOffered(
  role: string | null | undefined,
  sandbox: SandboxReadiness,
): boolean {
  return hasRole(role, "admin") && sandbox.state !== "needs-plan";
}

/** Popularity for the index's apps, when the index names a stats file and it is recent. */
export async function currentStats(indexStatsUrl: string | undefined) {
  if (indexStatsUrl === undefined) return null;
  return freshStats(await readCatalogStats(env.KV), new Date());
}

export interface ActiveInstalls {
  /** By app key: an install counts only for the catalog it came from. */
  bySlug: Map<string, InstalledRef[]>;
  /** Worker names held by any active install, whatever the app. */
  workerNames: string[];
}

export async function activeInstalls(): Promise<ActiveInstalls> {
  const rows = await createDb(env.DB)
    .select({
      id: installs.id,
      slug: installs.app_slug,
      catalogId: installs.catalog_id,
      status: installs.status,
      worker: installs.worker_name,
      displayName: installs.display_name,
      manifestJson: installs.manifest_json,
    })
    .from(installs)
    .where(ne(installs.status, "uninstalled"))
    .orderBy(asc(installs.installed_at));
  const labels = distinctLabels(
    rows.map((r) =>
      namedInstall({
        id: r.id,
        app_slug: r.slug,
        worker_name: r.worker,
        display_name: r.displayName,
        manifest_json: r.manifestJson,
      }),
    ),
  );
  const bySlug = new Map<string, InstalledRef[]>();
  for (const r of rows) {
    const key = installAppKey({ app_slug: r.slug, catalog_id: r.catalogId });
    const list = bySlug.get(key) ?? [];
    list.push({
      installId: r.id,
      status: r.status,
      workerName: r.worker,
      instanceName: labels.get(r.id) ?? r.worker,
    });
    bySlug.set(key, list);
  }
  return { bySlug, workerNames: rows.map((r) => r.worker) };
}

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
 * the extra API call would be wasted), kept for a minute
 * (`scripts-cache.server.ts`). Best effort: the install checks again.
 */
async function accountWorkerNames(
  role: string | null | undefined,
  accountId: string | undefined,
): Promise<string[]> {
  if (!hasRole(role, "admin") || !accountId) return [];
  try {
    return await cachedScriptNames(accountId, async () =>
      (await (await getCfClient(env, { accountId })).workers.listScripts()).map((s) => s.id),
    );
  } catch {
    return [];
  }
}

/**
 * The account's workers.dev subdomain: `cached` (the first install records
 * it), else looked up for admins (who can install) and recorded the same
 * way. Best effort; null when unknown.
 */
async function accountSubdomain(
  role: string | null | undefined,
  cached: string | undefined,
  accountId: string | undefined,
): Promise<string | null> {
  if (cached) return cached;
  if (!hasRole(role, "admin")) return null;
  try {
    const api = await getCfClient(env, accountId ? { accountId } : {});
    const found = (await api.workers.getAccountSubdomain()).subdomain;
    await writeSettings(createDb(env.DB), { [SETTING.accountSubdomain]: found });
    return found;
  } catch {
    return null;
  }
}

/** The official catalog's popularity numbers, when its index names a stats file. */
async function statsFor(
  read: Promise<Awaited<ReturnType<typeof readCatalogStats>>>,
  index: IndexJson | null,
) {
  const stats = await read;
  return index?.stats === undefined ? null : freshStats(stats, new Date());
}

/**
 * An app's page: `slug` is the app key, the plain slug or `<catalog>:<slug>`
 * for a custom catalog. Any signed-in user. Two rounds of reads after the
 * session: first everything that needs only the app key (the catalog's record
 * and cached index, the popularity numbers, the account's capabilities and
 * settings, the installs), then what needs the app (its verified manifest)
 * or the viewer (the account's Worker names and workers.dev subdomain, for
 * admins).
 */
export async function readCatalogEntry(
  slug: string,
  loadSession: () => Promise<AuthSession>,
): Promise<CatalogDetail> {
  const db = createDb(env.DB);
  const official = parseAppKey(slug).catalogId === OFFICIAL_CATALOG_ID;
  // Popularity is the official catalog's alone; read alongside its index.
  const statsRead = official ? readCatalogStats(env.KV) : Promise.resolve(null);
  // Not left unhandled when the page ends before the stats are used.
  statsRead.catch(() => {});
  const [session, capabilities, lookup, active, settings] = await Promise.all([
    loadSession(),
    readCapabilitiesView(db),
    // Reads only: a catalog not cached yet is fetched below, once the
    // session is known, so a signed-out request never fetches or writes.
    startCatalogLookup(env, slug),
    activeInstalls(),
    readSettings(db, [SETTING.accountId, SETTING.accountSubdomain]),
  ]);
  // No I/O when the index was cached; one fetch when it was not.
  const read = await finishCatalogLookup(env, lookup);
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
  if (!read.ok) return { app: null, error: read.error, ...empty };
  if (read.listed === null) return { app: null, error: null, ...empty };
  const { app, key, source, trust }: ListedApp = read.listed;
  const stats = source.official ? await statsFor(statsRead, read.index) : null;
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
  const role = session.user.role;
  const [manifest, accountNames, subdomain] = await Promise.all([
    // Verified with the keys of the catalog that lists it, and no others.
    getCatalogManifest(env, app, trust),
    // Listed before the manifest says whether the Worker name is fixed; an
    // app with a fixed name ignores them.
    accountWorkerNames(role, settings.account_id),
    accountSubdomain(role, settings.account_subdomain, settings.account_id),
  ]);
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
    sourceBuilds: app.tier !== "self-deploying" && sourceBuildsOffered(session.user.role, sandbox),
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
    suggestedWorkerName: fixed ? install.workerName : suggestWorkerName(install.workerName, taken),
    fixedWorkerName: fixed,
    // A sandbox tier app's wrangler config is read only when it is built, so
    // before that every var is a text field.
    varFields: installVarFields(
      manifest.manifest ?? { catalog: manifest.catalog, worker: { bindings: [] } },
    ),
    subdomain,
  };
}
