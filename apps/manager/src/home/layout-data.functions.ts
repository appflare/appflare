import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { type InstallOfApp, installedNeeds } from "../capabilities/capability-rows";
import { readCapabilityRowsData } from "../capabilities/capability-rows.server";
import { listCatalogRecords } from "../catalog/catalogs.server";
import { managerUpdateView, readManagerLatest } from "../catalog/manager-releases.server";
import { listedApps, readEnabledCatalogs } from "../catalog/merged.server";
import { appKey } from "../catalog/sources";
import { createDb } from "../db/client";
import { ensureMigrated, schemaDowngrade } from "../db/migrate";
import { deployButtonInstalled } from "../deploy-button/deploy-copy";
import { readDeployCopyCleanup } from "../deploy-button/deploy-copy.server";
import {
  type InstallRecord,
  listInstallRows,
  readInstallRecords,
} from "../installs/install-rows.server";
import { countRemovedAppsCore } from "../installs/removed-apps.server";
import { activeSelfUpdateJob } from "../jobs/self-update/guard";
import { requireSession } from "../server/auth.server";
import { runningVersion } from "../server/build-version";
import { accountAttentionRows } from "./account-attention";
import type { Downgrade } from "./attention";
import { readFailedJobs, readUpdateNeeds } from "./attention.server";
import type { LayoutData } from "./layout-data";

/** What the account's rows read of a stored install. */
function installOfApp(row: InstallRecord): InstallOfApp {
  return { appSlug: row.app_slug, catalogId: row.catalog_id, origin: row.origin };
}

/**
 * Any signed-in user: what every signed-in page shows around itself (see
 * `LayoutData`). Reads D1, KV and the cached catalog indexes, each once; no
 * Cloudflare API calls. The catalogs and the installs are read first and
 * shared by everything after them. What only admins act on (why an update
 * waits, the account's rows, the deploy-copy cleanup) is read for admins
 * only. D1 queries: 7 for a member, 10 to 13 for an admin (see the steps).
 */
export const getLayoutData = createServerFn({ method: "GET" }).handler(
  async (): Promise<LayoutData> => {
    const session = await requireSession();
    const isAdmin = hasRole(session.user.role, "admin");
    const db = createDb(env.DB);
    // Everyone: catalogs, installs, failed jobs, the self-update running, removed apps (5).
    const [records, rows, failedJobs, latest, activeJobId, removedApps, deployCopy, migrated] =
      await Promise.all([
        listCatalogRecords(db),
        readInstallRecords(db),
        readFailedJobs(env.DB),
        readManagerLatest(env.KV),
        activeSelfUpdateJob(env.DB, env.JOBS),
        countRemovedAppsCore(env.DB),
        // Admins of a manager the button deployed: one settings read.
        readDeployCopyCleanup(env, isAdmin),
        // Cached after the isolate's first request: no D1 read here.
        ensureMigrated(env),
      ]);
    const reads = await readEnabledCatalogs(env, {}, records);
    const listed = new Map(listedApps(reads).map((l) => [l.key, l]));
    const installOfApps = rows.map(installOfApp);
    const [installs, needs, capabilities] = await Promise.all([
      // Everyone: the subdomain and the installs' domains (2, 1 with no installs).
      listInstallRows(rows, listed, records),
      // Admins: the failed and rolled-back updates (2), only while an update exists.
      isAdmin ? readUpdateNeeds(env.DB, rows, listed) : new Map<string, string>(),
      // Admins: the stored capabilities and the sandbox jobs (3).
      isAdmin ? readCapabilityRowsData(env, db, { reads, installs: installOfApps }) : null,
    ]);
    const manager = managerUpdateView(env.APPFLARE_VERSION, latest);
    const downgraded = schemaDowngrade(migrated.schemaVersion);
    const downgrade: Downgrade | null =
      downgraded === null
        ? null
        : { version: runningVersion(env), deployButton: deployButtonInstalled(env) };
    return {
      manager: {
        current: manager.current,
        latest: manager.latest?.version ?? null,
        updateAvailable: manager.updateAvailable,
        activeJobId,
      },
      removedApps,
      apps: installs.map((row) => ({ ...row, updateNeeds: needs.get(row.id) ?? null })),
      failedJobs,
      accountRows:
        capabilities === null
          ? []
          : accountAttentionRows(
              capabilities,
              // What each install needs on its own, so "Not needed" knows which apps it covers.
              rows.map((row) => ({
                id: row.id,
                needs: installedNeeds(
                  [installOfApp(row)],
                  (it) => listed.get(appKey(it.catalogId, it.appSlug))?.app,
                ),
              })),
            ),
      deployCopy,
      downgrade,
    };
  },
);
