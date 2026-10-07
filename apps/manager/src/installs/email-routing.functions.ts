import { env } from "cloudflare:workers";
import { combinedWorkerFacts } from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getCatalogManifest } from "../catalog/app-manifest.server";
import { findCatalogApp } from "../catalog/merged.server";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { connectionKindOf } from "../cloudflare/connection.server";
import { inConnectionWordsOf } from "../cloudflare/sign-in-words.server";
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
      throw new Error(await inConnectionWordsOf(env.DB, error.message));
    }
    throw error;
  }
}

/** The active zones the token can see (the same list custom domains offer). */
export const getEmailZoneOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<EmailZoneOptions> => {
    await requireRole("admin");
    return asUserError(async () => ({
      ...(await getEmailZoneOptionsCore(await getCfClient(env))),
      connection: await connectionKindOf(env.DB),
    }));
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
      // `slug` is the app key (`<catalog>:<slug>` for a custom catalog's app).
      const read = await findCatalogApp(env, data.slug);
      if (!read.ok) throw new EmailRoutingError(read.error);
      if (read.listed === null) {
        throw new EmailRoutingError(`"${data.slug}" is not in the catalog.`);
      }
      // Any tier: a sandbox tier entry has no artifact until the install
      // builds it, so its bindings (and whether it sends email) are unknown.
      const entry = await getCatalogManifest(env, read.listed.app, read.listed.trust);
      if (!entry.ok) throw new EmailRoutingError(entry.error);
      const preview = await previewEmailRoutingCore(await getCfClient(env), {
        catalog: entry.catalog,
        bindings: entry.manifest == null ? null : combinedWorkerFacts(entry.manifest).bindings,
        zoneId: data.zoneId,
        workerName: data.workerName,
      });
      // What Cloudflare refused, in the words for how Appflare connects.
      const words = (lines: string[]) =>
        Promise.all(lines.map((line) => inConnectionWordsOf(env.DB, line)));
      return {
        ...preview,
        problems: await words(preview.problems),
        warnings: await words(preview.warnings),
        connection: await connectionKindOf(env.DB),
      };
    });
  });
