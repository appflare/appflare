import { createDb } from "../db/client";
import { listCatalogRecords } from "./catalogs.server";
import type { CatalogOptions } from "./index.server";
import { type MergedEnv, refreshCustomCatalog, refreshOfficialCatalog } from "./merged.server";

/**
 * The cron's catalog refresh: every enabled catalog, one after the other,
 * one conditional fetch each (`If-None-Match`, so an unchanged index costs
 * a `304`); the official catalog then reads the stats file its index names.
 * A catalog that is turned off is not fetched. One catalog failing, for
 * whatever reason, never stops the others; each outcome is recorded on its
 * row and returned for the log. Custom catalogs are few (`MAX_CUSTOM_CATALOGS`), which keeps the
 * run within its subrequest budget.
 */

export type RefreshLine =
  | { id: string; ok: true; apps: number }
  | { id: string; ok: false; error: string };

export async function refreshEnabledCatalogs(
  env: MergedEnv,
  opts: CatalogOptions = {},
): Promise<RefreshLine[]> {
  const records = (await listCatalogRecords(createDb(env.DB))).filter((r) => r.enabled);
  const lines: RefreshLine[] = [];
  for (const record of records) {
    try {
      const { index } =
        record.kind === "official"
          ? await refreshOfficialCatalog(env, opts)
          : await refreshCustomCatalog(env, record, opts);
      lines.push({ id: record.id, ok: true, apps: index.apps.length });
    } catch (error) {
      // Anything (its site, KV, D1): that catalog's failure, never the run's.
      lines.push({
        id: record.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return lines;
}
