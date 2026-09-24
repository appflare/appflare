/**
 * User-facing wording for email and password sign-in failures, and for errors
 * that reach the sign-in and setup screens from server functions. Client-safe:
 * no server imports.
 *
 * Better Auth's client reports a failed call as `{ code, message, status }`.
 * Its messages are written for developers ("Invalid email or password",
 * "Too many requests. Please try again later."), so the screens show the
 * wording below instead and never the raw text.
 */

import { PASSKEY_MESSAGES, type PasskeyError } from "./passkey-errors";

export const SIGN_IN_MESSAGES = {
  wrongCredentials: "The email or password is not correct. Check both and try again.",
  invalidEmail: "Enter a valid email address.",
  rateLimited: PASSKEY_MESSAGES.rateLimited,
  refused:
    "Appflare refused the sign-in from this address. Open the manager at its own address and try again.",
  failed: "Could not sign you in. Try again in a moment.",
  unreachable: "Could not reach Appflare. Check your connection and try again.",
} as const;

export function passwordSignInErrorMessage(error: PasskeyError): string {
  const code = error.code ?? "";
  if (error.status === 429) return SIGN_IN_MESSAGES.rateLimited;
  if (code === "INVALID_EMAIL_OR_PASSWORD" || error.status === 401) {
    return SIGN_IN_MESSAGES.wrongCredentials;
  }
  if (code === "INVALID_EMAIL") return SIGN_IN_MESSAGES.invalidEmail;
  // Better Auth's origin check and a Cloudflare Access refusal both answer 403.
  if (error.status === 403) return SIGN_IN_MESSAGES.refused;
  return SIGN_IN_MESSAGES.failed;
}

/**
 * The message of an error thrown by a server function call, when it is one
 * the server wrote for people; otherwise `fallback`. A failed request (the
 * browser's `TypeError`) says Appflare could not be reached. Validation
 * failures arrive as JSON and error pages as HTML: both get `fallback`.
 */
export function serverErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof TypeError) return SIGN_IN_MESSAGES.unreachable;
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (message.length === 0 || message.length > 300 || /^[[{<]/.test(message)) return fallback;
  return message;
}
