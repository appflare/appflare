import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { jobCreator } from "../jobs/create-job.server";
import { sandboxBinding } from "../sandbox/binding";
import { requireRole } from "../server/auth.server";
import { startEmailAgainCore, startReconfigureCore } from "./reconfigure.server";
import { startEmailAgainInput, startReconfigureInput } from "./reconfigure-input";
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

/**
 * Admin only. Starts the settings change job that sets the app's email up
 * again on the domain it receives email for: the parts an update or a
 * rollback left out, checked strictly first. Returns its id for `/jobs/$jobId`.
 */
export const startEmailAgain = createServerFn({ method: "POST" })
  .validator(startEmailAgainInput)
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    await requireRole("admin");
    try {
      return await startEmailAgainCore(
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
