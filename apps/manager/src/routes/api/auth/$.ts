import { createFileRoute } from "@tanstack/react-router";
import { mayUseSessionCopy, withoutSessionCopy } from "../../../auth/session-cookie";
import { authFor, authSecretBound } from "../../../server/auth.server";

/**
 * Better Auth's handler, mounted at `/api/auth/*`. A manager deployed
 * without secrets has no auth secret until setup writes one, and Better Auth
 * must not start without it: until then this answers 503.
 */
function handle(request: Request): Response | Promise<Response> {
  if (!authSecretBound()) {
    return Response.json(
      { message: "Appflare is not set up yet. Open it to finish setup." },
      { status: 503, headers: { "retry-after": "5" } },
    );
  }
  // Every endpoint but the session read acts on the signed-in user, so it
  // reads the session from D1, never the cookie's one-minute copy.
  return authFor(request).handler(
    mayUseSessionCopy(request) ? request : withoutSessionCopy(request),
  );
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
