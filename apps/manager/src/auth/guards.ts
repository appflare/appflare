import { hasRole, type Role } from "./roles";

/**
 * Access-control guards: every server function calls
 * `requireSession()` first, and mutating ones `requireRole("admin")`. This module
 * is the framework-free core; `server/auth.server.ts` binds it to the current
 * request.
 */

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
}

export interface AuthSession {
  user: SessionUser;
  session: { id: string; expiresAt: Date };
}

/** Resolves the caller's session from the current request, or null. */
export type SessionLoader = () => Promise<AuthSession | null>;

export class AuthGuardError extends Error {
  override name = "AuthGuardError";
  constructor(
    readonly status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export async function requireSession(load: SessionLoader): Promise<AuthSession> {
  const session = await load();
  if (session === null) throw new AuthGuardError(401, "Sign in to continue.");
  return session;
}

export async function requireRole(role: Role, load: SessionLoader): Promise<AuthSession> {
  const session = await requireSession(load);
  if (!hasRole(session.user.role, role)) {
    throw new AuthGuardError(403, "You do not have permission to do that.");
  }
  return session;
}
