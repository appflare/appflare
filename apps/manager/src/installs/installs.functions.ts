import { env } from "cloudflare:workers";
import {
  artifactManifestSchema,
  combinedWorkerFacts,
  type EntryWorkerPlaceholders,
  entryPlaceholderValues,
  SELF_DEPLOYING_TOOLS,
  selfDeployingStage,
  type TokenPermission,
} from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AutoUpdateChoice } from "../auto-update/auto-update";
import { readAutoUpdateDefaults } from "../auto-update/auto-update.server";
import { getCatalogManifest, refreshInstalledRevision } from "../catalog/app-manifest.server";
import { listCatalogRecords, sourceOf } from "../catalog/catalogs.server";
import { catalogIndexUrl } from "../catalog/index.server";
import { mediaSrc } from "../catalog/media";
import { catalogLookup, findCatalogApp, type ListedApp } from "../catalog/merged.server";
import { effectiveManifest } from "../catalog/revisions.server";
import { type CatalogSource, installAppKey, OFFICIAL_CATALOG_ID } from "../catalog/sources";
import { isUpdateAvailable } from "../catalog/versions";
import { getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import {
  type BuildKind,
  type HealthStatus,
  type InstallOrigin,
  installs,
  type JobStarter,
  jobs,
  resources,
} from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { isRestoreJob, reconcileJobs } from "../jobs/reconcile.server";
import { recordedCatalog } from "../jobs/self-deploying/phases";
import { sandboxAutoEnableDeps } from "../sandbox/auto-enable-env.server";
import { sandboxBinding } from "../sandbox/binding";
import { requireRole, requireSession } from "../server/auth.server";
import { type AddressDomain, type AppAddressInput, appAddress } from "./app-address";
import { addressDomainOf, readAddressDomains } from "./app-address.server";
import { displayNameInput, installLabel } from "./display-name";
import { RenameInstallError, renameInstallCore } from "./display-name.server";
import { type EmailRouteView, emailRouteViews, SEND_EMAIL_NOTE, sendsEmail } from "./email-routing";
import { startInstallInput } from "./install-input";
import { renderPostInstall, workersDevUrl } from "./post-install";
import { isDeleteRetainedJob } from "./removed-apps.server";
import {
  ADDRESS_KINDS,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  EMAIL_ROUTE_KIND,
} from "./resource-kinds";
import { REPOSITORY_SLUG_PREFIX } from "./source-review";
import { catalogOnlyManifest, StartInstallError, startInstallCore } from "./start-install.server";
import { domainHostnames, primaryDomain, type WorkersDevChoice } from "./workers-dev";
import { settingsUseWorkerUrl } from "./workers-dev.server";

/** Installs: start one (admin), list them, and show one. Uninstall lives in `uninstall.functions.ts`. */

/** Admin only. Returns ids; the UI navigates to `/jobs/$jobId`. */
export const startInstall = createServerFn({ method: "POST" })
  .validator(startInstallInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    try {
      return await startInstallCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          async loadApp(key) {
            const read = await findCatalogApp(env, key);
            if (!read.ok) throw new StartInstallError(read.error);
            if (read.listed === null) {
              throw new StartInstallError(`"${key}" is not in any catalog that is turned on.`);
            }
            const { app, trust } = read.listed;
            // Verified with the keys of the catalog that lists it, and no others.
            const entry = await getCatalogManifest(env, app, trust);
            if (!entry.ok) throw new StartInstallError(entry.error);
            return {
              app,
              catalogId: trust.catalogId,
              manifest: entry.manifest ?? catalogOnlyManifest(entry.catalog),
            };
          },
          createJob: (id, params) => env.JOBS.create({ id, params }),
          sandboxConnected: sandboxBinding(env) !== undefined,
          sandboxAutoEnable: sandboxAutoEnableDeps(env),
          async listAccountWorkers() {
            const api = await getCfClient(env);
            return (await api.workers.listScripts()).map((s) => s.id);
          },
        },
        data,
      );
    } catch (error) {
      if (error instanceof StartInstallError) throw new Error(error.message);
      throw error;
    }
  });

/**
 * Admin only: sets the install's display name, or clears it with an empty
 * name so the Worker name shows again. Nothing is deployed.
 */
export const renameInstall = createServerFn({ method: "POST" })
  .validator(z.object({ installId: z.string().min(1).max(64), displayName: displayNameInput }))
  .handler(async ({ data }) => {
    await requireRole("admin");
    try {
      return await renameInstallCore(env.DB, data.installId, data.displayName);
    } catch (error) {
      if (error instanceof RenameInstallError) throw new Error(error.message);
      throw error;
    }
  });

