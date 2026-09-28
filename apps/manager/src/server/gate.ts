/**
 * Where a navigation may go while setup is incomplete (until setup is
 * done every route leads to `/setup`). Pure decisions over the request's state;
 * `gate.functions.ts` loads the state and turns redirects into router redirects.
 * `/login` and `/api/*` are not gated here (`/login` sends to `/setup` only before
 * the first user exists).
 */

import { afterSignIn, withReturnTo } from "../components/return-to";

export interface GateState {
  /** At least one user exists (the owner was created). */
  hasUser: boolean;
  signedIn: boolean;
  isAdmin: boolean;
  /** `settings.cf_token_configured` is set. */
  tokenConfigured: boolean;
  /**
   * This browser holds the unexpired setup claim that connecting Cloudflare
   * issued (only meaningful before any user exists).
   */
  setupClaimed: boolean;
  /**
   * The version serving this request has `BETTER_AUTH_SECRET`. A manager
   * deployed without secrets gets one when Cloudflare is connected, and the
   * owner can be created only once a version with it serves.
   */
  authReady: boolean;
}

export type Redirect = { redirect: "/login" | "/setup" | "/" };

/**
 * The href a gate's redirect goes to. Sign-in and setup carry the page the
 * visitor asked for (`returnTo`, from the browser's own address, so its
 * `#section` survives), and "setup is done" goes straight to it; an unsafe
 * `returnTo` is dropped and home is used.
 */
export function redirectHref(to: Redirect["redirect"], returnTo: unknown): string {
  return to === "/" ? afterSignIn(returnTo) : withReturnTo(to, returnTo);
}

/** Every signed-in page (the `_app` layout). */
export function appGate(state: GateState): Redirect | { allow: true } {
  if (!state.hasUser) return { redirect: "/setup" };
  if (!state.signedIn) return { redirect: "/login" };
  if (!state.tokenConfigured) return { redirect: "/setup" };
  return { allow: true };
}

export type SetupStep =
  /** Step 1: paste an API token for this account (anyone, before any user exists). */
  | "connect"
  /**
   * Between steps 1 and 2 for a manager deployed without secrets: waiting for
   * the version with the new auth secret to serve.
   */
  | "redeploying"
  /** Step 2: create the owner (only the browser that connected Cloudflare). */
  | "create-owner"
  /** Step 3: what the account can run, for admins, until they choose Finish. */
  | "checklist"
  /**
   * A manager whose first admin was created before the token (installed
   * when setup started with the admin): an admin still adds the token.
   */
  | "cloudflare-token"
  | "wait-for-admin";

/**
 * `/setup`: connect Cloudflare, then create the owner, then (signed in) the
 * checklist when asked for (`checklist`, set by the step before it).
 */
export function setupGate(
  state: GateState,
  opts: { checklist?: boolean } = {},
): Redirect | { step: SetupStep } {
  if (!state.hasUser) {
    if (!state.tokenConfigured || !state.setupClaimed) return { step: "connect" };
    return { step: state.authReady ? "create-owner" : "redeploying" };
  }
  if (!state.signedIn) return { redirect: "/login" };
  if (!state.tokenConfigured) {
    return { step: state.isAdmin ? "cloudflare-token" : "wait-for-admin" };
  }
  if (opts.checklist === true && state.isAdmin) return { step: "checklist" };
  return { redirect: "/" };
}
