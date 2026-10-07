import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requireRole } from "../server/auth.server";
import { ReconnectError, type StartedReconnect, startReconnect } from "./reconnect.server";

/**
 * Admin only: starts "Sign in with Cloudflare" for this manager and returns
 * Cloudflare's authorization page, where the browser goes next. The sign-in
 * comes back to the address this request came to, which is where the
 * administrator's session lives. A POST: it stores a pending sign-in.
 */
export const startCloudflareReconnect = createServerFn({ method: "POST" }).handler(
  async (): Promise<StartedReconnect> => {
    const session = await requireRole("admin");
    try {
      return await startReconnect({
        db: env.DB,
        userId: session.user.id,
        origin: new URL(getRequest().url).origin,
        config: env,
      });
    } catch (error) {
      if (error instanceof ReconnectError) throw new Error(error.message);
      throw error;
    }
  },
);
