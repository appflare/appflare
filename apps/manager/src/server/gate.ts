/**
 * Where a navigation may go while setup is incomplete (until setup is
 * done every route leads to `/setup`). Pure decisions over the request's state;
 * `gate.functions.ts` loads the state and turns redirects into router redirects.
 * `/login` and `/api/*` are not gated here (`/login` sends to `/setup` only before
 * the first user exists).
 */

export interface GateState {
  /** At least one user exists (the first admin was created). */
  hasUser: boolean;
  signedIn: boolean;
  isAdmin: boolean;
  /** `settings.cf_token_configured` is set. */
  tokenConfigured: boolean;
}

export type Redirect = { redirect: "/login" | "/setup" | "/" };

/** Every signed-in page (the `_app` layout). */
export function appGate(state: GateState): Redirect | { allow: true } {
  if (!state.hasUser) return { redirect: "/setup" };
  if (!state.signedIn) return { redirect: "/login" };
  if (!state.tokenConfigured) return { redirect: "/setup" };
  return { allow: true };
}

export type SetupStep = "create-admin" | "cloudflare-token" | "wait-for-admin";

/** `/setup`: create the first admin, then (signed in) the Cloudflare token step. */
export function setupGate(state: GateState): Redirect | { step: SetupStep } {
  if (!state.hasUser) return { step: "create-admin" };
  if (!state.signedIn) return { redirect: "/login" };
  if (state.tokenConfigured) return { redirect: "/" };
  return { step: state.isAdmin ? "cloudflare-token" : "wait-for-admin" };
}
