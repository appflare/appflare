import { env } from "cloudflare:workers";
import { redirect } from "@tanstack/react-router";
import { getRequest } from "@tanstack/react-start/server";
import * as guards from "../auth/guards";
import type { Role } from "../auth/roles";
import { type Auth, createAuth } from "../auth/server";
import { createDb } from "../db/client";

/**
 * Request-bound auth for server functions and server routes. Everything here
 * reads the current request through TanStack Start's server context and the
 * bindings through `cloudflare:workers`, so it only runs on the server.
 */

const authByRequest = new WeakMap<Request, Auth>();

export function authFor(request: Request): Auth {
  let auth = authByRequest.get(request);
  if (auth === undefined) {
    auth = createAuth({
      db: createDb(env.DB),
      secret: env.BETTER_AUTH_SECRET,
      baseURL: new URL(request.url).origin,
    });
    authByRequest.set(request, auth);
  }
  return auth;
}

/** Better Auth for the request being served. */
export function currentAuth(): Auth {
  return authFor(getRequest());
}

const loadSession: guards.SessionLoader = async () => {
  const request = getRequest();
  return authFor(request).api.getSession({ headers: request.headers });
};

/**
 * Wraps a guard so a missing session becomes a router redirect to `/login`
 * (handled by the client whether the call came from a loader or a component).
 * A missing role stays an error the UI shows.
 */
async function guarded(run: () => Promise<guards.AuthSession>): Promise<guards.AuthSession> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof guards.AuthGuardError && error.status === 401) {
      throw redirect({ to: "/login" });
    }
    throw error;
  }
}

export function requireSession(): Promise<guards.AuthSession> {
  return guarded(() => guards.requireSession(loadSession));
}

export function requireRole(role: Role): Promise<guards.AuthSession> {
  return guarded(() => guards.requireRole(role, loadSession));
}
