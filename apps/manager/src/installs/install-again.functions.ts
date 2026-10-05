import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireRole } from "../server/auth.server";
import type { InstallAgainRecord } from "./install-again";
import { readInstallAgain } from "./install-again.server";

/**
 * Admin only: what a failed install was given, for its "Install again"
 * form on the app's catalog page; null when there is no such install.
 * Installing again goes through `startInstall` with `replaces`.
 */
export const getInstallAgain = createServerFn({ method: "GET" })
  .validator(z.object({ installId: z.string().min(1).max(64) }))
  .handler(async ({ data }): Promise<InstallAgainRecord | null> => {
    await requireRole("admin");
    return readInstallAgain(env.DB, data.installId);
  });
