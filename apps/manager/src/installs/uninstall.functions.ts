import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, isNull } from "drizzle-orm";
import { getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { resources } from "../db/schema";
import { requireRole } from "../server/auth.server";
import { isDataResourceKind } from "./resource-kinds";
import { type ResourceUsage, readResourceUsage } from "./resource-usage.server";
import {
  StartUninstallError,
  type StartUninstallRequest,
  startUninstallCore,
} from "./start-uninstall.server";
import { installIdInput, retryUninstallInput, startUninstallInput } from "./uninstall-input";

/** Uninstalling: start one, retry an unfinished one, and read what data resources hold. */

async function start(request: StartUninstallRequest): Promise<{ jobId: string }> {
  try {
    return await startUninstallCore(
      { db: env.DB, createJob: (id, params) => env.JOBS.create({ id, params }) },
      request,
    );
  } catch (error) {
    if (error instanceof StartUninstallError) throw new Error(error.message);
    throw error;
  }
}

/** Admin only. Returns the job id; the UI navigates to `/jobs/$jobId`. */
export const startUninstall = createServerFn({ method: "POST" })
  .validator(startUninstallInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return start({ installId: data.installId, deleteResources: data.deleteResources });
  });

/**
 * Admin only. Re-runs an uninstall that stopped part way, for what is neither
 * deleted nor kept; resources left out of `deleteResources` are kept.
 */
export const retryUninstall = createServerFn({ method: "POST" })
  .validator(retryUninstallInput)
  .handler(async ({ data }) => {
    await requireRole("admin");
    return start({ installId: data.installId, retry: true, deleteResources: data.deleteResources });
  });

/**
 * Admin only (it calls the Cloudflare API): KV key counts and D1 sizes of the
 * install's data resources, for the uninstall dialog. Empty when the API is
 * not reachable.
 */
export const getResourceUsage = createServerFn({ method: "GET" })
  .validator(installIdInput)
  .handler(async ({ data }): Promise<ResourceUsage[]> => {
    await requireRole("admin");
    const rows = await createDb(env.DB)
      .select({ id: resources.id, kind: resources.kind, cfId: resources.cf_id })
      .from(resources)
      .where(
        and(
          eq(resources.install_id, data.installId),
          isNull(resources.deleted_at),
          isNull(resources.retained_at),
        ),
      );
    const measured = rows.filter((r) => isDataResourceKind(r.kind));
    if (measured.length === 0) return [];
    try {
      return await readResourceUsage(await getCfClient(env), measured);
    } catch {
      return [];
    }
  });
