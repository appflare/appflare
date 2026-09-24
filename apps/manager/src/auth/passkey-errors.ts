/**
 * User-facing wording for passkey failures. Client-safe: no server imports.
 *
 * Errors arrive from Better Auth's passkey client in one shape, `{ code, message,
 * status }`, whether they came from the browser's WebAuthn call (codes like
 * `ERROR_CEREMONY_ABORTED`, from `@simplewebauthn/browser`) or from the server
 * (codes like `PASSKEY_NOT_FOUND`). Browsers deliberately do not reveal whether a
 * device holds a passkey for a site: "there is none" and "the user closed the
 * prompt" both surface as the same `NotAllowedError`, so the wording covers both.
 */

export interface PasskeyError {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
}

/** True when this browser can run WebAuthn ceremonies at all. */
export function passkeysSupported(): boolean {
  return typeof globalThis.PublicKeyCredential === "function";
}

export const PASSKEY_MESSAGES = {
  unsupported: "This browser does not support passkeys. Sign in with your email and password.",
  noPasskeyUsed:
    "No passkey was used. This device may not have a passkey for this manager, or the prompt was closed. Sign in with your email and password, then add a passkey in Settings.",
  unknownPasskey:
    "That passkey is not registered with this manager; it may have been removed. Sign in with your email and password.",
  expired: "The passkey prompt timed out. Try again.",
  wrongAddress:
    "Passkeys cannot be used at this address. Open the manager at its own address and try again.",
  rateLimited: "Too many sign-in attempts. Wait a minute, then try again.",
  signInFailed: "Passkey sign-in failed. Try again, or sign in with your email and password.",
  registerUnsupported: "This browser does not support passkeys.",
  alreadyRegistered: "This device already has a passkey for your account.",
  registerCancelled: "The passkey prompt was closed before a passkey was created.",
  staleSession:
    "Adding a passkey needs a sign-in from the last 24 hours. Sign out, sign in again, then add the passkey.",
  registerFailed: "Could not add the passkey. Try again.",
} as const;

/** Codes meaning the browser's passkey prompt ended without a passkey. */
const PROMPT_ENDED = new Set([
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
  "ERROR_CEREMONY_ABORTED",
  "AUTH_CANCELLED",
]);

const WRONG_ADDRESS = new Set(["ERROR_INVALID_DOMAIN", "ERROR_INVALID_RP_ID"]);

export function passkeySignInErrorMessage(error: PasskeyError): string {
  const code = error.code ?? "";
  if (error.status === 429) return PASSKEY_MESSAGES.rateLimited;
  if (PROMPT_ENDED.has(code)) return PASSKEY_MESSAGES.noPasskeyUsed;
  if (WRONG_ADDRESS.has(code)) return PASSKEY_MESSAGES.wrongAddress;
  if (code === "PASSKEY_NOT_FOUND") return PASSKEY_MESSAGES.unknownPasskey;
  if (code === "CHALLENGE_NOT_FOUND") return PASSKEY_MESSAGES.expired;
  // Better Auth's origin check and a Cloudflare Access refusal both answer 403.
  if (error.status === 403) return PASSKEY_MESSAGES.wrongAddress;
  // Anything else carries wording written for developers, never shown as is.
  return PASSKEY_MESSAGES.signInFailed;
}

export function passkeyRegistrationErrorMessage(error: PasskeyError): string {
  const code = error.code ?? "";
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || code === "PREVIOUSLY_REGISTERED") {
    return PASSKEY_MESSAGES.alreadyRegistered;
  }
  if (PROMPT_ENDED.has(code) || code === "REGISTRATION_CANCELLED") {
    return PASSKEY_MESSAGES.registerCancelled;
  }
  if (WRONG_ADDRESS.has(code)) return PASSKEY_MESSAGES.wrongAddress;
  if (code === "SESSION_NOT_FRESH") return PASSKEY_MESSAGES.staleSession;
  if (code === "CHALLENGE_NOT_FOUND") return PASSKEY_MESSAGES.expired;
  return PASSKEY_MESSAGES.registerFailed;
}
