import { env, waitUntil } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { logCfRequest } from "../../cloudflare/client.server";
import { handoffResponse } from "../../handoff/handoff.server";

/**
 * `/api/handoff`: a manager installed from the browser receives its
 * Cloudflare connection from the page that installed it (GET proves this
 * installation, POST hands over, OPTIONS is the CORS preflight).
 */
export const Route = createFileRoute("/api/handoff")({
  server: {
    handlers: {
      ANY: ({ request }) => handoffResponse(request, env, { onRequest: logCfRequest, waitUntil }),
    },
  },
});
