import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { hasRole } from "../auth/roles";
import { ensureMigrated, type SchemaDowngrade, schemaDowngrade } from "../db/migrate";
import { requireRole, requireSession } from "../server/auth.server";
import { type DeployCopyCleanup, deployButtonInstalled } from "./deploy-copy";
import { dismissDeployCopyCleanup, readDeployCopyCleanup } from "./deploy-copy.server";

/**
 * The home page's notices about how this manager was deployed: the
 * "Clean up the deploy copy" card (admins of a manager the "Deploy to
 * Cloudflare" button deployed, until one dismisses it), and the banner shown
 * to everyone while an older version serves a database a newer one migrated.
 */

export const getDeployCopyCleanup = createServerFn({ method: "GET" }).handler(
  async (): Promise<DeployCopyCleanup | null> => {
    const session = await requireSession();
    return readDeployCopyCleanup(env, hasRole(session.user.role, "admin"));
  },
);

/** The card's Dismiss: hides it for every admin of this manager. */
export const dismissDeployCopy = createServerFn({ method: "POST" }).handler(
  async (): Promise<void> => {
    await requireRole("admin");
    await dismissDeployCopyCleanup(env);
  },
);

/** The running version against the database's `schema_version`, as read when the isolate started. */
export const getSchemaDowngrade = createServerFn({ method: "GET" }).handler(
  async (): Promise<(SchemaDowngrade & { version: string; deployButton: boolean }) | null> => {
    await requireSession();
    // Cached after the isolate's first request: no D1 read here.
    const { schemaVersion } = await ensureMigrated(env);
    const downgrade = schemaDowngrade(schemaVersion);
    return downgrade === null
      ? null
      : { ...downgrade, version: env.APPFLARE_VERSION, deployButton: deployButtonInstalled(env) };
  },
);
