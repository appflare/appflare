import { env } from "cloudflare:workers";
import { SANDBOX_WORKER_NAME } from "@appflare/schema";
import { createServerFn } from "@tanstack/react-start";
import { getCfClient } from "../cloudflare/client.server";
import { requireRole } from "../server/auth.server";
import {
  AppCredentialsError,
  replaceAppCredentialsCore,
  replaceAppCredentialsInput,
} from "./app-credentials.server";

/**
 * Admin only. Stores a self-deploying app's token (and secret values) again
 * on the sandbox Worker, for when it was rotated or lost.
 */
export const replaceAppCredentials = createServerFn({ method: "POST" })
  .validator(replaceAppCredentialsInput)
  .handler(async ({ data }): Promise<{ stored: string[] }> => {
    await requireRole("admin");
    try {
      const api = await getCfClient(env);
      return await replaceAppCredentialsCore(
        {
          db: env.DB,
          async putSandboxSecret(name, value) {
            await api.workers.putSecret(SANDBOX_WORKER_NAME, { name, text: value });
          },
        },
        data,
      );
    } catch (error) {
      if (error instanceof AppCredentialsError) throw new Error(error.message);
      throw error;
    }
  });
