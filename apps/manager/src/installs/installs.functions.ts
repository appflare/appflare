import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { InstallAccessView } from "../access/app-access";
import { readInstallAccessView } from "../access/app-access.server";
import { accessCapabilityProblem } from "../access/preflight.server";
import { hasRole } from "../auth/roles";
import { getCatalogManifest } from "../catalog/app-manifest.server";
import { findCatalogApp } from "../catalog/merged.server";
import { getCfClient } from "../cloudflare/client.server";
import { jobCreator } from "../jobs/create-job.server";
import { sandboxAutoEnableDeps } from "../sandbox/auto-enable-env.server";
import { sandboxBinding } from "../sandbox/binding";
import { readSandboxConnection } from "../sandbox/connection.server";
import { requireRole, requireSession } from "../server/auth.server";
import { displayNameInput } from "./display-name";
import { RenameInstallError, renameInstallCore } from "./display-name.server";
import {
  type InstallDetail,
  readInstallDetail,
  readInstallPageSettings,
} from "./install-detail.server";
import { startInstallInput } from "./install-input";
import type { InstallSettings } from "./reconfigure.server";
import { catalogOnlyManifest, StartInstallError, startInstallCore } from "./start-install.server";
import { listSnapshotsCore, type SnapshotView } from "./versions.server";
import { installIdInput } from "./versions-input";

export type { CustomDomainView, InstallDetail, ResourceView } from "./install-detail.server";
export type { InstallRow } from "./install-rows.server";

/** Installs: start one (admin) and show one. Home lists them (`getLayoutData`); uninstall lives in `uninstall.functions.ts`. */

/** Admin only. Returns ids; the UI navigates to `/jobs/$jobId`. */
export const startInstall = createServerFn({ method: "POST" })
  .validator(startInstallInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    try {
      const binding = sandboxBinding(env);
      return await startInstallCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          async loadApp(key) {
            const read = await findCatalogApp(env, key);
            if (!read.ok) throw new StartInstallError(read.error);
            if (read.listed === null) {
              throw new StartInstallError(`"${key}" is not in any catalog that is turned on.`);
            }
            const { app, trust } = read.listed;
            // Verified with the keys of the catalog that lists it, and no others.
            const entry = await getCatalogManifest(env, app, trust);
            if (!entry.ok) throw new StartInstallError(entry.error);
            return {
              app,
              catalogId: trust.catalogId,
              manifest: entry.manifest ?? catalogOnlyManifest(entry.catalog),
            };
          },
          createJob: jobCreator(env.JOBS),
          sandboxConnected: async () => (await readSandboxConnection(env)).connected,
          sandboxAutoEnable: sandboxAutoEnableDeps(env),
          ...(binding === undefined
            ? {}
            : {
                cleanupBuilds: async (target) => {
                  await binding.cleanup(target);
                },
              }),
          async listAccountWorkers() {
            const api = await getCfClient(env);
            return (await api.workers.listScripts()).map((s) => s.id);
          },
          accessPreflight: async () => accessCapabilityProblem(await getCfClient(env), env.DB),
        },
        data,
      );
    } catch (error) {
      if (error instanceof StartInstallError) throw new Error(error.message);
      throw error;
    }
  });

/**
 * Admin only: sets the install's display name, or clears it with an empty
 * name so the Worker name shows again. Nothing is deployed.
 */
export const renameInstall = createServerFn({ method: "POST" })
  .validator(z.object({ installId: z.string().min(1).max(64), displayName: displayNameInput }))
  .handler(async ({ data }) => {
    await requireRole("admin");
    try {
      return await renameInstallCore(env.DB, data.installId, data.displayName);
    } catch (error) {
      if (error instanceof RenameInstallError) throw new Error(error.message);
      throw error;
    }
  });

/** What `/apps/$installId` shows: the install, its snapshots, its settings and its Cloudflare Access protection. */
export interface InstallPage {
  /** Null when there is no such install. */
  install: InstallDetail | null;
  snapshots: SnapshotView[];
  settings: InstallSettings | null;
  /** Null for an app Appflare cannot protect, and for one that is gone. */
  access: InstallAccessView | null;
}

/**
 * Any signed-in user: an install's page in one request, with one session
 * check. Only admins get the snapshots' Time Travel bookmarks; members see
 * the history read-only.
 */
export const getInstallPage = createServerFn({ method: "GET" })
  .validator(installIdInput)
  .handler(async ({ data }): Promise<InstallPage> => {
    const session = await requireSession();
    const [install, snapshots, settings, access] = await Promise.all([
      readInstallDetail(data.installId),
      listSnapshotsCore(env.DB, data.installId, {
        withBookmarks: hasRole(session.user.role, "admin"),
      }),
      readInstallPageSettings(data.installId),
      readInstallAccessView(env.DB, data.installId),
    ]);
    return { install, snapshots, settings, access };
  });