export interface InstallRow {
  id: string;
  /** The app key (`sources.ts`): the catalog page of the app is `/catalog/<slug>`. */
  slug: string;
  /** The catalog the app comes from; null for a repository, or when that catalog is gone. */
  catalogSource: CatalogSource | null;
  /**
   * Where the code comes from: the catalog, a repository (not from the
   * catalog, not checked), or a catalog app built from source.
   */
  origin: InstallOrigin;
  /** The app's name from the catalog. */
  name: string;
  /** The app's icon from the catalog, as a manager path; null when it has none. */
  icon: string | null;
  /** The name an admin gave the install; null when it has none. */
  displayName: string | null;
  /** What the UI calls the install (`installLabel`): its display name, else its Worker name. */
  label: string;
  workerName: string;
  status: string;
  version: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Where "Open" takes the app (`appAddress`); null until installed, or with no address. */
  address: string | null;
  /** ISO 8601 */
  updatedAt: string;
  /** ISO 8601; null until the install is uninstalled. */
  uninstalledAt: string | null;
  /** The last health check of the Worker's URL; null until one ran. */
  healthStatus: HealthStatus | null;
  /** ISO 8601; when that check ran. */
  healthCheckedAt: string | null;
}

/**
 * The app's name when the catalog does not list it: an install from a
 * repository (or an app that left the catalog) carries its name in its
 * recorded artifact manifest.
 */
function recordedName(row: typeof installs.$inferSelect): string {
  if (row.manifest_json !== null) {
    try {
      const parsed = artifactManifestSchema.safeParse(JSON.parse(row.manifest_json));
      if (parsed.success) return parsed.data.catalog.name;
    } catch {
      // Not an artifact manifest; the slug below names it.
    }
  }
  return row.app_slug.replace(REPOSITORY_SLUG_PREFIX, "");
}

/** The name fields of an install row, for the list and the detail page. */
function namesOf(row: typeof installs.$inferSelect) {
  const names = { displayName: row.display_name, workerName: row.worker_name };
  return { ...names, label: installLabel(names) };
}

/** What `appAddress` needs of an install row. */
function addressInput(
  row: typeof installs.$inferSelect,
  domains: AddressDomain[],
  sub: string | null,
): AppAddressInput {
  return {
    workerName: row.worker_name,
    workersDevEnabled: row.workers_dev_enabled,
    servedDomain: row.served_domain,
    domains,
    subdomain: sub,
  };
}

function domainView(r: { id: string; name: string; live_at: Date | null }): CustomDomainView {
  return { id: r.id, hostname: r.name, url: `https://${r.name}`, live: r.live_at !== null };
}

function isAddressKind(kind: string): boolean {
  return (ADDRESS_KINDS as readonly string[]).includes(kind);
}

/** See `InstallDetail.workersDevNote`. */
function workersDevNoteOf(
  row: typeof installs.$inferSelect,
  domains: readonly AddressDomain[],
): InstallDetail["workersDevNote"] {
  if (row.workers_dev_choice !== "auto" || row.build_kind === "self-deploying") return null;
  if (!row.workers_dev_enabled) return "auto-off";
  const live = domains.some((d) => d.live);
  return live && settingsUseWorkerUrl(row.manifest_json, row.config_json) ? "settings" : null;
}

/** The health fields of an install row, for the list and the detail page. */
function healthOf(row: typeof installs.$inferSelect) {
  return {
    healthStatus: row.health_status,
    healthCheckedAt: row.health_checked_at?.toISOString() ?? null,
  };
}

/** The badge of every catalog, by id (the ones turned off too: an install keeps its source). */
async function catalogSources(): Promise<Map<string, CatalogSource>> {
  const records = await listCatalogRecords(createDb(env.DB));
  return new Map(records.map((r) => [r.id, sourceOf(r)]));
}

function sourceOfRow(
  row: Pick<typeof installs.$inferSelect, "catalog_id" | "origin">,
  sources: ReadonlyMap<string, CatalogSource>,
): CatalogSource | null {
  if (row.origin === "repository") return null;
  return sources.get(row.catalog_id ?? OFFICIAL_CATALOG_ID) ?? null;
}

/** The app's icon, served by the manager for the official catalog only (others show a monogram). */
function iconOf(found: ListedApp | undefined): string | null {
  if (found === undefined || !found.source.official) return null;
  return mediaSrc(found.app.media?.icon, catalogIndexUrl(env));
}

async function subdomain(): Promise<string | null> {
  const s = await readSettings(createDb(env.DB), [SETTING.accountSubdomain]);
  return s.account_subdomain || null;
}

