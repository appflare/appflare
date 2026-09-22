// `better-auth/minimal` omits Kysely, which only direct database connections need.

import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { admin } from "better-auth/plugins";
import type { Database } from "../db/client";
import * as schema from "../db/schema";
import { accessControl, DEFAULT_ROLE, roles } from "./roles";

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
 * - Email + password only; public sign-up is disabled. The first admin is created
 *   by `/setup` and every further user by an admin, both through the
 *   admin plugin's `createUser`.
 * - Everything lives in D1: users, accounts, sessions, verification values, and
 *   the rate-limit counters (`rateLimit.storage: "database"`). No secondary
 *   storage: Better Auth writes a rate-limit counter on every `/api/auth/*`
 *   request, and on the free plan KV allows 1,000 writes a day against D1's
 *   100,000, so KV-backed auth state could be exhausted by unauthenticated
 *   traffic and lock everyone out. KV holds only caches written by cron.
 * - Cookies are Better Auth's defaults: HttpOnly, SameSite=Lax, Secure on https.
 * - The trusted origin is the manager's own origin only.
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
    },
    advanced: {
      // Cloudflare sets this header on every request; it cannot be spoofed by the client.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    // No telemetry of any kind. Off by default; pinned here.
    telemetry: { enabled: false },
    plugins: [
      admin({
        ac: accessControl,
        roles,
        defaultRole: DEFAULT_ROLE,
        adminRoles: ["admin"],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
