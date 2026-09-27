import { env } from "cloudflare:workers";
import { CloudflareApiError } from "@appflare/cf-api";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  emailSendErrorMessage,
  RESET_LINK_TTL_SECONDS,
  resetEmail,
  resetPasswordUrl,
  testEmail,
} from "../auth/password-email";
import {
  PasswordEmailError,
  type PasswordEmailStatus,
  passwordEmailStatus,
  sendEmail,
  setPasswordEmailSender,
} from "../auth/password-email.server";
import {
  issueRecoveryCode,
  parseStoredRecovery,
  type RecoveryMethod,
} from "../auth/recovery.server";
import { CfTokenNotConfiguredError, getCfClient } from "../cloudflare/client.server";
import { createDb } from "../db/client";
import { user } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { refuseDuringSelfUpdate } from "../jobs/self-update/guard";
import { currentAuth, requireRole } from "./auth.server";
import { userIdInput } from "./schemas";
import { ensureOwner, isOwner, OWNER_ONLY_MESSAGE, passwordResetTarget } from "./users.server";

/**
 * Password recovery: what the sign-in page offers, the owner's "Password
 * reset emails" setting, and an admin resetting another user's password.
 */

/** Anyone, signed in or not: whether "Forgot your password?" can send a reset link. */
export const getPasswordRecoveryOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ emailReset: boolean }> => {
    const status = await passwordEmailStatus(env.DB, env.AUTH_EMAIL);
    return { emailReset: status.enabled };
  },
);

export interface PasswordRecoverySettings {
  email: PasswordEmailStatus;
  /** The viewer may change the reset email setting. */
  viewerIsOwner: boolean;
  /** The last password reset done without the old password. */
  lastRecovery: {
    /** ISO 8601. */
    at: string;
    method: RecoveryMethod;
    /** Null when that user no longer exists. */
    email: string | null;
  } | null;
}

/** Admin only: Settings > Users, "Forgotten passwords". */
export const getPasswordRecoverySettings = createServerFn({ method: "GET" }).handler(
  async (): Promise<PasswordRecoverySettings> => {
    const session = await requireRole("admin");
    const orm = createDb(env.DB);
    await ensureOwner(orm);
    const [email, owner, stored] = await Promise.all([
      passwordEmailStatus(env.DB, env.AUTH_EMAIL),
      isOwner(orm, session.user.id),
      readSettings(orm, [SETTING.lastPasswordRecovery]),
    ]);
    const last = parseStoredRecovery(stored.last_password_recovery);
    let lastRecovery: PasswordRecoverySettings["lastRecovery"] = null;
    if (last !== null) {
      const [row] = await orm
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, last.userId))
        .limit(1);
      lastRecovery = { at: last.at, method: last.method, email: row?.email ?? null };
    }
    return { email, viewerIsOwner: owner, lastRecovery };
  },
);

function explained(error: unknown): never {
  if (
    error instanceof PasswordEmailError ||
    error instanceof CloudflareApiError ||
    error instanceof CfTokenNotConfiguredError
  ) {
    throw new Error(error.message);
  }
  throw error;
}

async function requireOwnerSession() {
  const session = await requireRole("admin");
  const orm = createDb(env.DB);
  await ensureOwner(orm);
  if (!(await isOwner(orm, session.user.id))) throw new Error(OWNER_ONLY_MESSAGE);
  return session;
}

/**
 * Owner only: turns password reset emails on with a sender address, or off
 * (`sender: null`). Either deploys a new version of Appflare with the
 * `AUTH_EMAIL` binding added or removed, so it waits for a self-update.
 */
export const setPasswordResetEmails = createServerFn({ method: "POST" })
  .validator(z.object({ sender: z.email().max(254).nullable() }))
  .handler(async ({ data }): Promise<{ versionId: string }> => {
    await requireOwnerSession();
    await refuseDuringSelfUpdate(env.DB, env.JOBS, (message) => new Error(message));
    try {
      return await setPasswordEmailSender(
        { d1: env.DB, api: await getCfClient(env), now: new Date() },
        data.sender === null ? null : data.sender.toLowerCase(),
      );
    } catch (error) {
      explained(error);
    }
  });

export const EMAIL_NOT_READY =
  "Appflare is still restarting with reset emails turned on. Try again in a few seconds.";
export const EMAIL_OFF = "Password reset emails are off. Turn them on first.";

/** Owner only: sends a test email to the owner's own address. */
export const sendTestPasswordEmail = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ to: string }> => {
    const session = await requireOwnerSession();
    const status = await passwordEmailStatus(env.DB, env.AUTH_EMAIL);
    if (status.sender === null) throw new Error(EMAIL_OFF);
    const binding = env.AUTH_EMAIL;
    if (binding === undefined) throw new Error(EMAIL_NOT_READY);
    const origin = new URL(getRequest().url).origin;
    try {
      await sendEmail(binding, testEmail({ from: status.sender, to: session.user.email, origin }));
    } catch (error) {
      throw new Error(emailSendErrorMessage(error));
    }
    return { to: session.user.email };
  },
);

/**
 * Admin only: emails another user a link to choose a new password. The
 * link is Better Auth's own reset token (the one "Forgot your password?"
 * sends), created here so a failed send can be reported to the admin.
 */
export const sendPasswordResetLink = createServerFn({ method: "POST" })
  .validator(userIdInput)
  .handler(async ({ data }): Promise<{ email: string }> => {
    const session = await requireRole("admin");
    const target = await passwordResetTarget(createDb(env.DB), session.user.id, data);
    const status = await passwordEmailStatus(env.DB, env.AUTH_EMAIL);
    const binding = env.AUTH_EMAIL;
    if (!status.enabled || binding === undefined || status.sender === null) {
      throw new Error(EMAIL_OFF);
    }
    const token = randomToken();
    const context = await currentAuth().$context;
    // Better Auth's `/reset-password` accepts the token stored under this identifier.
    await context.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: target.id,
      expiresAt: new Date(Date.now() + RESET_LINK_TTL_SECONDS * 1000),
    });
    const origin = new URL(getRequest().url).origin;
    try {
      await sendEmail(
        binding,
        resetEmail({ from: status.sender, to: target.email, url: resetPasswordUrl(origin, token) }),
      );
    } catch (error) {
      await context.internalAdapter.deleteVerificationByIdentifier(`reset-password:${token}`);
      throw new Error(emailSendErrorMessage(error));
    }
    return { email: target.email };
  });

/**
 * Admin only: a one-time recovery code for another user, shown once. They
 * enter it with their email on the sign-in page ("Forgot your password?",
 * then "I have a recovery code"). Only its hash is stored.
 */
export const issuePasswordRecoveryCode = createServerFn({ method: "POST" })
  .validator(userIdInput)
  .handler(async ({ data }): Promise<{ email: string; code: string; expiresAt: string }> => {
    const session = await requireRole("admin");
    const target = await passwordResetTarget(createDb(env.DB), session.user.id, data);
    const { code, expiresAt } = await issueRecoveryCode(env.DB, target.id, new Date());
    return { email: target.email, code, expiresAt: expiresAt.toISOString() };
  });

/** 32 random bytes, base64url: a reset link token. */
function randomToken(): string {
  let binary = "";
  for (const b of crypto.getRandomValues(new Uint8Array(32))) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
