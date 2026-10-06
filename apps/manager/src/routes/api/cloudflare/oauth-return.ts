import { env, waitUntil } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { refreshCapabilitiesWithStoredToken } from "../../../capabilities/capabilities.server";
import { apiBaseOption } from "../../../cloudflare/api-base";
import { logCfRequest } from "../../../cloudflare/client.server";
import { handleOAuthReturn } from "../../../cloudflare/reconnect.server";
import { createDb } from "../../../db/client";
import { runningVersion } from "../../../server/build-version";

/**
 * `POST /api/cloudflare/oauth-return`: where appflare.dev's callback page
 * sends "Sign in with Cloudflare" back to this manager, as a form. Answered
 * without a session and outside the Worker's Cloudflare Access check: the
 * pending sign-in an administrator started is what authorizes it.
 */
export const Route = createFileRoute("/api/cloudflare/oauth-return")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleOAuthReturn(request, env, {
          runningVersionId: env.CF_VERSION_METADATA?.id ?? null,
          onRequest: logCfRequest,
          ...apiBaseOption(env),
          waitUntil,
          // With every permission granted now, the account's checks may read differently.
          afterConnected: async () => {
            await refreshCapabilitiesWithStoredToken(env, createDb(env.DB), {
              version: runningVersion(env),
            });
          },
        }),
    },
  },
});
