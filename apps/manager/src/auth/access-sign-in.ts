/**
 * "Sign in with Cloudflare Access", as the sign-in page and the settings
 * card see it. Client-safe: the endpoint lives in `access-sign-in-plugin.ts`.
 */

import type { PasskeyError } from "./passkey-errors";
import { SIGN_IN_MESSAGES } from "./sign-in-errors";

/** The endpoint under `/api/auth` that opens a session from the request's Access sign-in. */
export const ACCESS_SIGN_IN_PATH = "/access/sign-in";

/**
 * Set when someone signs out in this browser, cleared by their next sign-in
 * of any kind. While it is there, pages do not sign the browser in through
 * Cloudflare Access by themselves; the sign-in page still offers it. Holds
 * nothing secret: its presence is all that counts.
 */
export const SIGNED_OUT_COOKIE = "appflare.signed_out";

/** How long the sign-out sticks without another sign-in: a year. */
export const SIGNED_OUT_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Whether `headers` carry the sign-out marker. */
export function signedOutHere(headers: Headers): boolean {
  return (headers.get("cookie") ?? "").split(";").some((part) => {
    const at = part.indexOf("=");
    return (at === -1 ? part : part.slice(0, at)).trim() === SIGNED_OUT_COOKIE;
  });
}

/** The error code of every refusal; the response's `reason` says which. */
export const ACCESS_SIGN_IN_REFUSED = "ACCESS_SIGN_IN_REFUSED";

export const ACCESS_SIGN_IN_COPY = {
  switchLabel: "Sign in with Cloudflare Access",
  switchDescription:
    "Signs in an existing Appflare user whose email matches their Cloudflare Access sign-in, without asking for a password again; it never adds users.",
  membersOnly: "Only admins can change this.",
  continueAs: (email: string) => `Continue as ${email}`,
  refused:
    "Cloudflare Access did not sign you in to Appflare. Reload the page, or sign in with your email and password.",
  /** The reset dialog's promise, while Access sign-in can bring someone straight back. */
  resetSignsOut: (email: string) =>
    `${email} chooses a new password themselves. Their current password works until they do; then they are signed out everywhere, except that a browser still signed in to Cloudflare Access signs them back in. To cut someone off, ban or remove them.`,
} as const;

/** Wording for a failed "Continue as" call. */
export function accessSignInErrorMessage(error: PasskeyError): string {
  if (error.status === 429) return SIGN_IN_MESSAGES.rateLimited;
  if (error.code === ACCESS_SIGN_IN_REFUSED || error.status === 403) {
    return ACCESS_SIGN_IN_COPY.refused;
  }
  return SIGN_IN_MESSAGES.failed;
}
