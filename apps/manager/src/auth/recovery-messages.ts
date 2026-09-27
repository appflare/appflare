/**
 * Wording for password recovery on the sign-in pages. Client-safe: the
 * server (`recovery.server.ts`) throws these messages, and the pages map
 * Better Auth's error codes to them rather than showing raw error text.
 */

import type { PasskeyError } from "./passkey-errors";
import { SIGN_IN_MESSAGES } from "./sign-in-errors";

export const RECOVERY_MESSAGES = {
  invalid:
    "That recovery code is not right, was already used, or has expired. Check it, or get a new one.",
  noAdmin:
    "No admin uses that email address. Check it and try again; the code keeps working until it expires.",
  tooShort: (min: number) => `Use at least ${min} characters for the new password.`,
  tooLong: (max: number) => `Use at most ${max} characters for the new password.`,
  linkInvalid:
    "This reset link is not valid any more: it was used, or it is older than 30 minutes.",
  emailOff: "Password reset emails are off on this Appflare. Use a recovery code instead.",
  emailSent:
    "If an account uses that address, a link to choose a new password is on its way. It works for 30 minutes.",
  failed: "Could not reset the password. Try again in a moment.",
} as const;

/** The endpoint under `/api/auth` that resets a password with a recovery code. */
export const RECOVERY_CODE_PATH = "/recovery-code/reset-password";

/** The command that writes a one-time recovery code, for whoever manages the Cloudflare account. */
export const RECOVER_COMMAND = "npx create-appflare recover";

/** Better Auth's password length limits (its defaults; the manager does not change them). */
export const PASSWORD_LIMITS = { min: 8, max: 128 } as const;

/** Wording for a failed "I have a recovery code" or reset-link call. */
export function recoveryErrorMessage(error: PasskeyError): string {
  if (error.status === 429) return SIGN_IN_MESSAGES.rateLimited;
  if (error.status === 403) return SIGN_IN_MESSAGES.refused;
  switch (error.code) {
    case "INVALID_RECOVERY_CODE":
      return RECOVERY_MESSAGES.invalid;
    case "NO_ADMIN_WITH_EMAIL":
      return RECOVERY_MESSAGES.noAdmin;
    case "PASSWORD_TOO_SHORT":
      return RECOVERY_MESSAGES.tooShort(PASSWORD_LIMITS.min);
    case "PASSWORD_TOO_LONG":
      return RECOVERY_MESSAGES.tooLong(PASSWORD_LIMITS.max);
    case "INVALID_TOKEN":
      return RECOVERY_MESSAGES.linkInvalid;
    case "RESET_PASSWORD_DISABLED":
      return RECOVERY_MESSAGES.emailOff;
    case "INVALID_EMAIL":
    case "VALIDATION_ERROR":
      return SIGN_IN_MESSAGES.invalidEmail;
    default:
      return RECOVERY_MESSAGES.failed;
  }
}
