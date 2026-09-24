import { env, waitUntil } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { dangerDeps } from "../../../danger/deps.server";
import { handleRemoveAppflare } from "../../../danger/routes.server";

/** `POST /api/danger/remove-appflare`: Settings' "Remove Appflare from this account" (owner only). */
export const Route = createFileRoute("/api/danger/remove-appflare")({
  server: {
    handlers: {
      POST: ({ request }) => handleRemoveAppflare(request, env, dangerDeps(waitUntil)),
    },
  },
});
