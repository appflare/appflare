import { sessionFor } from "../server/auth.server";
import type { DangerDeps } from "./routes.server";

/** The danger-zone endpoints' dependencies in the running Worker. */
export function dangerDeps(waitUntil: (promise: Promise<unknown>) => void): DangerDeps {
  return {
    // Read from D1, never the session cookie: a revoked session must not reach the danger zone.
    userId: async (request) => (await sessionFor(request, { fresh: true }))?.user.id ?? null,
    waitUntil,
  };
}
