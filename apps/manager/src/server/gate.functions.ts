import { env } from "cloudflare:workers";
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { hasRole } from "../auth/roles";
import { createDb } from "../db/client";
import { isCfTokenConfigured } from "../db/settings";
import { authFor } from "./auth.server";
import { appGate, type GateState, setupGate } from "./gate";
import type { Viewer } from "./session.functions";
import { hasAnyUser } from "./users.server";

async function loadGateState(): Promise<{ state: GateState; viewer: Viewer | null }> {
  const request = getRequest();
  const db = createDb(env.DB);
  const [hasUser, session, tokenConfigured] = await Promise.all([
    hasAnyUser(db),
    authFor(request).api.getSession({ headers: request.headers }),
    isCfTokenConfigured(db),
  ]);
  const isAdmin = session !== null && hasRole(session.user.role, "admin");
  const viewer: Viewer | null =
    session === null
      ? null
      : {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          role: isAdmin ? "admin" : "member",
        };
  return { state: { hasUser, signedIn: session !== null, isAdmin, tokenConfigured }, viewer };
}

/**
 * The `_app` layout's gate: the signed-in viewer, or a redirect to `/login` (no
 * session) or `/setup` (setup incomplete). UX only; every server function still
 * enforces its own guard.
 */
export const enterApp = createServerFn({ method: "GET" }).handler(async (): Promise<Viewer> => {
  const { state, viewer } = await loadGateState();
  const gate = appGate(state);
  if ("redirect" in gate) throw redirect({ to: gate.redirect });
  if (viewer === null) throw redirect({ to: "/login" });
  return viewer;
});

/** `/setup`'s gate: which step to show, or a redirect. */
export const enterSetup = createServerFn({ method: "GET" }).handler(async () => {
  const { state } = await loadGateState();
  const gate = setupGate(state);
  if ("redirect" in gate) throw redirect({ to: gate.redirect });
  return gate;
});
