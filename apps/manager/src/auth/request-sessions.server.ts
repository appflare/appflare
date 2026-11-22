import { ACCESS_JWT_HEADER } from "../access/jwt";
import type { AccessSignInUser } from "../access/sign-in.server";
import type { Auth } from "./server";
import { withSetCookies } from "./session-cookie";

/**
 * Sessions opened in the middle of a request, by "Sign in with Cloudflare
 * Access". Framework-free; `server/auth.server.ts` binds it to the request
 * being served and passes the cookies on to the browser.
 *
 * While a page renders on the server, every server function sees the same
 * incoming request, which does not carry a session opened during it. So the
 * cookies such a sign-in set are kept with the request (`headersFor`), and
 * every Better Auth call made for that request afterwards must forward
 * `headersFor(request)` rather than `request.headers`; otherwise the page's
 * own reads find no session right after the visitor was signed in.
 */
export interface RequestSessions {
  /** The request's headers, with the session cookies a sign-in during it set. */
  headersFor(request: Request): Headers;
  /**
   * Opens a session for the user the request's verified Access sign-in
   * belongs to (`POST /access/sign-in` through `auth.api`). Null when that
   * does not happen: no Access token (nothing is read then), a refusal, or a
   * failure, which is logged by kind only. Never throws.
   */
  signInWithAccess(
    auth: Auth,
    request: Request,
  ): Promise<{ user: AccessSignInUser; setCookies: string[] } | null>;
}

export function createRequestSessions(): RequestSessions {
  const signedIn = new WeakMap<Request, Headers>();
  return {
    headersFor(request) {
      return signedIn.get(request) ?? request.headers;
    },
    async signInWithAccess(auth, request) {
      if (!request.headers.has(ACCESS_JWT_HEADER)) return null;
      try {
        const { headers, response } = await auth.api.signInWithCloudflareAccess({
          headers: request.headers,
          returnHeaders: true,
        });
        const setCookies = headers.getSetCookie();
        signedIn.set(request, withSetCookies(request.headers, setCookies));
        return { user: response.user, setCookies };
      } catch (error) {
        // A refusal is the endpoint's 403; anything else is unexpected, but
        // never a reason to fail the page instead of showing the sign-in.
        if ((error as { statusCode?: unknown } | null)?.statusCode !== 403) {
          console.warn("access sign-in: could not sign in", {
            error: error instanceof Error ? error.name : "unknown",
          });
        }
        return null;
      }
    },
  };
}
