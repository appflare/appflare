import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { accessCapabilityProblem } from "../access/preflight.server";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { jobCreator } from "../jobs/create-job.server";
import { sandboxBinding } from "../sandbox/binding";
import { requireRole } from "../server/auth.server";
import { startAccessChangeInput } from "./access-change-input";
import { startAccessChangeCore } from "./reconfigure.server";
import { VersionActionError } from "./versions.server";

/**
 * Admin only. Turns Cloudflare Access protection of an installed app on or
 * off with a job (the settings change job, which also deploys the app's
 * settings again when they use the Access values); returns its id for
 * `/jobs/$jobId`.
 */
export const startAccessChange = createServerFn({ method: "POST" })
  .validator(startAccessChangeInput)
  .handler(async ({ data }): Promise<{ jobId: string }> => {
    await requireRole("admin");
    try {
      return await startAccessChangeCore(
        {
          db: env.DB,
          workflows: env.JOBS,
          sandboxConnected: sandboxBinding(env) !== undefined,
          createJob: jobCreator(env.JOBS),
          accessPreflight: async () => accessCapabilityProblem(await getCfClient(env)),
        },
        data,
      );
    } catch (error) {
      if (error instanceof VersionActionError || error instanceof CfTokenNotConfiguredError) {
        throw new Error(error.message);
      }
      throw error;
    }
  });