/** The account's id, for `{{accountId}}` in post-install notes and vars; null before setup. */
async function accountId(): Promise<string | null> {
  const s = await readSettings(createDb(env.DB), [SETTING.accountId]);
  return s.account_id || null;
}

/**
 * Any signed-in user: every install that is not uninstalled, newest first.
 * Uninstalled ones that kept data are listed under Settings, Removed apps.
 */
export const listInstalls = createServerFn({ method: "GET" }).handler(
  async (): Promise<InstallRow[]> => {
    await requireSession();
    const db = createDb(env.DB);
    const [rows, catalog, sub, domains] = await Promise.all([
      db
        .select()
        .from(installs)
        .where(ne(installs.status, "uninstalled"))
        .orderBy(desc(installs.installed_at)),
      catalogLookup(env),
      subdomain(),
      readAddressDomains(db),
    ]);
    const sources = await catalogSources();
    const addressOf = (row: (typeof rows)[number]): string | null =>
      appAddress(addressInput(row, domains.get(row.id) ?? [], sub));
    return rows.map((row) => {
      // An install from a repository is never the catalog's app of the same name,
      // and an install is only ever compared with its own catalog's listing.
      const found = row.origin === "repository" ? undefined : catalog.get(installAppKey(row));
      const listed = found?.app;
      return {
        id: row.id,
        slug: installAppKey(row),
        catalogSource: sourceOfRow(row, sources),
        origin: row.origin,
        name: listed?.name ?? recordedName(row),
        icon: iconOf(found),
        ...namesOf(row),
        status: row.status,
        version: row.catalog_version,
        latestVersion: listed?.version ?? null,
        updateAvailable:
          row.status === "installed" && isUpdateAvailable(row.catalog_version, listed?.version),
        address: row.status === "installed" ? addressOf(row) : null,
        updatedAt: row.updated_at.toISOString(),
        uninstalledAt: row.uninstalled_at?.toISOString() ?? null,
        ...healthOf(row),
      };
    });
  },
);

export interface ResourceView {
  id: string;
  kind: string;
  binding: string | null;
  name: string;
  cfId: string | null;
  /** Created by the app's own installer, which alone deletes it (self-deploying tier). */
  managedByApp: boolean;
}

/** A custom domain of the install (a `domain` resource). */
export interface CustomDomainView {
  /** The `resources` row id. */
  id: string;
  hostname: string;
  /** `https://<hostname>` */
  url: string;
  /** A request through it has reached the app. */
  live: boolean;
}

export interface InstallDetail extends InstallRow {
  currentVersionId: string | null;
  pinSha: string | null;
  /**
   * Not from the catalog (a repository, or a catalog app built from source):
   * the repository and the branch, tag or commit it follows. Null for the catalog.
   */
  source: { url: string; ref: string } | null;
  /**
   * How the running code was built: a signed release, a sandbox build in this
   * account, or a deploy by the app's own installer (`installer` names it,
   * `stage` is the install's stage).
   */
  build: {
    kind: BuildKind;
    image: string | null;
    builtAt: string | null;
    installer: string | null;
    stage: string | null;
  };
  /** The settings the admin changed at install, with placeholders filled in. */
  vars: Record<string, string>;
  /** Resources in the account that belong to the install (secrets excluded). */
  resources: ResourceView[];
  /** Resources an uninstall kept in the account; they remain until deleted by hand. */
  retained: ResourceView[];
  secretNames: string[];
  /** Custom domains that serve the Worker, in the order they were added. */
  domains: CustomDomainView[];
  /** External domains (`custom_hostname` resources), served through the gateway. */
  externalDomains: CustomDomainView[];
  /** What the install set up in Email Routing, in the order it was set up. */
  emailRoutes: EmailRouteView[];
  /** Which uninstall action the page offers now. */
  uninstall: "start" | "retry" | null;
  /** Uninstalled and forgotten: no longer listed under Removed apps, even if it kept data. */
  forgotten: boolean;
  /** The job currently queued or running for this install, if any. */
  activeJobId: string | null;
  /** The Worker answers on its workers.dev URL (else only on its custom domains). */
  workersDevEnabled: boolean;
  /**
   * Why workers.dev is where it is, when Appflare decided: `auto-off` (a
   * domain went live), `settings` (a domain is live, but the Worker's
   * settings hold its workers.dev URL); null otherwise.
   */
  workersDevNote: "auto-off" | "settings" | null;
  /** Who sets workers.dev: Appflare, as domains go live and are removed, or an admin. */
  workersDevChoice: WorkersDevChoice;
  /** `https://<worker>.<subdomain>.workers.dev`, whether or not it is on; null when the subdomain is unknown. */
  workersDevUrl: string | null;
  /** The install's automatic-update choice. */
  autoUpdate: AutoUpdateChoice;
  /** The catalog version automatic updates left for an admin, if any. */
  autoUpdateWaiting: string | null;
  /** "Automatically update apps", which `inherit` follows. */
  autoUpdateDefault: boolean;
  jobs: Array<{
    id: string;
    kind: string;
    /** A database restore (recorded as a `rollback` job). */
    restore: boolean;
    /** A deletion of the data an uninstall kept (recorded as an `uninstall` job). */
    deleteRetained: boolean;
    status: string;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    /** Who started it: an admin, or the cron (automatic updates). */
    startedBy: JobStarter;
  }>;
  /**
   * Markdown with `{{workerUrl}}`/`{{workerName}}` filled in, then Appflare's
   * own notes (sending email); empty until installed.
   */
  postInstall: string[];
  /** Permissions of the Cloudflare token the app needs for itself, from its signed manifest. */
  tokenPermissions: TokenPermission[];
}

