import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { CfTokenNotConfiguredError } from "../cloudflare/client.server";
import { invalidateScriptsCache } from "../cloudflare/scripts-cache.server";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import { refreshCapabilitiesWithStoredToken } from "./capabilities.server";
import { type CapabilityRowsData, readCapabilityRowsData } from "./capability-rows.server";

/** What this account can run: any signed-in user reads it; admins check again. */

export const getCapabilityRowsData = createServerFn({ method: "GET" }).handler(
  async (): Promise<CapabilityRowsData> => {
    await requireSession();
    return readCapabilityRowsData(env, createDb(env.DB));
  },
);

/**
 * Runs the capability probes now with the stored token (eight read calls at
 * most), then reads the rows' data again.
 */
export const checkCapabilitiesAgain = createServerFn({ method: "POST" }).handler(
  async (): Promise<CapabilityRowsData> => {
    await requireRole("admin");
    // Checking the account again reads its Workers again too (the catalog pages keep their names).
    invalidateScriptsCache();
    const db = createDb(env.DB);
    try {
      await refreshCapabilitiesWithStoredToken(env, db);
    } catch (error) {
      if (error instanceof CfTokenNotConfiguredError) throw new Error(error.message);
      throw error;
    }
    return readCapabilityRowsData(env, db);
  },
);
