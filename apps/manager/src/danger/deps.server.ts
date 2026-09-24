import { sessionFor } from "../server/auth.server";
import type { DangerDeps } from "./routes.server";

/** The danger-zone endpoints' dependencies in the running Worker. */
export function dangerDeps(waitUntil: (promise: Promise<unknown>) => void): DangerDeps {
  return {
    userId: async (request) => (await sessionFor(request))?.user.id ?? null,
    waitUntil,
  };
}