function parseVars(json: string | null): Record<string, string> {
  if (json === null) return {};
  try {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Any signed-in user. Null when there is no such install. */
export const getInstall = createServerFn({ method: "GET" })
  .validator(z.object({ installId: z.string().min(1).max(64) }))
  .handler(async ({ data }): Promise<InstallDetail | null> => {
    await requireSession();
    const db = createDb(env.DB);
    // A job whose Workflow died outside its own code is settled first, so the
    // page never waits on it forever.
    const active = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.install_id, data.installId), inArray(jobs.status, ["queued", "running"])));
    if (active.length > 0) await reconcileJobs(env.DB, env.JOBS, active);
    const [row] = await db.select().from(installs).where(eq(installs.id, data.installId)).limit(1);
    if (row === undefined) return null;
    const [resourceRows, jobRows, read, sub, autoUpdateDefaults, account] = await Promise.all([
      // Everything not deleted: live resources, and those an uninstall kept.
      db
        .select()
        .from(resources)
        .where(and(eq(resources.install_id, row.id), isNull(resources.deleted_at)))
        // Insertion order (created_at can tie within a millisecond).
        .orderBy(sql`rowid`),
      db.select().from(jobs).where(eq(jobs.install_id, row.id)).orderBy(desc(jobs.id)),
      // Only the install's own catalog: another catalog listing the same slug is another app.
      row.origin === "repository" ? Promise.resolve(null) : findCatalogApp(env, installAppKey(row)),
      subdomain(),
      readAutoUpdateDefaults(db),
      accountId(),
    ]);
    const found = read?.ok === true ? (read.listed ?? undefined) : undefined;
    const listed = found?.app;
    const workerUrl = workersDevUrl(row.worker_name, sub);
    // Where the app is reached: its primary custom domain while workers.dev is off.
    const domain = row.workers_dev_enabled
      ? null
      : primaryDomain(
          domainHostnames(resourceRows.filter((r) => r.retained_at === null)),
          row.served_domain,
        );
    const primaryUrl = domain === null ? workerUrl : `https://${domain}`;
    // What the jobs fill in, so notes and vars show the values the Worker has.
    const placeholders = {
      workerUrl: primaryUrl,
      workerName: row.worker_name,
      accountId: account,
    };
    const addressDomains = resourceRows
      .filter((r) => r.retained_at === null && isAddressKind(r.kind))
      .map(addressDomainOf);
    let name = listed?.name ?? row.app_slug;
    let postInstall: string[] = [];
    let tokenPermissions: TokenPermission[] = [];
    let entryWorkers: EntryWorkerPlaceholders | undefined;
    const installerCatalog =
      row.build_kind === "self-deploying" ? recordedCatalog(row.manifest_json) : null;
    if (installerCatalog !== null) {
      // A self-deploying install records its catalog manifest, not an artifact's.
      name = installerCatalog.name;
      postInstall = installerCatalog.postInstall.map((p) =>
        renderPostInstall(p.content, placeholders),
      );
      tokenPermissions = installerCatalog.tokenPermissions;
    } else if (row.manifest_json !== null) {
      const parsed = artifactManifestSchema.safeParse(JSON.parse(row.manifest_json));
      if (parsed.success) {
        // A revision of the installed release's form and copy: recorded once,
        // then read like the signed copy. No job, no update.
        if (row.origin === "catalog" && found !== undefined) {
          await refreshInstalledRevision(env, row, found.app, found.trust);
        }
        const manifest = await effectiveManifest(db, parsed.data, row.artifact_digest);
        name = manifest.catalog.name;
        // An app of several Workers: `{{workerUrl:<name>}}` names one of them.
        entryWorkers = entryPlaceholderValues(manifest.catalog, row.worker_name, sub, primaryUrl);
        const entry = entryWorkers;
        postInstall = manifest.catalog.postInstall.map((p) =>
          renderPostInstall(p.content, placeholders, entry),
        );
        if (sendsEmail(combinedWorkerFacts(manifest).bindings)) postInstall.push(SEND_EMAIL_NOTE);
        tokenPermissions = manifest.catalog.tokenPermissions;
      }
    }
    const view = (r: (typeof resourceRows)[number]): ResourceView => ({
      id: r.id,
      kind: r.kind,
      binding: r.binding,
      name: r.name,
      cfId: r.cf_id,
      managedByApp: r.managed_by === "app",
    });
    const live = resourceRows.filter((r) => r.retained_at === null);
    const activeJob = jobRows.find((j) => j.status === "queued" || j.status === "running");
    let uninstall: InstallDetail["uninstall"] = null;
    if (activeJob === undefined) {
      if (row.status === "installed" || row.status === "failed") uninstall = "start";
      else if (row.status === "uninstalling") {
        uninstall = "retry";
      }
    }
    return {
      id: row.id,
      slug: installAppKey(row),
      catalogSource: sourceOfRow(row, await catalogSources()),
      origin: row.origin,
      source:
        row.origin === "catalog" || row.source_url === null || row.source_ref === null
          ? null
          : { url: row.source_url, ref: row.source_ref },
      name,
      icon: iconOf(found),
      ...namesOf(row),
      status: row.status,
      version: row.catalog_version,
      latestVersion: listed?.version ?? null,
      updateAvailable:
        row.status === "installed" && isUpdateAvailable(row.catalog_version, listed?.version),
      address:
        row.status === "installed" ? appAddress(addressInput(row, addressDomains, sub)) : null,
      workersDevEnabled: row.workers_dev_enabled,
      workersDevNote: workersDevNoteOf(row, addressDomains),
      workersDevChoice: row.workers_dev_choice,
      workersDevUrl: workerUrl,
      autoUpdate: row.auto_update,
      autoUpdateDefault: autoUpdateDefaults.apps,
      autoUpdateWaiting: row.auto_update_waiting,
      updatedAt: row.updated_at.toISOString(),
      uninstalledAt: row.uninstalled_at?.toISOString() ?? null,
      ...healthOf(row),
      currentVersionId: row.current_version_id,
      pinSha: row.pin_sha,
      build: {
        kind: row.build_kind,
        image: row.sandbox_image,
        builtAt: row.built_at?.toISOString() ?? null,
        installer:
          installerCatalog?.install.selfDeploying === undefined
            ? null
            : SELF_DEPLOYING_TOOLS[installerCatalog.install.selfDeploying.tool].label,
        stage: row.build_kind === "self-deploying" ? selfDeployingStage(row.id) : null,
      },
      // As the Worker gets them: placeholders are kept as entered and filled in by the jobs.
      vars: Object.fromEntries(
        Object.entries(parseVars(row.config_json)).map(([name, value]) => [
          name,
          renderPostInstall(value, placeholders, entryWorkers),
        ]),
      ),
      // Email routes are listed under Email; their ids carry encoded state.
      resources: live.filter((r) => r.kind !== "secret" && r.kind !== EMAIL_ROUTE_KIND).map(view),
      retained: resourceRows.filter((r) => r.retained_at !== null).map(view),
      secretNames: live.filter((r) => r.kind === "secret").map((r) => r.name),
      domains: live.filter((r) => r.kind === CUSTOM_DOMAIN_KIND).map(domainView),
      externalDomains: live.filter((r) => r.kind === CUSTOM_HOSTNAME_KIND).map(domainView),
      emailRoutes: emailRouteViews(
        live
          .filter((r) => r.kind === EMAIL_ROUTE_KIND)
          .map((r) => ({ id: r.id, name: r.name, cfId: r.cf_id })),
      ),
      uninstall,
      forgotten: row.forgotten_at !== null,
      activeJobId: activeJob?.id ?? null,
      jobs: jobRows.map((j) => ({
        id: j.id,
        kind: j.kind,
        restore: isRestoreJob(j),
        deleteRetained: isDeleteRetainedJob(j),
        status: j.status,
        error: j.error,
        startedAt: j.started_at?.toISOString() ?? null,
        finishedAt: j.finished_at?.toISOString() ?? null,
        startedBy: j.started_by,
      })),
      postInstall,
      tokenPermissions,
    };
  });
