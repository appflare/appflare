import { env } from "cloudflare:workers";
import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { hasRole } from "../auth/roles";
import { MAX_RETURN_PATH_LENGTH } from "../components/internal-path";
import { createDb } from "../db/client";
import { isCfTokenConfigured, readSettings, SETTING } from "../db/settings";
import { markOpenedToday } from "../telemetry/state.server";
import { authSecretBound, sessionFor } from "./auth.server";
import { appGate, type GateState, redirectHref, setupGate } from "./gate";
import type { Viewer } from "./session.functions";
import { SETUP_CLAIM_COOKIE, setupClaimMatches } from "./setup.server";
import { hasAnyUser } from "./users.server";

async function loadGateState(): Promise<{ state: GateState; viewer: Viewer | null }> {
  const request = getRequest();
  const db = createDb(env.DB);
  const [hasUser, session, tokenConfigured] = await Promise.all([
    hasAnyUser(db),
    sessionFor(request),
    isCfTokenConfigured(db),
  ]);
  // The claim only matters before the owner exists.
  const setupClaimed =
    !hasUser && tokenConfigured
      ? await setupClaimMatches(env.DB, getCookie(SETUP_CLAIM_COOKIE), new Date())
      : false;
  const isAdmin = session !== null && hasRole(session.user.role, "admin");
  const viewer: Viewer | null =
    session === null
      ? null
      : {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          role: isAdmin ? "admin" : "member",
          isOwner: isAdmin && session.user.isOwner === true,
        };
  return {
    state: {
      hasUser,
      signedIn: session !== null,
      isAdmin,
      tokenConfigured,
      setupClaimed,
      authReady: authSecretBound(),
    },
    viewer,
  };
}

/**
 * The page the visitor asked for, as the browser shows it. A value too long
 * to keep is dropped rather than failing the page; `redirectHref` keeps the
 * rest only when it is one of the manager's pages.
 */
const returnToInput = z.object({
  returnTo: z.string().max(MAX_RETURN_PATH_LENGTH).optional().catch(undefined),
});

/** What every signed-in page knows: who is looking, and the account Appflare runs in. */
export interface AppEntry {
  viewer: Viewer;
  /** For links into the Cloudflare dashboard; null while the token step has not recorded it. */
  accountId: string | null;
}

/**
 * The `_app` layout's gate: the signed-in viewer, or a redirect to `/login` (no
 * session) or `/setup` (setup incomplete), carrying the page asked for
 * (`returnTo`: the browser's own address, section included, checked again
 * before use). UX only; every server function still enforces its own guard.
 * Also records the day for the daily "manager opened" usage-data event (at
 * most one write per isolate per day; never fails the page).
 */
export const enterApp = createServerFn({ method: "GET" })
  .validator(returnToInput)
  .handler(async ({ data }): Promise<AppEntry> => {
    const [{ state, viewer }, account] = await Promise.all([
      loadGateState(),
      readSettings(createDb(env.DB), [SETTING.accountId]),
    ]);
    const gate = appGate(state);
    if ("redirect" in gate) throw redirect({ href: redirectHref(gate.redirect, data.returnTo) });
    if (viewer === null) throw redirect({ href: redirectHref("/login", data.returnTo) });
    try {
      await markOpenedToday(env, viewer.role);
    } catch (error) {
      console.warn("could not record the day the manager was opened", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { viewer, accountId: account.account_id || null };
  });

/**
 * `/setup`'s gate: which step to show, or a redirect (to sign in, carrying
 * `returnTo`; once setup is done, to `returnTo` itself, else home).
 */
export const enterSetup = createServerFn({ method: "GET" })
  .validator(returnToInput.extend({ checklist: z.boolean().optional() }))
  .handler(async ({ data }) => {
    const { state } = await loadGateState();
    const gate = setupGate(state, { checklist: data.checklist === true });
    if ("redirect" in gate) throw redirect({ href: redirectHref(gate.redirect, data.returnTo) });
    return gate;
  });
