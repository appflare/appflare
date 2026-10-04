import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { probeHeadersFromEnv } from "../access/probe-credentials.server";
import { requireRole } from "../server/auth.server";
import { checkInstallHealthCore, HealthCheckError, type HealthCheckResult } from "./health.server";
import { installIdInput } from "./versions-input";

/**
 * Admin only. Probes the install's Worker once at the app's health path and
 * records the result on the install; the page reloads to show it.
 */
export const checkInstallHealth = createServerFn({ method: "POST" })
  .validator(installIdInput)
  .handler(async ({ data }): Promise<HealthCheckResult> => {
    await requireRole("admin");
    try {
      return await checkInstallHealthCore(
        {
          db: env.DB,
          fetch: (input, init) => fetch(input, init),
          probeHeaders: probeHeadersFromEnv(env),
        },
        data,
      );
    } catch (error) {
      if (error instanceof HealthCheckError) throw new Error(error.message);
      throw error;
    }
  });
