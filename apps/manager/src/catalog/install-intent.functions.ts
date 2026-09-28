import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { hasRole } from "../auth/roles";
import { requireSession } from "../server/auth.server";
import type { InstallLinkTarget } from "./install-intent";
import { findInstallLinkTarget } from "./install-intent.server";

/**
 * Any signed-in user: where `/install/<slug>` goes (`install-intent.server.ts`).
 * Members open the app's page too; only admins see its install action there,
 * and only an admin's link fetches the catalogs again. The slug is checked
 * there; here only its length.
 */
export const resolveInstallLink = createServerFn({ method: "GET" })
  .validator(z.object({ slug: z.string().max(130).catch("") }))
  .handler(async ({ data }): Promise<InstallLinkTarget> => {
    const session = await requireSession();
    return findInstallLinkTarget(env, data.slug, {
      isAdmin: hasRole(session.user.role, "admin"),
    });
  });
