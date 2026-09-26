import { env } from "cloudflare:workers";
import type { IndexApp } from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { getAppManifest, getCatalogManifest } from "../catalog/app-manifest.server";
import { findCatalogApp, type ListedApp } from "../catalog/merged.server";
import { getCfClient } from "../cloudflare/client.server";
import { sandboxBinding } from "../sandbox/binding";
import { requireRole, requireSession } from "../server/auth.server";
import {
  listSnapshotsCore,
  type RestoreDatabaseResult,
  restoreDatabaseCore,
  type SnapshotView,
  type StartUpdateResult,
  startRollbackCore,
  startUpdateCore,
  VersionActionError,
} from "./versions.server";
import {
  installIdInput,
  restoreDatabaseInput,
  startRollbackInput,
  startUpdateInput,
} from "./versions-input";

/** Updates, rollbacks, snapshots, and database restores of an install. */

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof VersionActionError) throw new Error(error.message);
    throw error;
  }
}

/**
 * Admin only. Starts an update to the catalog's current version when it is
 * newer than the installed one; returns the job id for `/jobs/$jobId`, or
 * the secrets and confirmation the update needs first.
 */
export const startUpdate = createServerFn({ method: "POST" })
  .validator(startUpdateInput)
  .handler(async ({ data }): Promise<StartUpdateResult> => {
    await requireRole("admin");
    // The listing `loadApp` found: its catalog's keys verify the new version.
    let found: ListedApp | null = null;
    const trustOf = (app: IndexApp) => {
      if (found?.app !== app) {
        throw new VersionActionError(
          "The app's catalog listing was not loaded before its manifest.",
        );
      }
      return found.trust;
    };
    return asUserError(() =>
      startUpdateCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          async loadApp(key) {
            const read = await findCatalogApp(env, key);
            if (!read.ok) throw new VersionActionError(read.error);
            found = read.listed;
            return found?.app ?? null;
          },
          async loadManifest(app) {
            const read = await getAppManifest(env, app, trustOf(app));
            if (!read.ok) throw new VersionActionError(read.error);
            return read.manifest;
          },
          async loadCatalog(app) {
            const read = await getCatalogManifest(env, app, trustOf(app));
            if (!read.ok) throw new VersionActionError(read.error);
            return read.catalog;
          },
          sandboxConnected: sandboxBinding(env) !== undefined,
          createJob: (id, params) => env.JOBS.create({ id, params }),
        },
        data,
      ),
    );
  });

/** Admin only. Redeploys the Worker version a snapshot recorded; D1 is not touched. */
export const startRollback = createServerFn({ method: "POST" })
  .validator(startRollbackInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return asUserError(() =>
      startRollbackCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          createJob: (id, params) => env.JOBS.create({ id, params }),
        },
        data,
      ),
    );
  });

/**
 * Admin only. Restores one D1 database to the bookmark a snapshot took. The
 * result carries the bookmark from just before the restore, which undoes it.
 */
export const restoreDatabase = createServerFn({ method: "POST" })
  .validator(restoreDatabaseInput)
  .handler(async ({ data }): Promise<RestoreDatabaseResult> => {
    await requireRole("admin");
    return asUserError(() =>
      restoreDatabaseCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          async restore(databaseId, bookmark, onRequest) {
            const api = await getCfClient(env, { onRequest });
            return api.d1.restore(databaseId, { bookmark });
          },
        },
        data,
      ),
    );
  });

/**
 * Any signed-in user: the install's snapshots, newest first. Only admins get
 * the Time Travel bookmarks; members see the history read-only.
 */
export const listSnapshots = createServerFn({ method: "GET" })
  .validator(installIdInput)
  .handler(async ({ data }): Promise<SnapshotView[]> => {
    const session = await requireSession();
    return listSnapshotsCore(env.DB, data.installId, {
      withBookmarks: hasRole(session.user.role, "admin"),
    });
  });
