import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { refreshCapabilitiesWithStoredToken } from "../capabilities/capabilities.server";
import { CfTokenNotConfiguredError } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { requireRole, requireSession } from "../server/auth.server";
import { type ChecklistData, readChecklistData } from "./checklist.server";

/** The onboarding checklist: any signed-in user reads it; admins re-check. */

export const getChecklistData = createServerFn({ method: "GET" }).handler(
  async (): Promise<ChecklistData> => {
    await requireSession();
    return readChecklistData(env, createDb(env.DB));
  },
);

/** Runs the capability probes now with the stored token, then reads the checklist again. */
export const recheckChecklist = createServerFn({ method: "POST" }).handler(
  async (): Promise<ChecklistData> => {
    await requireRole("admin");
    const db = createDb(env.DB);
    try {
      await refreshCapabilitiesWithStoredToken(env, db);
    } catch (error) {
      if (error instanceof CfTokenNotConfiguredError) throw new Error(error.message);
      throw error;
    }
    return readChecklistData(env, db);
  },
);
