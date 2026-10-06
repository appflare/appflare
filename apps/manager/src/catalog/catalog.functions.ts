import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { invalidateScriptsCache } from "../cloudflare/scripts-cache.server";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import { type CatalogDetail, readCatalogEntry } from "./catalog-entry.server";
import { type CatalogList, readCatalogList } from "./catalog-list.server";
import { listCatalogRecords } from "./catalogs.server";
import { dismissFeaturedItem } from "./featured.server";
import { CatalogError } from "./index.server";
import { refreshCustomCatalog, refreshOfficialCatalog } from "./merged.server";

export type { CatalogDetail, InstalledRef } from "./catalog-entry.server";
export type { CatalogList, CatalogListItem } from "./catalog-list.server";

/** Any signed-in user. */
export const listCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogList> => readCatalogList(await requireSession()),
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
