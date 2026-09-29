import { env } from "cloudflare:workers";
import {
  appTokenPermissions,
  artifactManifestSchema,
  combinedWorkerFacts,
  type EntryWorkerPlaceholders,
  entryPlaceholderValues,
  SELF_DEPLOYING_TOOLS,
  selfDeployingStage,
  type TokenPermission,
} from "@appflare/schema";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AutoUpdateChoice } from "../auto-update/auto-update";
import { readAutoUpdateDefaults } from "../auto-update/auto-update.server";
import { refreshInstalledRevision } from "../catalog/app-manifest.server";
import { listCatalogRecords } from "../catalog/catalogs.server";
import { findCatalogApp, readCachedListing } from "../catalog/merged.server";
import { manifestWithRevision, readCatalogRevision } from "../catalog/revisions.server";
import { installAppKey } from "../catalog/sources";
import { isUpdateAvailable } from "../catalog/versions";
import { createDb } from "../db/client";
import { type BuildKind, installs, type JobStarter, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { isRestoreJob, reconcileJobs } from "../jobs/reconcile.server";
import { recordedCatalog } from "../jobs/self-deploying/phases";
import { sandboxBinding } from "../sandbox/binding";
import { type AddressDomain, appAddress } from "./app-address";
import { addressDomainOf } from "./app-address.server";
import { installLabel } from "./display-name";
import { type EmailRouteView, emailRouteViews, SEND_EMAIL_NOTE, sendsEmail } from "./email-routing";
import { readInstallLabels, readInstallNames } from "./install-names.server";
import {
  addressInput,
  catalogSources,
  healthOf,
  type InstallRow,
  iconOf,
  namesOf,
  sourceOfRow,
  subdomain,
} from "./install-rows.server";
import { type OtherWorkerView, otherWorkerViews } from "./other-workers";
import { renderPostInstall, workersDevUrl } from "./post-install";
import { type InstallSettings, readInstallSettingsCore } from "./reconfigure.server";
import { isDeleteRetainedJob } from "./removed-apps.server";
import {
  ADDRESS_KINDS,
  CUSTOM_DOMAIN_KIND,
  CUSTOM_HOSTNAME_KIND,
  EMAIL_ROUTE_KIND,
  WILDCARD_DOMAIN_KIND,
} from "./resource-kinds";
import { wildcardHostnameOf, wildcardOfManifest } from "./wildcard-domain-input";
import { domainHostnames, primaryDomain, type WorkersDevChoice } from "./workers-dev";
import { settingsUseWorkerUrl } from "./workers-dev.server";

/** What an install's page shows of it. */

function domainView(r: {
  id: string;
  kind: string;
  name: string;
  live_at: Date | null;
}): CustomDomainView {
  return {
    id: r.id,
    hostname: r.name,
    url: `https://${r.name}`,
    live: r.live_at !== null,
    wildcard: r.kind === WILDCARD_DOMAIN_KIND,
  };
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

/** The account's id, for `{{accountId}}` in post-install notes and vars; null before setup. */
async function accountId(): Promise<string | null> {
  const s = await readSettings(createDb(env.DB), [SETTING.accountId]);
  return s.account_id || null;
}

export interface ResourceView {
  id: string;
  kind: string;
  binding: string | null;
  name: string;
  cfId: string | null;
  /** Created by the app's own installer, which alone deletes it (self-deploying tier). */
  managedByApp: boolean;
}

/** A custom domain of the install (a `domain` resource), or its wildcard domain. */
export interface CustomDomainView {
  /** The `resources` row id. */
  id: string;
  /** The hostname; for a wildcard domain, its base. */
  hostname: string;
  /** `https://<hostname>` */
  url: string;
  /** A request through it has reached the app. */
  live: boolean;
  /**
   * A wildcard domain (`wildcard_domain`): the app answers on the base and on
   * every name under it, and is shown as `*.<base>`.
   */
  wildcard: boolean;
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
  /**
   * Custom domains that serve the Worker, and its wildcard domain, in the
   * order they were added.
   */
  domains: CustomDomainView[];
  /**
   * The app needs every name under one hostname (its manifest's
   * `install.wildcardHostname`), with the catalog's reason; null otherwise.
   */
  wildcard: { reason: string } | null;
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
  /** An app of several Workers: the Workers besides the install's own; empty otherwise. */
  otherWorkers: OtherWorkerView[];
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
   * Markdown with its placeholders (`{{appUrl}}`, `{{workerName}}`) filled in, then Appflare's
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

/** An install's page; null when there is no such install. */
export async function readInstallDetail(installId: string): Promise<InstallDetail | null> {
  const db = createDb(env.DB);
  const readRow = async () =>
    (await db.select().from(installs).where(eq(installs.id, installId)).limit(1))[0];
  const readJobs = () =>
    db.select().from(jobs).where(eq(jobs.install_id, installId)).orderBy(desc(jobs.id));
  const records = listCatalogRecords(db);
  // Everything that needs only the install's id, in one round.
  const [firstRow, firstJobs, resourceRows, sub, autoUpdateDefaults, account, allNames] =
    await Promise.all([
      readRow(),
      readJobs(),
      // Everything not deleted: live resources, and those an uninstall kept.
      db
        .select()
        .from(resources)
        .where(and(eq(resources.install_id, installId), isNull(resources.deleted_at)))
        // Insertion order (created_at can tie within a millisecond).
        .orderBy(sql`rowid`),
      subdomain(),
      readAutoUpdateDefaults(db),
      accountId(),
      readInstallNames(env.DB),
      records,
    ]);
  let row = firstRow;
  let jobRows = firstJobs;
  // A job whose Workflow died outside its own code is settled, so the page
  // never waits on it forever; the install and its jobs are read again when
  // that changed them.
  const active = jobRows.filter((j) => j.status === "queued" || j.status === "running");
  if (active.length > 0 && (await reconcileJobs(env.DB, env.JOBS, active))) {
    [row, jobRows] = await Promise.all([readRow(), readJobs()]);
  }
  if (row === undefined) return null;
  const [read, heldRevision] = await Promise.all([
    // Only the install's own catalog: another catalog listing the same slug is another app.
    row.origin === "repository"
      ? Promise.resolve(null)
      : findCatalogApp(env, installAppKey(row), {}, records),
    // The revision of its release's form recorded here, if any.
    row.artifact_digest === null
      ? Promise.resolve(null)
      : readCatalogRevision(db, row.artifact_digest),
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
    workerUrl,
    appUrl: primaryUrl,
    workerName: row.worker_name,
    accountId: account,
    wildcardHostname: wildcardHostnameOf(resourceRows.filter((r) => r.retained_at === null)),
  };
  const addressDomains = resourceRows
    .filter((r) => r.retained_at === null && isAddressKind(r.kind))
    .map(addressDomainOf);
  let name = listed?.name ?? row.app_slug;
  let postInstall: string[] = [];
  let tokenPermissions: TokenPermission[] = [];
  let entryWorkers: EntryWorkerPlaceholders | undefined;
  let otherWorkers: OtherWorkerView[] = [];
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
      let recorded = heldRevision;
      if (
        row.origin === "catalog" &&
        found !== undefined &&
        row.artifact_digest !== null &&
        (await refreshInstalledRevision(env, row, found.app, found.trust, heldRevision))
      ) {
        recorded = await readCatalogRevision(db, row.artifact_digest);
      }
      const manifest = manifestWithRevision(parsed.data, recorded);
      name = manifest.catalog.name;
      // An app of several Workers: `{{appUrl:<name>}}` names one of them.
      entryWorkers = entryPlaceholderValues(manifest.catalog, row.worker_name, sub, primaryUrl);
      otherWorkers = otherWorkerViews(manifest, row.worker_name, sub);
      const entry = entryWorkers;
      postInstall = manifest.catalog.postInstall.map((p) =>
        renderPostInstall(p.content, placeholders, entry),
      );
      if (sendsEmail(combinedWorkerFacts(manifest).bindings)) postInstall.push(SEND_EMAIL_NOTE);
      // With the permissions of each Pipelines sink's token.
      tokenPermissions = appTokenPermissions(manifest.catalog);
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
  const names = namesOf(row);
  // Told apart from the other installs the way the sidebar tells them apart.
  const labels = await readInstallLabels(env.DB, [{ id: row.id, name, ...names }], allNames);
  return {
    id: row.id,
    slug: installAppKey(row),
    catalogSource: sourceOfRow(row, await catalogSources(await records)),
    origin: row.origin,
    source:
      row.origin === "catalog" || row.source_url === null || row.source_ref === null
        ? null
        : { url: row.source_url, ref: row.source_ref },
    name,
    icon: iconOf(found),
    ...names,
    label: labels.get(row.id) ?? installLabel({ displayName: row.display_name, name }),
    status: row.status,
    version: row.catalog_version,
    latestVersion: listed?.version ?? null,
    updateAvailable:
      row.status === "installed" && isUpdateAvailable(row.catalog_version, listed?.version),
    address: row.status === "installed" ? appAddress(addressInput(row, addressDomains, sub)) : null,
    workersDevEnabled: row.workers_dev_enabled,
    workersDevNote: workersDevNoteOf(row, addressDomains),
    workersDevChoice: row.workers_dev_choice,
    workersDevUrl: workerUrl,
    otherWorkers,
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
    domains: live
      .filter((r) => r.kind === CUSTOM_DOMAIN_KIND || r.kind === WILDCARD_DOMAIN_KIND)
      .map(domainView),
    wildcard: wildcardOfManifest(row.manifest_json),
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
}

/**
 * The install's settings, secret names and email zone, as the Settings
 * section shows them. Secret values are never read back.
 */
export async function readInstallPageSettings(installId: string): Promise<InstallSettings | null> {
  const orm = createDb(env.DB);
  const [[install], s] = await Promise.all([
    orm.select().from(installs).where(eq(installs.id, installId)).limit(1),
    readSettings(orm, [SETTING.accountSubdomain]),
  ]);
  // A revision of the installed release's form, listed since it was
  // installed, replaces the form below; it starts no job.
  if (install?.origin === "catalog") {
    const [listed, held] = await Promise.all([
      // From the install's own catalog, verified with that catalog's keys.
      readCachedListing(env, install.catalog_id, install.app_slug),
      install.artifact_digest === null
        ? Promise.resolve(null)
        : readCatalogRevision(orm, install.artifact_digest),
    ]);
    if (listed !== null) {
      await refreshInstalledRevision(env, install, listed.app, listed.trust, held);
    }
  }
  return readInstallSettingsCore(
    {
      db: env.DB,
      sandboxConnected: sandboxBinding(env) !== undefined,
      subdomain: s.account_subdomain || null,
    },
    installId,
    { install },
  );
}
