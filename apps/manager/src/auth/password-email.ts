/**
 * Password reset emails: what they say, and plain wording for Email Sending's
 * errors. Sent through the manager's optional `send_email` binding
 * (`AUTH_EMAIL`), which the owner turns on in Settings > Users with a sender
 * address on a domain set up for Cloudflare Email Sending.
 */

import { safeReturnPath } from "../components/internal-path";

/** The binding the manager adds to itself when reset emails are turned on. */
export const AUTH_EMAIL_BINDING = "AUTH_EMAIL";

/** How long a reset link works, in seconds (the same as a recovery code). */
export const RESET_LINK_TTL_SECONDS = 30 * 60;

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The link a reset email carries: the manager's own page, with Better Auth's
 * token, and the page to return to after signing in again when it is one of
 * the manager's pages.
 */
export function resetPasswordUrl(origin: string, token: string, returnTo?: unknown): string {
  const url = new URL("/reset-password", origin);
  url.searchParams.set("token", token);
  const back = safeReturnPath(returnTo);
  if (back !== null && back !== "/") url.searchParams.set("returnTo", back);
  return url.toString();
}

/**
 * The return path the reset request asked for. Better Auth hands the email
 * sender its own link, `…/reset-password/<token>?callbackURL=<redirectTo>`,
 * where `redirectTo` is what the forgot-password page sent
 * (`/reset-password?returnTo=…`); anything unreadable gives nothing.
 */
export function returnToFromResetRequest(betterAuthUrl: string): string | undefined {
  try {
    const callback = new URL(betterAuthUrl).searchParams.get("callbackURL");
    if (callback === null || !callback.startsWith("/")) return undefined;
    const back = new URL(callback, "https://manager.invalid").searchParams.get("returnTo");
    return safeReturnPath(back) ?? undefined;
  } catch {
    return undefined;
  }
}

export function resetEmail(args: { from: string; to: string; url: string }): OutgoingEmail {
  const host = new URL(args.url).host;
  const text = [
    `Someone asked to reset the password of ${args.to} on Appflare (${host}).`,
    "",
    "To choose a new password, open this link within 30 minutes:",
    args.url,
    "",
    "If that was not you, ignore this email. Your password stays the same.",
  ].join("\n");
  const html = [
    `<p>Someone asked to reset the password of ${escapeHtml(args.to)} on Appflare (${escapeHtml(host)}).</p>`,
    `<p><a href="${escapeHtml(args.url)}">Choose a new password</a>. The link works for 30 minutes.</p>`,
    "<p>If that was not you, ignore this email. Your password stays the same.</p>",
  ].join("\n");
  return { from: args.from, to: args.to, subject: "Reset your Appflare password", text, html };
}

export function testEmail(args: { from: string; to: string; origin: string }): OutgoingEmail {
  const host = new URL(args.origin).host;
  const text = [
    `This is a test from Appflare (${host}).`,
    "",
    "Password reset emails work: people who forget their password can ask for a reset link on the sign-in page.",
  ].join("\n");
  const html = `<p>This is a test from Appflare (${escapeHtml(host)}).</p>\n<p>Password reset emails work: people who forget their password can ask for a reset link on the sign-in page.</p>`;
  return { from: args.from, to: args.to, subject: "Appflare test email", text, html };
}

/** Plain wording for an error thrown by `SendEmail.send()` (errors carry a `code`). */
export function emailSendErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  switch (code) {
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return "Cloudflare did not send it: the sender address's domain is not set up for Email Sending. Set it up under Email Service in the Cloudflare dashboard, or use an address on a domain that is.";
    case "E_RECIPIENT_NOT_ALLOWED":
    case "E_RECIPIENT_SUPPRESSED":
      return "Cloudflare did not send it to that address. Without Email Sending (Workers Paid), Appflare can only send to addresses verified in the account's Email Routing.";
    case "E_RATE_LIMIT_EXCEEDED":
      return "Cloudflare is limiting how much this account sends. Try again in a few minutes.";
    case "E_DELIVERY_FAILED":
      return "Cloudflare could not deliver it. Check the address and try again.";
    default:
      return "Cloudflare did not send the email. Check that the sender address's domain is set up for Email Sending, then try again.";
  }
}
