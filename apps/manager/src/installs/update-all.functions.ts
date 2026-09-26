import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { listedApps, readEnabledCatalogs } from "../catalog/merged.server";
import { requireRole } from "../server/auth.server";
import { type UpdateAllOutcome, updateAllInput } from "./update-all";
import { startAllUpdatesCore } from "./update-all.server";

/**
 * Admin only: "Update all" on the home page. Starts every listed update
 * that needs nothing from the admin and returns what started and what is
 * left for the admin.
 */
export const startAllUpdates = createServerFn({ method: "POST" })
  .validator(updateAllInput)
  .handler(async ({ data }): Promise<UpdateAllOutcome> => {
    await requireRole("admin");
    const reads = await readEnabledCatalogs(env);
    const failed = reads.find((r) => !r.ok);
    if (reads.length > 0 && reads.every((r) => !r.ok) && failed !== undefined && !failed.ok) {
      throw new Error(failed.error);
    }
    const listed = new Map(listedApps(reads).map((l) => [l.key, l]));
    return startAllUpdatesCore(env, {}, listed, data);
  });
