import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { accessAddressSync } from "../access/address-sync.server";
import { probeHeadersFromEnv } from "../access/probe-credentials.server";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { requireRole } from "../server/auth.server";
import { varsRefresher } from "./reconfigure.server";
import { setWorkersDevInput } from "./workers-dev";
import { type SetWorkersDevResult, setWorkersDevCore, WorkersDevError } from "./workers-dev.server";

/**
 * Admin only: turns an install's workers.dev URL on or off ("Serve on
 * workers.dev"). Off only while one of its custom domains serves the app.
 */
export const setWorkersDev = createServerFn({ method: "POST" })
  .validator(setWorkersDevInput)
  .handler(async ({ data }): Promise<SetWorkersDevResult> => {
    await requireRole("admin");
    try {
      return await setWorkersDevCore(
        {
          db: env.DB,
          api: () => getCfClient(env),
          fetch: (input, init) => fetch(input, init),
          probeHeaders: probeHeadersFromEnv(env),
          refreshVars: varsRefresher(env),
          syncAccess: accessAddressSync(env.DB, () => getCfClient(env)),
        },
        data,
      );
    } catch (error) {
      if (error instanceof WorkersDevError || error instanceof CfTokenNotConfiguredError) {
        throw new Error(error.message);
      }
      throw error;
    }
  });
