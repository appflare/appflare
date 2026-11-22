import type { BetterAuthPlugin } from "@better-auth/core";
import { createAuthEndpoint, createAuthMiddleware } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import { setSessionCookie } from "better-auth/cookies";
import { type AccessSignInDeps, checkAccessSignIn } from "../access/sign-in.server";
import {
  ACCESS_SIGN_IN_PATH,
  ACCESS_SIGN_IN_REFUSED,
  SIGNED_OUT_COOKIE,
  SIGNED_OUT_MAX_AGE_SECONDS,
  signedOutHere,
} from "./access-sign-in";

/**
 * Better Auth's own limit for `/sign-in/*`: 3 requests per 10 seconds per
 * client address. The endpoint needs no password, but every call reads D1
 * and may verify a token, so it is held to what the other sign-ins get.
 */
export const ACCESS_SIGN_IN_RATE_LIMIT = { window: 10, max: 3 } as const;

/**
 * Better Auth plugin for "Sign in with Cloudflare Access": one endpoint,
 * `POST /access/sign-in`, that opens a session for the user the request's
 * verified Access sign-in belongs to (`access/sign-in.server.ts` decides),
 * and sets the session cookie the way Better Auth's own sign-ins do. A
 * refusal is a 403 with `code: ACCESS_SIGN_IN_REFUSED` and the reason; the
 * admin plugin still refuses a banned user when the session is created.
 *
 * It also keeps signing out final: signing out sets the sign-out marker
 * cookie (`SIGNED_OUT_COOKIE`, with the session cookie's attributes), which
 * keeps pages from signing the browser in through Access again by
 * themselves, and any sign-in that opens a session (password, passkey, or
 * "Continue as" here) clears it.
 */
export function accessSignIn(deps: AccessSignInDeps) {
  return {
    id: "appflare-access-sign-in",
    endpoints: {
      signInWithCloudflareAccess: createAuthEndpoint(
        ACCESS_SIGN_IN_PATH,
        { method: "POST" },
        async (ctx) => {
          const result = await checkAccessSignIn(deps, ctx.headers);
          if (!result.ok) {
            // The reason only; never the token or the email.
            if (result.reason !== "protection-off" && result.reason !== "sign-in-off") {
              console.warn(`access sign-in: refused (${result.reason})`);
            }
            throw APIError.fromStatus("FORBIDDEN", {
              code: ACCESS_SIGN_IN_REFUSED,
              message: "Cloudflare Access did not sign this request in.",
              reason: result.reason,
            });
          }
          const { internalAdapter } = ctx.context;
          const session = await internalAdapter.createSession(result.user.id);
          const user = await internalAdapter.findUserById(result.user.id);
          if (!session || user === null) {
            throw APIError.fromStatus("INTERNAL_SERVER_ERROR", {
              message: "Could not open a session.",
            });
          }
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ user: result.user });
        },
      ),
    },
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/sign-out",
          handler: createAuthMiddleware(async (ctx) => {
            ctx.setCookie(SIGNED_OUT_COOKIE, "1", {
              ...ctx.context.authCookies.sessionToken.attributes,
              maxAge: SIGNED_OUT_MAX_AGE_SECONDS,
            });
          }),
        },
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.context.newSession === null || ctx.headers === undefined) return;
            if (!signedOutHere(ctx.headers)) return;
            ctx.setCookie(SIGNED_OUT_COOKIE, "", {
              ...ctx.context.authCookies.sessionToken.attributes,
              maxAge: 0,
            });
          }),
        },
      ],
    },
    rateLimit: [
      {
        pathMatcher: (path: string) => path === ACCESS_SIGN_IN_PATH,
        ...ACCESS_SIGN_IN_RATE_LIMIT,
      },
    ],
  } satisfies BetterAuthPlugin;
}
