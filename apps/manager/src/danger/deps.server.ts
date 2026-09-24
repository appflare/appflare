import { authFor } from "../server/auth.server";
import type { DangerDeps } from "./routes.server";

/** The danger-zone endpoints' dependencies in the running Worker. */
export function dangerDeps(waitUntil: (promise: Promise<unknown>) => void): DangerDeps {
  return {
    userId: async (request) =>
      (await authFor(request).api.getSession({ headers: request.headers }))?.user.id ?? null,
    waitUntil,
  };
}
