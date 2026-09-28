import { z } from "zod";
import { MAX_RETURN_PATH_LENGTH, safeReturnPath } from "./internal-path";

/**
 * The page a visitor asked for before being sent to sign in (or to finish
 * setup), carried through the sign-in pages as `?returnTo=<path>` and
 * opened once they are in. It comes from the address bar, so every reader
 * checks it again (`safeReturnPath`) and goes home when it is not one of
 * this manager's pages. The page's section (`#secrets`) travels inside the
 * value: a browser never sends a fragment to the server, so the page that
 * asked keeps it on the client side and hands it over whole.
 */

/** The sign-in pages that carry a return path along. */
export type SignInPage = "/login" | "/setup" | "/forgot-password" | "/reset-password";

/**
 * The `returnTo` search field of the sign-in pages: the path when it is safe,
 * else nothing (a hostile or malformed value never fails the page).
 */
export const returnToField = z
  .string()
  .max(MAX_RETURN_PATH_LENGTH)
  .optional()
  .catch(undefined)
  .transform((value) => safeReturnPath(value) ?? undefined);

/** `validateSearch` for a sign-in page that carries nothing but the return path. */
export const returnToSearchSchema = z.object({ returnTo: returnToField });

/** The path to keep, or null: unsafe values and home (the default anyway) are dropped. */
function keptPath(returnTo: unknown): string | null {
  const path = safeReturnPath(returnTo);
  return path === null || path === "/" ? null : path;
}

/** Search params that carry `returnTo` along, or none. */
export function returnToSearch(returnTo: unknown): { returnTo?: string } {
  const path = keptPath(returnTo);
  return path === null ? {} : { returnTo: path };
}

/** A sign-in page's href, with the return path when there is one to keep. */
export function withReturnTo(page: SignInPage, returnTo: unknown): string {
  const path = keptPath(returnTo);
  return path === null ? page : `${page}?${new URLSearchParams({ returnTo: path }).toString()}`;
}

/** Where to go once signed in: the page asked for when it is safe, else home. */
export function afterSignIn(returnTo: unknown): string {
  return safeReturnPath(returnTo) ?? "/";
}
