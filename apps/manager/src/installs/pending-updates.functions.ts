import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { managerUpdateView, readManagerLatest } from "../catalog/manager-releases.server";
import { catalogLookup } from "../catalog/merged.server";
import { installAppKey } from "../catalog/sources";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import { activeSelfUpdateJob } from "../jobs/self-update/guard";
import { requireSession } from "../server/auth.server";
import { type LayoutData, pendingUpdates } from "./pending-updates";
import { countRemovedAppsCore } from "./removed-apps.server";

/**
 * Any signed-in user: the pending app updates the sidebar and the home page
 * show, Appflare's own version for the sidebar's Appflare card, and how many
 * removed apps there are for the settings menu. Reads the installs, the
 * cached catalog index, the cached Appflare release, and the self-update in
 * progress; no Cloudflare API calls.
 */
export const getPendingUpdates = createServerFn({ method: "GET" }).handler(
  async (): Promise<LayoutData> => {
    await requireSession();
    const [rows, listed, latest, activeJobId, removedApps] = await Promise.all([
      createDb(env.DB)
        .select({
          id: installs.id,
          status: installs.status,
          appSlug: installs.app_slug,
          catalogId: installs.catalog_id,
          displayName: installs.display_name,
          workerName: installs.worker_name,
          catalogVersion: installs.catalog_version,
        })
        .from(installs)
        .where(eq(installs.status, "installed"))
        .orderBy(desc(installs.installed_at)),
      catalogLookup(env),
      readManagerLatest(env.KV),
      activeSelfUpdateJob(env.DB, env.JOBS),
      countRemovedAppsCore(env.DB),
    ]);
    const versions = new Map([...listed].map(([key, l]) => [key, l.app.version]));
    const manager = managerUpdateView(env.APPFLARE_VERSION, latest);
    // Each install is compared with its own catalog only (by app key).
    const keyed = rows.map(({ catalogId, ...row }) => ({
      ...row,
      appSlug: installAppKey({ app_slug: row.appSlug, catalog_id: catalogId }),
    }));
    const pending = pendingUpdates(keyed, versions, {
      current: manager.current,
      latest: manager.latest?.version ?? null,
      updateAvailable: manager.updateAvailable,
      activeJobId,
    });
    return { ...pending, removedApps };
  },
);
