import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CfTokenNotConfiguredError, getCfClient } from "../../cloudflare/client.server";
import { requireRole, requireSession } from "../../server/auth.server";
import {
  listManagerVersionsCore,
  ManagerRollbackError,
  type ManagerVersionsView,
  type RollBackManagerResult,
  rollBackManagerAs,
} from "./rollback.server";

/** Settings, Updates, Recent versions: Appflare's own recent versions and the rollback. */

export type ManagerVersionsState =
  | ({ ok: true } & ManagerVersionsView)
  | { ok: false; error: string };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Any signed-in user. A Cloudflare failure is reported in the card, never as a broken page. */
export const getManagerVersions = createServerFn({ method: "GET" }).handler(
  async (): Promise<ManagerVersionsState> => {
    await requireSession();
    try {
      const api = await getCfClient(env);
      return { ok: true, ...(await listManagerVersionsCore({ db: env.DB, api })) };
    } catch (error) {
      if (error instanceof ManagerRollbackError || error instanceof CfTokenNotConfiguredError) {
        return { ok: false, error: error.message };
      }
      console.error("reading Appflare's versions failed", { error: message(error) });
      return { ok: false, error: `Cloudflare did not list Appflare's versions: ${message(error)}` };
    }
  },
);

/**
 * Admins (the owner is one): redeploys an older version of Appflare's own
 * Worker to all traffic, after the checks in ./rollback.server.ts. Returns
 * once the switch is made; the page then follows it to the older version.
 */
export const rollBackManager = createServerFn({ method: "POST" })
  .validator(z.object({ versionId: z.guid() }))
  .handler(async ({ data }): Promise<RollBackManagerResult> => {
    try {
      return await rollBackManagerAs(
        () => requireRole("admin"),
        {
          db: env.DB,
          api: (onRequest) => getCfClient(env, { onRequest }),
          currentVersion: env.APPFLARE_VERSION,
          workflows: env.JOBS,
        },
        data,
      );
    } catch (error) {
      if (error instanceof ManagerRollbackError || error instanceof CfTokenNotConfiguredError) {
        throw new Error(error.message);
      }
      throw error;
    }
  });
