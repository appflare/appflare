import { describe, expect, it } from "vitest";
import { PASSKEY_MESSAGES } from "./passkey-errors";
import { passwordSignInErrorMessage, SIGN_IN_MESSAGES, serverErrorMessage } from "./sign-in-errors";

describe("passwordSignInErrorMessage", () => {
  it("says the email or password is wrong without Better Auth's wording", () => {
    const message = passwordSignInErrorMessage({
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password",
      status: 401,
    });
    expect(message).toBe(SIGN_IN_MESSAGES.wrongCredentials);
    expect(passwordSignInErrorMessage({ status: 401 })).toBe(SIGN_IN_MESSAGES.wrongCredentials);
  });

  it("maps rate limiting, a malformed email and refusals", () => {
    expect(
      passwordSignInErrorMessage({
        message: "Too many requests. Please try again later.",
        status: 429,
      }),
    ).toBe(PASSKEY_MESSAGES.rateLimited);
    expect(passwordSignInErrorMessage({ code: "INVALID_EMAIL", status: 400 })).toBe(
      SIGN_IN_MESSAGES.invalidEmail,
    );
    expect(passwordSignInErrorMessage({ message: "Invalid origin", status: 403 })).toBe(
      SIGN_IN_MESSAGES.refused,
    );
  });

  it("never shows a raw message", () => {
    expect(
      passwordSignInErrorMessage({
        code: "BANNED_USER",
        message: "You have been banned",
        status: 403,
      }),
    ).not.toContain("banned");
    expect(passwordSignInErrorMessage({ message: "Internal Server Error", status: 500 })).toBe(
      SIGN_IN_MESSAGES.failed,
    );
    expect(passwordSignInErrorMessage({})).toBe(SIGN_IN_MESSAGES.failed);
  });
});

describe("serverErrorMessage", () => {
  it("keeps a message the server wrote for people", () => {
    expect(serverErrorMessage(new Error("Setup is already complete. Sign in instead."), "x")).toBe(
      "Setup is already complete. Sign in instead.",
    );
  });

  it("replaces validation output, error pages and empty messages", () => {
    const issues = JSON.stringify([{ code: "too_small", path: ["password"] }]);
    expect(serverErrorMessage(new Error(issues), "fallback")).toBe("fallback");
    expect(serverErrorMessage(new Error("<!doctype html><html>"), "fallback")).toBe("fallback");
    expect(serverErrorMessage(new Error("  "), "fallback")).toBe("fallback");
    expect(serverErrorMessage("not an error", "fallback")).toBe("fallback");
  });

  it("says Appflare could not be reached when the request failed", () => {
    expect(serverErrorMessage(new TypeError("Failed to fetch"), "fallback")).toBe(
      SIGN_IN_MESSAGES.unreachable,
    );
  });
});
