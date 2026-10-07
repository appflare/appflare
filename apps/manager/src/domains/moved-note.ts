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
 * Owner setup's line while the domain the install chose is pending: setup
 * happens at workers.dev with a password, and passkeys wait for the move.
 */
export function pendingAddressNote(hostname: string): string {
  return `Appflare moves to ${hostname} once it is ready. Sign in there with this password, then add a passkey.`;
}

/** Domains settings' row for the domain the install chose, while Appflare waits to move there. */
export const PENDING_ROW = {
  waiting: "Appflare moves here once it is ready.",
  failed: (hostname: string) => `Couldn't move to ${hostname}.`,
} as const;

/** Settings, Passkeys, at workers.dev while a domain is pending. */
export function passkeysAfterMoveLine(hostname: string): string {
  return `Add passkeys after Appflare moves to ${hostname}.`;
}

/** The sign-in page's line once Appflare moved here by itself or by an admin. */
export const MOVED_HERE_NOTE = "Appflare moved to this address. Sign in again with your password.";

/** How long after a move the sign-in page says Appflare moved here. */
export const MOVED_HERE_DAYS = 14;

/**
 * Whether Appflare moved to `host` (the address the sign-in page is at)
 * within {@link MOVED_HERE_DAYS}, from the address rows.
 */
export function movedHere(
  rows: { hostname: string | null; previousHostname: string | null; movedAt: string | null },
  host: string,
  now: Date,
): boolean {
  if (rows.hostname === null || rows.previousHostname === null || rows.movedAt === null) {
    return false;
  }
  if (rows.hostname.toLowerCase() !== host.toLowerCase()) return false;
  const at = Date.parse(rows.movedAt);
  return Number.isFinite(at) && now.getTime() - at < MOVED_HERE_DAYS * 86_400_000;
}

/**
 * Remembered in this browser, at this address, once someone signed in
 * here: the line that Appflare moved here is for people who have not.
 * Browser storage is per address, so the new address starts without it.
 */
export const SIGNED_IN_HERE_KEY = "appflare:signed-in-here";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage turned off: every visit counts as the first.
    return null;
  }
}

/** Whether someone signed in at this address in this browser before. */
export function signedInHereBefore(storage: Storage | null = browserStorage()): boolean {
  try {
    return storage?.getItem(SIGNED_IN_HERE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Records a sign-in at this address in this browser. */
export function rememberSignedInHere(storage: Storage | null = browserStorage()): void {
  try {
    storage?.setItem(SIGNED_IN_HERE_KEY, "1");
  } catch {
    // Not remembered: the line may show once more. Nothing else depends on it.
  }
}

/** The passkey offered right after signing in at Appflare's new address. */
export const PASSKEY_OFFER = {
  title: (host: string) => `Add a passkey for ${host}?`,
  description: "Next time, sign in with your fingerprint, face or screen lock.",
  /** The name the passkey gets; it can be told apart from others by when it was added. */
  name: "This device",
} as const;

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
