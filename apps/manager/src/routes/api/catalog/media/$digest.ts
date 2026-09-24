import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { catalogMediaRoute } from "../../../../catalog/media.server";
import { sessionFor } from "../../../../server/auth.server";

/**
 * `GET /api/catalog/media/<sha256>`: a catalog image the cached index lists,
 * checked against its digest (see `catalog/media.ts`). Signed-in users only.
 */
export const Route = createFileRoute("/api/catalog/media/$digest")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        catalogMediaRoute(env, params.digest, async () => (await sessionFor(request)) !== null),
    },
  },
});
