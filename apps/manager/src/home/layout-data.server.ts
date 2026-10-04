import { env, waitUntil } from "cloudflare:workers";
import { protectedInstallIds } from "../access/install-access.server";
import { requiredButUnprotected } from "../access/stored-access.server";
import type { AuthSession } from "../auth/guards";
import { hasRole } from "../auth/roles";
import { type InstallOfApp, installedNeeds } from "../capabilities/capability-rows";
import { readCapabilityRowsData } from "../capabilities/capability-rows.server";
import { listCatalogRecords } from "../catalog/catalogs.server";
import { managerUpdateView, readManagerLatest } from "../catalog/manager-releases.server";
import {
  listedApps,
  readEnabledCatalogs,
  refreshMissingInBackground,
} from "../catalog/merged.server";
import { appKey } from "../catalog/sources";
import { createDb } from "../db/client";
import { ensureMigrated, schemaDowngrade } from "../db/migrate";
import { deployButtonInstalled } from "../deploy-button/deploy-copy";
import { readDeployCopyCleanup } from "../deploy-button/deploy-copy.server";
import {
  type InstallRecord,
  installRowsOf,
  readInstallAddresses,
  readInstallRecords,
} from "../installs/install-rows.server";
import { countRemovedAppsCore } from "../installs/removed-apps.server";
import { activeSelfUpdateJob } from "../jobs/self-update/guard";
import { runningVersion } from "../server/build-version";
import { accountAttentionRows } from "./account-attention";
import type { Downgrade } from "./attention";
import { readFailedJobs, readUpdateNeeds } from "./attention.server";
import type { LayoutData } from "./layout-data";

/** What the account's rows read of a stored install; `protectedIds` are those Appflare protects. */
function installOfApp(row: InstallRecord, protectedIds: ReadonlySet<string>): InstallOfApp {
  return {
    appSlug: row.app_slug,
    catalogId: row.catalog_id,
    origin: row.origin,
    accessProtected: protectedIds.has(row.id),
  };
}

/**
 * Any signed-in user: what every signed-in page shows around itself (see
 * `LayoutData`). Reads D1, KV and the cached catalog indexes, each once; no
 * Cloudflare API calls, and no catalog fetched before answering (the cron
 * keeps the indexes cached; one that is missing is fetched after the answer). Everything is read in
 * one round: the catalogs' records with their cached indexes (the official
 * one's alongside the records), the installs with their addresses, the jobs
 * and counts, and for admins the account's rows, which take the indexes and
 * installs as they arrive. Only why an update waits (admins, while an update
 * exists) needs the indexes first, and takes a second round. What only
 * admins act on is read for admins only.
 */
export async function readLayoutData(session: AuthSession): Promise<LayoutData> {
  const isAdmin = hasRole(session.user.role, "admin");
  const db = createDb(env.DB);
  const recordsRead = listCatalogRecords(db);
  const rowsRead = readInstallRecords(db);
  const readsRead = readEnabledCatalogs(env, { refreshOnMiss: false }, recordsRead);
  // Admins: the installs Appflare protects, which need Zero Trust whatever their entry says.
  const protectedRead = isAdmin ? protectedInstallIds(env.DB) : Promise.resolve(new Set<string>());
  // Installs whose entry now requires protection while they are not protected (one query).
  const requiredRead = requiredButUnprotected(env.DB);
  const [
    records,
    rows,
    reads,
    addresses,
    capabilities,
    failedJobs,
    latest,
    activeJobId,
    removedApps,
    deployCopy,
    migrated,
  ] = await Promise.all([
    recordsRead,
    rowsRead,
    readsRead,
    // The subdomain and every install's domains.
    readInstallAddresses(db),
    // Admins: the stored capabilities and the sandbox jobs.
    isAdmin
      ? readCapabilityRowsData(env, db, {
          reads: readsRead,
          installs: Promise.all([rowsRead, protectedRead]).then(([r, ids]) =>
            r.map((row) => installOfApp(row, ids)),
          ),
        })
      : null,
    readFailedJobs(env.DB),
    readManagerLatest(env.KV),
    activeSelfUpdateJob(env.DB, env.JOBS),
    countRemovedAppsCore(env.DB),
    // Admins of a manager the button deployed: one settings read.
    readDeployCopyCleanup(env, isAdmin),
    // Cached after the isolate's first request: no D1 read here.
    ensureMigrated(env),
  ]);
  // A catalog not cached yet (a new manager before its first cron run) is
  // fetched after the answer, so the next page shows its icons and updates.
  refreshMissingInBackground(env, reads, records, waitUntil);
  const listed = new Map(listedApps(reads).map((l) => [l.key, l]));
  const installs = installRowsOf(rows, listed, records, addresses);
  // Admins: the failed and rolled-back updates (2 queries), only while an update exists.
  const needs = isAdmin ? await readUpdateNeeds(env.DB, rows, listed) : new Map<string, string>();
  const [protectedIds, accessRequired] = await Promise.all([protectedRead, requiredRead]);
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
    apps: installs.map((row) => ({
      ...row,
      updateNeeds: needs.get(row.id) ?? null,
      accessRequired: accessRequired.has(row.id),
    })),
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
                [installOfApp(row, protectedIds)],
                (it) => listed.get(appKey(it.catalogId, it.appSlug))?.app,
              ),
            })),
          ),
    deployCopy,
    downgrade,
  };
}
