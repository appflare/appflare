import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { getCatalogIndex } from "../catalog/index.server";
import { createDb } from "../db/client";
import { installs, jobs } from "../db/schema";
import { reconcileJobs } from "../jobs/reconcile.server";
import { requireRole, requireSession } from "../server/auth.server";
import {
  deleteRetainedDataAs,
  forgetRemovedAppAs,
  listRemovedAppsCore,
  RemovedAppsError,
  type RemovedAppView,
} from "./removed-apps.server";
import { installIdInput } from "./uninstall-input";

/** Settings, Removed apps: list them, delete what they kept, or forget them. */

export interface RemovedAppRow extends RemovedAppView {
  /** The app's name from the catalog; the slug when the catalog no longer lists it. */
  name: string;
}

/** Any signed-in user. */
export const listRemovedApps = createServerFn({ method: "GET" }).handler(
  async (): Promise<RemovedAppRow[]> => {
    await requireSession();
    // A deletion whose Workflow died outside its own code is settled first, so
    // the page never shows it running forever.
    const active = await createDb(env.DB)
      .select({
        id: jobs.id,
        kind: jobs.kind,
        status: jobs.status,
        install_id: jobs.install_id,
        workflow_instance_id: jobs.workflow_instance_id,
        input_json: jobs.input_json,
        started_at: jobs.started_at,
      })
      .from(jobs)
      .innerJoin(installs, eq(installs.id, jobs.install_id))
      .where(and(eq(installs.status, "uninstalled"), inArray(jobs.status, ["queued", "running"])));
    if (active.length > 0) await reconcileJobs(env.DB, env.JOBS, active);
    const [rows, read] = await Promise.all([listRemovedAppsCore(env.DB), getCatalogIndex(env)]);
    const names = new Map(read.ok ? read.index.apps.map((a) => [a.slug, a.name]) : []);
    return rows.map((row) => ({ ...row, name: names.get(row.slug) ?? row.slug }));
  },
);

function rethrow(error: unknown): never {
  if (error instanceof RemovedAppsError) throw new Error(error.message);
  throw error;
}

/** Admin only. Starts deleting everything the install kept; returns the job id for `/jobs/$jobId`. */
export const deleteRetainedData = createServerFn({ method: "POST" })
  .validator(installIdInput)
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    try {
      return await deleteRetainedDataAs(
        () => requireRole("admin"),
        {
          db: env.DB,
          workflows: env.JOBS,
          createJob: (id, params) => env.JOBS.create({ id, params }),
        },
        data.installId,
      );
    } catch (error) {
      rethrow(error);
    }
  });

/** Admin only. Hides the install from Removed apps; what it kept stays in the account. */
export const forgetRemovedApp = createServerFn({ method: "POST" })
  .validator(installIdInput)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    try {
      await forgetRemovedAppAs(() => requireRole("admin"), env.DB, data.installId);
    } catch (error) {
      rethrow(error);
    }
    return { ok: true };
  });
