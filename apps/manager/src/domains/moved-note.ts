import { z } from "zod";
import { returnToSearchSchema } from "../components/return-to";

/**
 * The sign-in page right after Appflare changed its address: the move sends
 * the browser to `/login?returnTo=<page>&moved=1` at the new address, where
 * nobody is signed in yet (sessions belong to one address), and the page
 * says why. Client-safe.
 */

/** What becomes of passkeys when Appflare changes its address. */
export const MOVED_PASSKEY_NOTE =
  "Passkeys added at the old address work only there; add new ones in Users and sign-in.";

export const MOVED_SIGN_IN_NOTE = `Sign in again at the new address. ${MOVED_PASSKEY_NOTE}`;

/**
 * `moved=1`, read as true; anything else as nothing. The router parses
 * search values as JSON, so the `1` arrives as a number.
 */
const movedField = z
  .union([z.literal(1), z.literal("1")])
  .optional()
  .catch(undefined)
  .transform((value): true | undefined => (value === undefined ? undefined : true));

/** `validateSearch` of the sign-in page: the return path, and whether Appflare just moved. */
export const loginSearchSchema = returnToSearchSchema.extend({ moved: movedField });

/** Whether the sign-in page shows {@link MOVED_SIGN_IN_NOTE}. */
export function showsMovedNote(search: { returnTo?: string | undefined; moved?: true }): boolean {
  return search.moved === true && search.returnTo !== undefined;
}
