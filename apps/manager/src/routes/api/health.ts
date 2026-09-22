import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { healthResponse } from "../../server/health.server";

/** `GET /api/health`: unauthenticated version + D1 ping. */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () => healthResponse(env),
    },
  },
});
