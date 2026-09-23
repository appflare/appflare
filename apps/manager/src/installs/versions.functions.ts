import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { getAppManifest } from "../catalog/app-manifest.server";
import { getCatalogApp } from "../catalog/index.server";
import { getCfClient } from "../cloudflare/client.server";
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
    return asUserError(() =>
      startUpdateCore(
        {
          db: env.DB,
          async loadApp(slug) {
            const read = await getCatalogApp(env, slug);
            if (!read.ok) throw new VersionActionError(read.error);
            return read.app;
          },
          async loadManifest(app) {
            const read = await getAppManifest(env, app);
            if (!read.ok) throw new VersionActionError(read.error);
            return read.manifest;
          },
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
        { db: env.DB, createJob: (id, params) => env.JOBS.create({ id, params }) },
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
