import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { CfTokenNotConfiguredError } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import type { CapabilitiesView } from "./capabilities";
import { readCapabilitiesView, refreshCapabilitiesWithStoredToken } from "./capabilities.server";

/** Settings, Account capabilities: any signed-in user reads them; only admins re-check. */

export const getAccountCapabilities = createServerFn({ method: "GET" }).handler(
  async (): Promise<CapabilitiesView> => {
    await requireSession();
    return readCapabilitiesView(createDb(env.DB));
  },
);

/** Runs the probes now with the stored token (five read calls at most) and returns the new values. */
export const recheckAccountCapabilities = createServerFn({ method: "POST" }).handler(
  async (): Promise<CapabilitiesView> => {
    await requireRole("admin");
    const db = createDb(env.DB);
    try {
      await refreshCapabilitiesWithStoredToken(env, db);
    } catch (error) {
      if (error instanceof CfTokenNotConfiguredError) throw new Error(error.message);
      throw error;
    }
    return readCapabilitiesView(db);
  },
);
