import { sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { user } from "../db/schema";
import { readAccessSignInState } from "./config";
import { ACCESS_JWT_HEADER, type AccessJwtFailure, verifyAccessJwt } from "./jwt";
import { type AccessKeyStore, accessKeyStore } from "./keys";

/**
 * "Sign in with Cloudflare Access": whether a request's Access sign-in may
 * stand in for Appflare's own. Framework-free; the Better Auth plugin
 * (auth/access-sign-in-plugin.ts) turns a yes into a session.
 *
 * Yes only when protection is on and an admin turned the switch on (both
 * read from D1 on every call, never cached), the request's
 * `Cf-Access-Jwt-Assertion` verifies against the stored application (its own
 * check, not the request gate's word for it), the token names an email (a
 * service token names none), and exactly one existing user has that email,
 * compared without regard to case, and is not banned. It never creates a
 * user. The token never appears in a result or a log line.
 */

export type AccessSignInRefusal =
  /** Cloudflare Access protection is off. */
  | "protection-off"
  /** Protection is on, but "Sign in with Cloudflare Access" is off. */
  | "sign-in-off"
  /** The request's Access token is missing or does not verify. */
  | AccessJwtFailure
  /** The token names no email: a service token. */
  | "no-email"
  /** No user has the token's email. */
  | "no-user"
  /** More than one user has the email once case is ignored. */
  | "ambiguous-user"
  /** The user is banned. */
  | "banned";

/** The user a verified Access sign-in belongs to. */
export interface AccessSignInUser {
  id: string;
  email: string;
  name: string;
  role: string | null;
  isOwner: boolean;
}

export type AccessSignInResult =
  | { ok: true; user: AccessSignInUser }
  | { ok: false; reason: AccessSignInRefusal };

export interface AccessSignInDeps {
  d1: D1Database;
  /** The team's signing keys; the isolate's shared store unless a test supplies one. */
  keys?: AccessKeyStore;
  /** Epoch ms. */
  now?: () => number;
}

export async function checkAccessSignIn(
  deps: AccessSignInDeps,
  headers: Headers | null | undefined,
): Promise<AccessSignInResult> {
  const { config, signInEnabled } = await readAccessSignInState(deps.d1);
  if (config === null) return { ok: false, reason: "protection-off" };
  if (!signInEnabled) return { ok: false, reason: "sign-in-off" };

  const nowMs = (deps.now ?? Date.now)();
  const keys = deps.keys ?? accessKeyStore;
  const verified = await verifyAccessJwt(
    headers?.get(ACCESS_JWT_HEADER),
    { aud: config.aud, teamDomain: config.teamDomain },
    keys.lookup(config.teamDomain),
    nowMs,
  );
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const email = verified.identity.email?.trim() ?? "";
  if (email.length === 0) return { ok: false, reason: "no-email" };

  const rows = await createDb(deps.d1)
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isOwner: user.isOwner,
      banned: user.banned,
      banExpires: user.banExpires,
    })
    .from(user)
    .where(sql`lower(${user.email}) = ${email.toLowerCase()}`)
    .limit(2);
  const [found, other] = rows;
  if (found === undefined) return { ok: false, reason: "no-user" };
  if (other !== undefined) return { ok: false, reason: "ambiguous-user" };
  // A ban whose end has passed no longer counts; Better Auth lifts it when
  // the session is created.
  if (found.banned === true && (found.banExpires === null || found.banExpires.getTime() > nowMs)) {
    return { ok: false, reason: "banned" };
  }
  return {
    ok: true,
    user: {
      id: found.id,
      email: found.email,
      name: found.name,
      role: found.role,
      isOwner: found.isOwner === true,
    },
  };
}

/**
 * For the sign-in page: the email of the user `headers`' verified Access
 * sign-in belongs to, while the switch is on; otherwise null. A request
 * without an Access token reads nothing, and a failure counts as no offer.
 */
export async function accessSignInOfferFor(
  deps: AccessSignInDeps,
  headers: Headers,
): Promise<string | null> {
  if (!headers.has(ACCESS_JWT_HEADER)) return null;
  try {
    const result = await checkAccessSignIn(deps, headers);
    return result.ok ? result.user.email : null;
  } catch {
    return null;
  }
}
