import { createDb } from "../db/client";
import { type CatalogRecord, listCatalogRecords } from "./catalogs.server";
import type { CatalogOptions } from "./index.server";
import { type InstallLinkTarget, installLinkKey } from "./install-intent";
import {
  type MergedEnv,
  readEnabledCatalogs,
  refreshCustomCatalog,
  refreshOfficialCatalog,
} from "./merged.server";
import { appKey, OFFICIAL_CATALOG_ID, parseAppKey } from "./sources";

/**
 * Where `/install/<slug>` goes. Reads the enabled catalogs; only reads: an
 * install link never starts a job. A plain slug is looked up in the official
 * catalog first, then in the added ones; `<catalog>:<slug>` in that catalog
 * alone. When no enabled catalog lists it and an admin followed the link,
 * each enabled catalog is fetched once more (a conditional fetch, so an
 * unchanged index costs a 304) in case the app was published a moment ago;
 * a member's link reads only what is cached, so members cannot make the
 * manager fetch on demand. When the catalog that would list it cannot be
 * read at all, the app's page opens anyway and says why.
 */
export async function findInstallLinkTarget(
  env: MergedEnv,
  raw: string,
  viewer: { isAdmin: boolean },
  opts: CatalogOptions = {},
): Promise<InstallLinkTarget> {
  const records = await listCatalogRecords(createDb(env.DB));
  const officialOff = records.some((r) => r.kind === "official" && !r.enabled);
  const link = installLinkKey(raw);
  if (link === null) return { found: false, officialOff };

  const reads = await readEnabledCatalogs(env, { ...opts, refreshOnMiss: true }, records);
  const cached = matchKey(
    reads.flatMap((r) => (r.ok ? r.index.apps.map((app) => ({ id: r.source.id, app })) : [])),
    link,
  );
  if (cached !== null) return { found: true, key: cached };
  const named = link.plain ? OFFICIAL_CATALOG_ID : parseAppKey(link.key).catalogId;

  if (!viewer.isAdmin) {
    const unread = reads.some((r) => !r.ok && r.source.id === named);
    return unread ? { found: true, key: link.key } : { found: false, officialOff };
  }
  const fresh = await refreshEnabled(env, records, opts);
  const key = matchKey(fresh.apps, link);
  if (key !== null) return { found: true, key };
  if (fresh.failed.includes(named)) return { found: true, key: link.key };
  return { found: false, officialOff };
}

interface CatalogApp {
  /** The catalog's id. */
  id: string;
  app: { slug: string };
}

/** The first app the link names, in catalog order (the official catalog first). */
function matchKey(
  apps: readonly CatalogApp[],
  link: { key: string; plain: boolean },
): string | null {
  const hit = apps.find(({ id, app }) =>
    link.plain ? app.slug === link.key : appKey(id, app.slug) === link.key,
  );
  return hit === undefined ? null : appKey(hit.id, hit.app.slug);
}

/** Every enabled catalog fetched again, one after the other; a failure is that catalog's alone. */
async function refreshEnabled(
  env: MergedEnv,
  records: readonly CatalogRecord[],
  opts: CatalogOptions,
): Promise<{ apps: CatalogApp[]; failed: string[] }> {
  const apps: CatalogApp[] = [];
  const failed: string[] = [];
  for (const record of records.filter((r) => r.enabled)) {
    try {
      const { index } =
        record.kind === "official"
          ? await refreshOfficialCatalog(env, opts)
          : await refreshCustomCatalog(env, record, opts);
      for (const app of index.apps) apps.push({ id: record.id, app });
    } catch (error) {
      console.warn("catalog could not be fetched for an install link", {
        catalog: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
      failed.push(record.id);
    }
  }
  return { apps, failed };
}
