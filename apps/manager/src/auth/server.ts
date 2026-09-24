// `better-auth/minimal` omits Kysely, which only direct database connections need.

import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins";
import type { Database } from "../db/client";
import * as schema from "../db/schema";
import { accessControl, DEFAULT_ROLE, roles } from "./roles";

/**
 * Passkey sign-in works without a session, so its two endpoints are open to
 * anyone. Better Auth only gives them its global limit (100 requests per 10 s),
 * and every options request writes a challenge row to D1. They get the same
 * limit Better Auth applies to `/sign-in/*`: 3 requests per 10 seconds per IP
 * and path, which one sign-in (one options request, one verification) and a
 * retry after a closed prompt stay well inside.
 */
export const PASSKEY_SIGN_IN_RATE_LIMITS = {
  "/passkey/generate-authenticate-options": { window: 10, max: 3 },
  "/passkey/verify-authentication": { window: 10, max: 3 },
} as const satisfies Record<string, { window: number; max: number }>;

export interface AuthDeps {
  db: Database;
  secret: string;
  /** The manager's own origin, e.g. `https://appflare.example.workers.dev`. */
  baseURL: string;
}

/**
 * Better Auth for the manager. Built per request: Workers have
 * no process-level env, and the base URL comes from the request.
 *
 * - Email + password, plus passkeys a signed-in user adds for themselves. Public
 *   sign-up is disabled. The first admin is created by `/setup` and every further
 *   user by an admin, both through the admin plugin's `createUser`; a passkey
 *   can only be registered from an existing session, so it never creates a user.
 * - Everything lives in D1: users, accounts, sessions, verification values, and
 *   the rate-limit counters (`rateLimit.storage: "database"`). No secondary
 *   storage: Better Auth writes a rate-limit counter on every `/api/auth/*`
 *   request, and on the free plan KV allows 1,000 writes a day against D1's
 *   100,000, so KV-backed auth state could be exhausted by unauthenticated
 *   traffic and lock everyone out. KV holds only caches written by cron.
 * - Cookies are Better Auth's defaults: HttpOnly, SameSite=Lax, Secure on https.
 * - The trusted origin is the manager's own origin only, and passkeys are bound
 *   to it too (see `passkeyRelyingParty`).
 */
export function createAuth({ db, secret, baseURL }: AuthDeps) {
  return betterAuth({
    appName: "Appflare",
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    database: drizzleAdapter(db, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: PASSKEY_SIGN_IN_RATE_LIMITS,
    },
    advanced: {
      // Cloudflare sets this header on every request; it cannot be spoofed by the client.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    // Better Auth's own telemetry (sent to Better Auth, not Appflare) stays off.
    // Off by default; pinned here. Appflare's anonymous usage data is separate
    // (telemetry/).
    telemetry: { enabled: false },
    plugins: [
      admin({
        ac: accessControl,
        roles,
        defaultRole: DEFAULT_ROLE,
        adminRoles: ["admin"],
      }),
      passkey({ rpName: "Appflare", ...passkeyRelyingParty(baseURL) }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The WebAuthn relying party for passkeys: the manager's own hostname and
 * origin, taken from the same base URL as the trusted origin. Both are pinned
 * rather than left to the plugin, which would otherwise accept whatever `Origin`
 * header the browser sent. A passkey registered on one hostname only works on
 * that hostname, so moving the manager to a new domain means adding new passkeys
 * (password sign-in keeps working).
 */
export function passkeyRelyingParty(baseURL: string): { rpID: string; origin: string } {
  const url = new URL(baseURL);
  return { rpID: url.hostname, origin: url.origin };
}
