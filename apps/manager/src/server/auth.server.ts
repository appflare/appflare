import { env, waitUntil } from "cloudflare:workers";
import { redirect } from "@tanstack/react-router";
import { getRequest, getResponseHeaders } from "@tanstack/react-start/server";
import * as guards from "../auth/guards";
import { deleteRecoverySecret, sendResetEmailFromSettings } from "../auth/password-email.server";
import { versionCreatedAt } from "../auth/recovery.server";
import type { Role } from "../auth/roles";
import { type Auth, createAuth, type RecoveryAuthDeps } from "../auth/server";
import { createDb } from "../db/client";

/**
 * Request-bound auth for server functions and server routes. Everything here
 * reads the current request through TanStack Start's server context and the
 * bindings through `cloudflare:workers`, so it only runs on the server.
 */

/**
 * Better Auth, built once per isolate for each origin the manager is reached
 * on (its workers.dev hostname, a custom domain) and kept while the auth
 * secret is the same. Building it takes CPU on every request otherwise;
 * nothing in it belongs to one request (`waitUntil` and the bindings are
 * read when used).
 */
const authByOrigin = new Map<string, { secret: string; auth: Auth }>();

/** A Worker is reached on a handful of hostnames; more than this means something odd, so start over. */
const MAX_ORIGINS = 8;

/**
 * Whether this version of the Worker has `BETTER_AUTH_SECRET`. A manager
 * deployed from the "Deploy to Cloudflare" button starts without it; setup's
 * first step writes one, and until a version with it serves, Better Auth is
 * never started: nobody can have a session, and `/api/auth/*` answers 503.
 */
export function authSecretBound(): boolean {
  return typeof env.BETTER_AUTH_SECRET === "string" && env.BETTER_AUTH_SECRET.length > 0;
}

/** `authFor` without an auth secret: a bug in the caller, which must check first. */
export class AuthNotReadyError extends Error {
  override name = "AuthNotReadyError";
  constructor() {
    super("Appflare has no auth secret yet. Finish setup first.");
  }
}

export function authFor(request: Request): Auth {
  const secret = env.BETTER_AUTH_SECRET;
  if (secret === undefined || secret.length === 0) throw new AuthNotReadyError();
  const origin = new URL(request.url).origin;
  const held = authByOrigin.get(origin);
  if (held !== undefined && held.secret === secret) return held.auth;
  const auth = createAuth({
    db: createDb(env.DB),
    secret,
    baseURL: origin,
    recovery: recoveryDeps(),
  });
  if (authByOrigin.size >= MAX_ORIGINS) authByOrigin.clear();
  authByOrigin.set(origin, { secret, auth });
  return auth;
}

/**
 * Password recovery for Better Auth, from this version's bindings: the
 * recovery code secret the installer may have written, and the reset email
 * binding when the owner turned reset emails on.
 */
function recoveryDeps(): RecoveryAuthDeps {
  const background = (promise: Promise<unknown>) => waitUntil(promise);
  const mail = env.AUTH_EMAIL;
  return {
    d1: env.DB,
    accountSecret: () => env.RECOVERY_CODE_HASH,
    accountSecretSince: () => versionCreatedAt(env.CF_VERSION_METADATA),
    onAccountCodeUsed: () => background(deleteRecoverySecret(env)),
    background,
    ...(mail === undefined
      ? {}
      : { sendResetEmail: (args) => sendResetEmailFromSettings(env.DB, mail, args) }),
  };
}

/** Better Auth for the request being served. */
export function currentAuth(): Auth {
  return authFor(getRequest());
}

/**
 * The session `request` carries, or null; always null while no auth secret
 * is bound. Answered from the signed session cookie while it is fresh (see
 * `SESSION_COOKIE_CACHE_SECONDS`), else from D1; `fresh` always reads D1,
 * for anything that changes something. The cookies Better Auth refreshes on
 * the way are passed on to the browser, so the next request is answered
 * from the cookie again.
 */
export async function sessionFor(request: Request, opts: { fresh?: boolean } = {}) {
  if (!authSecretBound()) return null;
  const { headers, response } = await authFor(request).api.getSession({
    headers: request.headers,
    ...(opts.fresh === true ? { query: { disableCookieCache: true } } : {}),
    returnHeaders: true,
  });
  passOnCookies(headers);
  return response;
}

/** Adds the `Set-Cookie` headers of a Better Auth call to the response being served, if any. */
function passOnCookies(headers: Headers): void {
  const cookies = headers.getSetCookie();
  if (cookies.length === 0) return;
  try {
    const response = getResponseHeaders();
    for (const cookie of cookies) response.append("set-cookie", cookie);
  } catch {
    // Not inside a TanStack Start request: the next check reads D1 again.
  }
}

/**
 * Reads (GET server functions) may be answered from the session cookie, so
 * a revoked session, a ban or a role change reaches them within
 * `SESSION_COOKIE_CACHE_SECONDS`; every change (a POST) reads D1.
 */
const loadSession: guards.SessionLoader = async () => {
  const request = getRequest();
  return sessionFor(request, { fresh: request.method !== "GET" });
};

/** For changes: a session revoked, a user banned or a role taken away counts at once. */
const loadFreshSession: guards.SessionLoader = async () =>
  sessionFor(getRequest(), { fresh: true });

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

/**
 * The role checks guard the manager's changes, so they always read the
 * session from D1 rather than from the session cookie.
 */
export function requireRole(role: Role): Promise<guards.AuthSession> {
  return guarded(() => guards.requireRole(role, loadFreshSession));
}
