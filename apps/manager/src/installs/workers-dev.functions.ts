import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { requireRole } from "../server/auth.server";
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
