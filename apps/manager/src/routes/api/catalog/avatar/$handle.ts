import { env } from "cloudflare:workers";
import { createFileRoute } from "@tanstack/react-router";
import { authorAvatarRoute } from "../../../../catalog/avatar.server";
import { authFor } from "../../../../server/auth.server";

/**
 * `GET /api/catalog/avatar/<handle>`: the GitHub avatar of an app author the
 * cached index lists (see `catalog/avatar.ts`). Signed-in users only.
 */
export const Route = createFileRoute("/api/catalog/avatar/$handle")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        authorAvatarRoute(
          env,
          params.handle,
          async () =>
            (await authFor(request).api.getSession({ headers: request.headers })) !== null,
        ),
    },
  },
});
