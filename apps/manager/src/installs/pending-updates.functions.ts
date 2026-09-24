import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { getCatalogIndex } from "../catalog/index.server";
import { managerUpdateView, readManagerLatest } from "../catalog/manager-releases.server";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import { requireSession } from "../server/auth.server";
import { type PendingUpdates, pendingUpdates } from "./pending-updates";

/**
 * Any signed-in user: the pending updates the sidebar and the home page
 * show. Reads the installs, the cached catalog index, and the cached
 * Appflare release; no Cloudflare API calls.
 */
export const getPendingUpdates = createServerFn({ method: "GET" }).handler(
  async (): Promise<PendingUpdates> => {
    await requireSession();
    const [rows, read, latest] = await Promise.all([
      createDb(env.DB)
        .select({
          id: installs.id,
          status: installs.status,
          appSlug: installs.app_slug,
          instanceName: installs.instance_name,
          workerName: installs.worker_name,
          catalogVersion: installs.catalog_version,
        })
        .from(installs)
        .where(eq(installs.status, "installed"))
        .orderBy(desc(installs.installed_at)),
      getCatalogIndex(env),
      readManagerLatest(env.KV),
    ]);
    const versions = new Map(read.ok ? read.index.apps.map((a) => [a.slug, a.version]) : []);
    const manager = managerUpdateView(env.APPFLARE_VERSION, latest);
    return pendingUpdates(rows, versions, {
      current: manager.current,
      latest: manager.latest?.version ?? null,
      updateAvailable: manager.updateAvailable,
    });
  },
);
