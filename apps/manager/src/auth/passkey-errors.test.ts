import { describe, expect, it } from "vitest";
import {
  PASSKEY_MESSAGES,
  passkeyRegistrationErrorMessage,
  passkeySignInErrorMessage,
} from "./passkey-errors";

describe("passkeySignInErrorMessage", () => {
  it("explains a closed prompt or a device without a passkey the same way", () => {
    for (const code of ["ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY", "AUTH_CANCELLED"]) {
      expect(passkeySignInErrorMessage({ code, message: "Auth cancelled", status: 400 })).toBe(
        PASSKEY_MESSAGES.noPasskeyUsed,
      );
    }
  });

  it("says when the passkey is not registered here", () => {
    expect(passkeySignInErrorMessage({ code: "PASSKEY_NOT_FOUND", status: 401 })).toBe(
      PASSKEY_MESSAGES.unknownPasskey,
    );
  });

  it("maps rate limiting and wrong addresses", () => {
    expect(passkeySignInErrorMessage({ status: 429 })).toBe(PASSKEY_MESSAGES.rateLimited);
    expect(passkeySignInErrorMessage({ code: "ERROR_INVALID_RP_ID" })).toBe(
      PASSKEY_MESSAGES.wrongAddress,
    );
  });

  it("never shows the server's own message", () => {
    expect(
      passkeySignInErrorMessage({ code: "BANNED_USER", message: "You have been banned" }),
    ).toBe(PASSKEY_MESSAGES.signInFailed);
    expect(passkeySignInErrorMessage({ message: "Invalid origin", status: 403 })).toBe(
      PASSKEY_MESSAGES.wrongAddress,
    );
    expect(
      passkeySignInErrorMessage({
        code: "AUTHENTICATION_FAILED",
        message: "Authentication failed",
      }),
    ).toBe(PASSKEY_MESSAGES.signInFailed);
    expect(passkeySignInErrorMessage({})).toBe(PASSKEY_MESSAGES.signInFailed);
  });
});

describe("passkeyRegistrationErrorMessage", () => {
  it("maps the browser's and the server's codes", () => {
    expect(
      passkeyRegistrationErrorMessage({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" }),
    ).toBe(PASSKEY_MESSAGES.alreadyRegistered);
    expect(passkeyRegistrationErrorMessage({ code: "ERROR_CEREMONY_ABORTED" })).toBe(
      PASSKEY_MESSAGES.registerCancelled,
    );
    expect(passkeyRegistrationErrorMessage({ code: "SESSION_NOT_FRESH", status: 403 })).toBe(
      PASSKEY_MESSAGES.staleSession,
    );
    expect(passkeyRegistrationErrorMessage({ code: "FAILED_TO_VERIFY_REGISTRATION" })).toBe(
      PASSKEY_MESSAGES.registerFailed,
    );
  });
});
