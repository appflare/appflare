import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getCatalogIndex } from "../catalog/index.server";
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
    const read = await getCatalogIndex(env);
    if (!read.ok) throw new Error(read.error);
    const listed = new Map(read.index.apps.map((a) => [a.slug, a]));
    return startAllUpdatesCore(env, {}, listed, data);
  });
