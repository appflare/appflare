import { createFileRoute } from "@tanstack/react-router";
import { authFor } from "../../../server/auth.server";

/** Better Auth's handler, mounted at `/api/auth/*`. */
export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => authFor(request).handler(request),
      POST: ({ request }) => authFor(request).handler(request),
    },
  },
});
