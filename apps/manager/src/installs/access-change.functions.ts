import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import type { AppAccessCheck } from "../access/app-access";
import { checkAppAccessCore } from "../access/app-access.server";
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

/**
 * Admin only. Whether the account can protect apps with Cloudflare Access
 * now (the same check an install or a change of protection starts with),
 * how many Appflare users get in, and the organization's login methods, for
 * the install form's protection checkbox and the app page's dialog. Reads
 * only.
 */
export const checkAppAccess = createServerFn({ method: "POST" }).handler(
  async (): Promise<AppAccessCheck> => {
    await requireRole("admin");
    try {
      return await checkAppAccessCore({ db: env.DB, client: await getCfClient(env) });
    } catch (error) {
      if (error instanceof CfTokenNotConfiguredError || error instanceof CloudflareApiError) {
        throw new Error(error.message);
      }
      throw error;
    }
  },
);
