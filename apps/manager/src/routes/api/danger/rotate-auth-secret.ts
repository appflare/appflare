import { env, waitUntil } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { dangerDeps } from "../../../danger/deps.server";
import { handleRotateAuthSecret } from "../../../danger/routes.server";

/** `POST /api/danger/rotate-auth-secret`: Settings' "Rotate the auth secret" (owner only). */
export const Route = createFileRoute("/api/danger/rotate-auth-secret")({
  server: {
    handlers: {
      POST: ({ request }) => handleRotateAuthSecret(request, env, dangerDeps(waitUntil)),
    },
  },
});
