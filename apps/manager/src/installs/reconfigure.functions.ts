import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { jobCreator } from "../jobs/create-job.server";
import { sandboxBinding } from "../sandbox/binding";
import { requireRole } from "../server/auth.server";
import { startReconfigureCore } from "./reconfigure.server";
import { startReconfigureInput } from "./reconfigure-input";
import { VersionActionError } from "./versions.server";

/** The Settings section of an install: read it, and save and redeploy. */

/**
 * Admin only. Starts the job that saves the new settings and secrets and
 * redeploys the installed version with them; returns its id for `/jobs/$jobId`.
 */
export const startReconfigure = createServerFn({ method: "POST" })
  .validator(startReconfigureInput)
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    await requireRole("admin");
    try {
      return await startReconfigureCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          sandboxConnected: sandboxBinding(env) !== undefined,
          createJob: jobCreator(env.JOBS),
        },
        data,
      );
    } catch (error) {
      if (error instanceof VersionActionError) throw new Error(error.message);
      throw error;
    }
  });
