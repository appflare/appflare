import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { refreshInstalledRevision } from "../catalog/app-manifest.server";
import { readCachedCatalogApp } from "../catalog/index.server";
import { createDb } from "../db/client";
import { installs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { sandboxBinding } from "../sandbox/binding";
import { requireRole, requireSession } from "../server/auth.server";
import {
  type InstallSettings,
  readInstallSettingsCore,
  startReconfigureCore,
} from "./reconfigure.server";
import { startReconfigureInput } from "./reconfigure-input";
import { VersionActionError } from "./versions.server";
import { installIdInput } from "./versions-input";

/** The Settings section of an install: read it, and save and redeploy. */

/**
 * Any signed-in user: the install's settings, secret names and email zone,
 * as the Settings section shows them. Secret values are never read back.
 */
export const getInstallSettings = createServerFn({ method: "GET" })
  .validator(installIdInput)
  .handler(async ({ data }): Promise<InstallSettings | null> => {
    await requireSession();
    const orm = createDb(env.DB);
    const [install] = await orm
      .select({
        slug: installs.app_slug,
        origin: installs.origin,
        catalog_version: installs.catalog_version,
        artifact_digest: installs.artifact_digest,
      })
      .from(installs)
      .where(eq(installs.id, data.installId))
      .limit(1);
    // A revision of the installed release's form, listed since it was
    // installed, replaces the form below; it starts no job.
    if (install?.origin === "catalog") {
      await refreshInstalledRevision(
        env,
        install,
        await readCachedCatalogApp(env.KV, install.slug),
      );
    }
    const s = await readSettings(orm, [SETTING.accountSubdomain]);
    return readInstallSettingsCore(
      {
        db: env.DB,
        sandboxConnected: sandboxBinding(env) !== undefined,
        subdomain: s.account_subdomain || null,
      },
      data.installId,
    );
  });

/**
 * Admin only. Starts the job that saves the new settings and secrets and
 * redeploys the installed version with them; returns its id for `/jobs/$jobId`.
 */
export const startReconfigure = createServerFn({ method: "POST" })
  .validator(startReconfigureInput)
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    await requireRole("admin");
    try {
      return await startReconfigureCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          sandboxConnected: sandboxBinding(env) !== undefined,
          createJob: (id, params) => env.JOBS.create({ id, params }),
        },
        data,
      );
    } catch (error) {
      if (error instanceof VersionActionError) throw new Error(error.message);
      throw error;
    }
  });
