import { env } from "cloudflare:workers";
import { desc, ne } from "drizzle-orm";
import { type CatalogRecord, listCatalogRecords, sourceOf } from "../catalog/catalogs.server";
import { catalogIndexUrl } from "../catalog/index.server";
import { mediaSrc } from "../catalog/media";
import type { AppLookup, ListedApp } from "../catalog/merged.server";
import { type CatalogSource, installAppKey, OFFICIAL_CATALOG_ID } from "../catalog/sources";
import { createDb, type Database } from "../db/client";
import { type HealthStatus, type InstallOrigin, installs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { healthBehindAccess } from "../jobs/install/health";
import { type AddressDomain, type AppAddressInput, appAddress } from "./app-address";
import { readAddressDomains } from "./app-address.server";
import { distinctLabels } from "./display-name";
import { recordedName } from "./install-names.server";
import { updateOffer } from "./tier-change";

/**
 * The installs as lists show them (Home, the sidebar's apps), and the row
 * fields the app page shares with them. Server only.
 */

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
  /**
   * What lists call the install (`distinctLabels`): its display name, else
   * the app's name, with its Worker name added when another install reads
   * the same. Home, which never shows Worker names, uses `installLabel`.
   */
  label: string;
  workerName: string;
  status: string;
  version: string;
  latestVersion: string | null;
  /** The catalog lists a newer version that Update can start. */
  updateAvailable: boolean;
  /**
   * The catalog lists a newer version, but its entry changed how it is
   * installed, so it is uninstalled and installed again instead
   * (tier-change.ts); never with `updateAvailable`.
   */
  reinstallNeeded: boolean;
  /** Where "Open" takes the app (`appAddress`); null until installed, or with no address. */
  address: string | null;
  /** ISO 8601 */
  updatedAt: string;
  /** ISO 8601; null until the install is uninstalled. */
  uninstalledAt: string | null;
  /** The last health check of the Worker's URL; null until one ran. */
  healthStatus: HealthStatus | null;
  /**
   * Cloudflare Access answered that check in the app's place (`unverified`),
   * so it says nothing about the app either way.
   */
  healthAccess: boolean;
  /** ISO 8601; when that check ran. */
  healthCheckedAt: string | null;
}

/** The name fields of an install row, for the list and the detail page (the label comes apart). */
export function namesOf(row: typeof installs.$inferSelect) {
  return { displayName: row.display_name, workerName: row.worker_name };
}

/** What `appAddress` needs of an install row. */
export function addressInput(
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

/** The health fields of an install row, for the list and the detail page. */
export function healthOf(row: typeof installs.$inferSelect) {
  return {
    healthStatus: row.health_status,
    healthAccess: healthBehindAccess(row.health_status, row.health_access),
    healthCheckedAt: row.health_checked_at?.toISOString() ?? null,
  };
}

/**
 * The badge of every catalog, by id (the ones turned off too: an install
 * keeps its source). `records` are the catalogs when the caller read them
 * already.
 */
export async function catalogSources(
  records?: readonly CatalogRecord[],
): Promise<Map<string, CatalogSource>> {
  const all = records ?? (await listCatalogRecords(createDb(env.DB)));
  return new Map(all.map((r) => [r.id, sourceOf(r)]));
}

export function sourceOfRow(
  row: Pick<typeof installs.$inferSelect, "catalog_id" | "origin">,
  sources: ReadonlyMap<string, CatalogSource>,
): CatalogSource | null {
  if (row.origin === "repository") return null;
  return sources.get(row.catalog_id ?? OFFICIAL_CATALOG_ID) ?? null;
}

/** The app's icon, served by the manager for the official catalog only (others show a monogram). */
export function iconOf(found: ListedApp | undefined): string | null {
  if (found === undefined || !found.source.official) return null;
  return mediaSrc(found.app.media?.icon, catalogIndexUrl(env));
}

export async function subdomain(): Promise<string | null> {
  const s = await readSettings(createDb(env.DB), [SETTING.accountSubdomain]);
  return s.account_subdomain || null;
}

export type InstallRecord = typeof installs.$inferSelect;

/** Every install that is not uninstalled, newest first, as stored. */
export function readInstallRecords(db: Database): Promise<InstallRecord[]> {
  return db
    .select()
    .from(installs)
    .where(ne(installs.status, "uninstalled"))
    .orderBy(desc(installs.installed_at));
}

/** Where installs are reached: the account's workers.dev subdomain and every install's domains. */
export interface InstallAddresses {
  sub: string | null;
  domains: Map<string, AddressDomain[]>;
}

/**
 * The account's workers.dev subdomain and the installs' domains, read
 * together. Needs nothing else, so it goes alongside the installs' own read.
 */
export async function readInstallAddresses(db: Database): Promise<InstallAddresses> {
  const [sub, domains] = await Promise.all([subdomain(), readAddressDomains(db)]);
  return { sub, domains };
}

/**
 * The installs as lists show them, from their stored records (see
 * `readInstallRecords`), the enabled catalogs' apps, every catalog's record
 * and the installs' addresses (`readInstallAddresses`), all read by the
 * caller.
 */
export function installRowsOf(
  rows: readonly InstallRecord[],
  lookup: AppLookup,
  records: readonly CatalogRecord[],
  { sub, domains }: InstallAddresses,
): InstallRow[] {
  const sources = new Map(records.map((r) => [r.id, sourceOf(r)]));
  const addressOf = (row: InstallRecord): string | null =>
    appAddress(addressInput(row, domains.get(row.id) ?? [], sub));
  const listedRows = rows.map((row): Omit<InstallRow, "label"> => {
    // An install from a repository is never the catalog's app of the same name,
    // and an install is only ever compared with its own catalog's listing.
    const found = row.origin === "repository" ? undefined : lookup.get(installAppKey(row));
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
      ...updateOffer(row, listed),
      address: row.status === "installed" ? addressOf(row) : null,
      updatedAt: row.updated_at.toISOString(),
      uninstalledAt: row.uninstalled_at?.toISOString() ?? null,
      ...healthOf(row),
    };
  });
  const labels = distinctLabels(listedRows);
  return listedRows.map((row) => ({ ...row, label: labels.get(row.id) ?? row.name }));
}
