import { inArray } from "drizzle-orm";
import { hasRole } from "../auth/roles";
import { createDb } from "../db/client";
import { settings, user } from "../db/schema";
import { SETTING } from "../db/settings";
import { markOpenedToday, type TelemetryEnv } from "../telemetry/state.server";
import type { GateState } from "./gate";
import type { Viewer } from "./session.functions";

/**
 * What the gates read, without TanStack Start: `gate.functions.ts` binds it
 * to the request (its session, its setup claim cookie).
 */

/** The parts of a Better Auth session the gates read. */
export interface GateSession {
  user: {
    id: string;
    email: string;
    name: string;
    role?: string | null;
    isOwner?: boolean | null;
  };
}

export interface GateInputs {
  db: D1Database;
  loadSession: () => Promise<GateSession | null>;
  /** Whether this browser holds the setup claim; asked only before the owner exists. */
  setupClaimed: () => Promise<boolean>;
  /** The version serving this request has `BETTER_AUTH_SECRET`. */
  authReady: boolean;
}

export interface GateRead {
  state: GateState;
  viewer: Viewer | null;
  /** For links into the Cloudflare dashboard; null while the token step has not recorded it. */
  accountId: string | null;
}

/**
 * The gates' state in one round trip besides the session: whether any user
 * exists and the two settings rows, as one D1 batch, next to the session
 * read. The setup claim is read only before the owner exists.
 */
export async function readGate(inputs: GateInputs): Promise<GateRead> {
  const db = createDb(inputs.db);
  const [session, [users, rows]] = await Promise.all([
    inputs.loadSession(),
    db.batch([
      db.select({ id: user.id }).from(user).limit(1),
      db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(inArray(settings.key, [SETTING.cfTokenConfigured, SETTING.accountId])),
    ]),
  ]);
  const hasUser = users.length > 0;
  const setting = new Map(rows.map((r) => [r.key, r.value]));
  const tokenConfigured = setting.get(SETTING.cfTokenConfigured) === "1";
  // The claim only matters before the owner exists.
  const setupClaimed = !hasUser && tokenConfigured ? await inputs.setupClaimed() : false;
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
      authReady: inputs.authReady,
    },
    viewer,
    accountId: setting.get(SETTING.accountId) || null,
  };
}

/**
 * Records the day for the daily "manager opened" usage-data event (at most
 * one write per isolate per day). Runs after the page's answer is sent
 * (`waitUntil`); never fails.
 */
export async function recordOpened(env: TelemetryEnv, viewer: Viewer): Promise<void> {
  try {
    await markOpenedToday(env, viewer.role);
  } catch (error) {
    console.warn("could not record the day the manager was opened", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
