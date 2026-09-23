import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getAppManifest } from "../catalog/app-manifest.server";
import { getCatalogIndex } from "../catalog/index.server";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { requireRole } from "../server/auth.server";
import {
  EmailRoutingError,
  type EmailRoutingPreview,
  type EmailZoneOptions,
  getEmailZoneOptionsCore,
  previewEmailRoutingCore,
} from "./email-routing.server";
import { workerNameSchema } from "./install-input";

/** The install form's Email Routing fields: the zones to choose from, and a preview. Admin only. */

async function asUserError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof EmailRoutingError || error instanceof CfTokenNotConfiguredError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

/** The active zones the token can see (the same list custom domains offer). */
export const getEmailZoneOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<EmailZoneOptions> => {
    await requireRole("admin");
    return asUserError(async () => getEmailZoneOptionsCore(await getCfClient(env)));
  },
);

export const previewEmailRoutingInput = z.object({
  slug: z.string().min(1).max(100),
  zoneId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  workerName: workerNameSchema,
});

/** What installing the app on the zone would set up, and anything in the way. Changes nothing. */
export const previewEmailRouting = createServerFn({ method: "GET" })
  .validator(previewEmailRoutingInput)
  .handler(async ({ data }): Promise<EmailRoutingPreview> => {
    await requireRole("admin");
    return asUserError(async () => {
      const read = await getCatalogIndex(env);
      if (!read.ok) throw new EmailRoutingError(read.error);
      const app = read.index.apps.find((a) => a.slug === data.slug);
      if (app === undefined) throw new EmailRoutingError(`"${data.slug}" is not in the catalog.`);
      const manifest = await getAppManifest(env, app);
      if (!manifest.ok) throw new EmailRoutingError(manifest.error);
      return previewEmailRoutingCore(await getCfClient(env), {
        manifest: manifest.manifest,
        zoneId: data.zoneId,
        workerName: data.workerName,
      });
    });
  });
