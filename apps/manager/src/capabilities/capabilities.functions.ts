import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { createDb } from "../db/client";
import { requireSession } from "../server/auth.server";
import type { CapabilitiesView } from "./capabilities";
import { readCapabilitiesView } from "./capabilities.server";

/**
 * The stored account capabilities, for pages that read them beside their
 * own data (Building apps); any signed-in user reads them. "What this
 * account can run" reads them with its rows (`capability-rows.functions.ts`),
 * which also runs the check again.
 */
export const getAccountCapabilities = createServerFn({ method: "GET" }).handler(
  async (): Promise<CapabilitiesView> => {
    await requireSession();
    return readCapabilitiesView(createDb(env.DB));
  },
);
