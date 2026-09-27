import {
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  parseRecoveryCodeSecret,
  RECOVERY_CODE_TTL_MS,
  type RecoveryCodeSecret,
} from "@appflare/schema";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db/client";
import { user, verification } from "../db/schema";
import { SETTING, writeSettings } from "../db/settings";
import { constantTimeEquals } from "./constant-time";
import { RECOVERY_MESSAGES } from "./recovery-messages";
import { hasRole } from "./roles";

/**
 * Resetting a password with a recovery code, from the sign-in page, without
 * the old password. Two kinds of code work:
 *
 * - **From the Cloudflare account.** `create-appflare recover` writes the
 *   code's hash and expiry as the Worker secret `RECOVERY_CODE_HASH`. Whoever
 *   can write that secret controls the manager's Worker, so the code may
 *   reset any admin's password (the owner's included). It is single use: the
 *   hash of the code is recorded as used in the same statement that claims it,
 *   and the secret is deleted afterwards (a version without it takes a few
 *   seconds to serve everywhere; the record covers that gap). With
 *   `recover --email` the code works only with that one email. Its expiry
 *   comes from the installer's clock, so the manager also caps it by its own:
 *   35 minutes after the version holding the secret was created (the secret
 *   write created it), or after now when that time is unknown.
 * - **Issued by an admin** in Settings > Users for one other user. Its hash
 *   lives in Better Auth's `verification` table under that user, replacing any
 *   earlier one, and the row is deleted when it is used. It never resets the
 *   owner's password, even when its user became the owner after it was issued.
 *
 * Both expire after 30 minutes. Codes are compared as SHA-256 hashes in
 * constant time; the endpoint in front of this is rate limited per client
 * address. A wrong, used or expired code gets the same answer whether or not
 * the email belongs to anyone. Nothing here logs a code or an email address.
 */

export type RecoveryMethod = "account_code" | "issued_code" | "email_link";

export type RecoveryErrorCode =
  | "INVALID_RECOVERY_CODE"
  | "NO_ADMIN_WITH_EMAIL"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG";

export { RECOVERY_MESSAGES };

/** A refused reset; its message is shown as is. */
export class RecoveryError extends Error {
  override name = "RecoveryError";
  constructor(
    readonly code: RecoveryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const ISSUED_PREFIX = "appflare-recovery-code:";

/** The `verification` identifier of the code an admin issued for `userId`. */
export function issuedCodeIdentifier(userId: string): string {
  return `${ISSUED_PREFIX}${userId}`;
}

/** How far the installer's clock may run ahead of Cloudflare's. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * When an account code stops working: its own expiry, capped at 35 minutes
 * after `since` (when the version holding it was created), or after `now`.
 */
export function accountCodeExpiry(secret: RecoveryCodeSecret, now: number, since?: number): number {
  const anchor = since !== undefined && Number.isFinite(since) ? since : now;
  return Math.min(secret.expiresAt, anchor + RECOVERY_CODE_TTL_MS + CLOCK_SKEW_MS);
}

/** Epoch ms the serving version was created, from its `version_metadata` binding. */
export function versionCreatedAt(metadata: { timestamp?: string } | undefined): number | undefined {
  const at = Date.parse(metadata?.timestamp ?? "");
  return Number.isFinite(at) ? at : undefined;
}

/** The hash of the last account code that was used, if any. */
export async function usedAccountCode(d1: D1Database): Promise<string | null> {
  const row = await d1
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(SETTING.recoveryCodeUsed)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export interface RecoverDeps {
  d1: D1Database;
  now: Date;
  /** `RECOVERY_CODE_HASH` of the version serving this request. */
  accountSecret: string | undefined;
  /** Epoch ms the serving version was created (`CF_VERSION_METADATA.timestamp`). */
  accountSecretSince?: number | undefined;
  /** Better Auth's password length limits. */
  passwordLimits: { min: number; max: number };
  /** Sets the user's password and signs them out everywhere. */
  setPassword(userId: string, newPassword: string): Promise<void>;
}

export interface RecoverInput {
  email: string;
  code: string;
  newPassword: string;
}

export interface RecoverResult {
  userId: string;
  method: Exclude<RecoveryMethod, "email_link">;
}

/** Hash of a value that is never a code, so a malformed code costs the same work. */
const NO_CODE = "-";

export async function recoverWithCode(
  deps: RecoverDeps,
  input: RecoverInput,
): Promise<RecoverResult> {
  const { min, max } = deps.passwordLimits;
  if (input.newPassword.length < min) {
    throw new RecoveryError("PASSWORD_TOO_SHORT", RECOVERY_MESSAGES.tooShort(min));
  }
  if (input.newPassword.length > max) {
    throw new RecoveryError("PASSWORD_TOO_LONG", RECOVERY_MESSAGES.tooLong(max));
  }
  const invalid = () => new RecoveryError("INVALID_RECOVERY_CODE", RECOVERY_MESSAGES.invalid);
  const normalized = normalizeRecoveryCode(input.code);
  const hash = await hashRecoveryCode(normalized ?? NO_CODE);
  const now = deps.now.getTime();
  const db = createDb(deps.d1);

  const [target] = await db
    .select({ id: user.id, role: user.role, isOwner: user.isOwner })
    .from(user)
    .where(eq(user.email, input.email.trim().toLowerCase()))
    .limit(1);

  // A code issued for this user. Looked up for an unknown email too (under an
  // id no user has), so the answer takes as long either way.
  const [issued] = await db
    .select({ id: verification.id, value: verification.value, expiresAt: verification.expiresAt })
    .from(verification)
    .where(eq(verification.identifier, issuedCodeIdentifier(target?.id ?? "")))
    .limit(1);
  const issuedMatches =
    (await constantTimeEquals(hash, issued?.value)) &&
    normalized !== null &&
    issued !== undefined &&
    issued.expiresAt.getTime() > now;
  if (issuedMatches && target !== undefined) {
    // Issued before this user became the owner: an admin's code must not reach the owner.
    if (target.isOwner === true) throw invalid();
    const claimed = await db
      .delete(verification)
      .where(and(eq(verification.id, issued.id), eq(verification.value, issued.value)))
      .returning({ id: verification.id });
    if (claimed.length === 0) throw invalid();
    await deps.setPassword(target.id, input.newPassword);
    await recordRecovery(deps.d1, { at: deps.now, method: "issued_code", userId: target.id });
    return { userId: target.id, method: "issued_code" };
  }

  const secret = parseRecoveryCodeSecret(deps.accountSecret);
  const accountHash =
    secret?.emailBound === true ? await hashRecoveryCode(normalized ?? NO_CODE, input.email) : hash;
  const accountMatches =
    (await constantTimeEquals(accountHash, secret?.hash)) &&
    normalized !== null &&
    secret !== null &&
    accountCodeExpiry(secret, now, deps.accountSecretSince) > now;
  if (!accountMatches) throw invalid();
  if ((await usedAccountCode(deps.d1)) === secret.hash) throw invalid();
  // The code is right. It resets admins only; members ask an admin.
  if (target === undefined || !hasRole(target.role, "admin")) {
    throw new RecoveryError("NO_ADMIN_WITH_EMAIL", RECOVERY_MESSAGES.noAdmin);
  }
  if (!(await claimAccountCode(deps.d1, secret.hash, deps.now))) throw invalid();
  await deps.setPassword(target.id, input.newPassword);
  await recordRecovery(deps.d1, { at: deps.now, method: "account_code", userId: target.id });
  return { userId: target.id, method: "account_code" };
}

/**
 * Records `hash` as the used account code. One statement, so of two requests
 * with the same code only one gets the row back and goes on.
 */
async function claimAccountCode(d1: D1Database, hash: string, now: Date): Promise<boolean> {
  const row = await d1
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE settings.value <> excluded.value
       RETURNING key`,
    )
    .bind(SETTING.recoveryCodeUsed, hash, now.getTime())
    .first<{ key: string }>();
  return row !== null;
}

export interface RecoveryRecord {
  at: Date;
  method: RecoveryMethod;
  userId: string;
}

/**
 * Keeps the last password reset done without the old password, for Settings
 * > Users, and logs it by user id and method only.
 */
export async function recordRecovery(d1: D1Database, record: RecoveryRecord): Promise<void> {
  console.log("password reset without the old password", {
    method: record.method,
    userId: record.userId,
  });
  await writeSettings(
    createDb(d1),
    {
      [SETTING.lastPasswordRecovery]: JSON.stringify({
        at: record.at.toISOString(),
        method: record.method,
        userId: record.userId,
      }),
    },
    record.at,
  );
}

export interface StoredRecovery {
  /** ISO 8601. */
  at: string;
  method: RecoveryMethod;
  userId: string;
}

export function parseStoredRecovery(value: string | undefined): StoredRecovery | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredRecovery>;
    const methods: readonly string[] = ["account_code", "issued_code", "email_link"];
    if (
      typeof parsed.at !== "string" ||
      typeof parsed.userId !== "string" ||
      typeof parsed.method !== "string" ||
      !methods.includes(parsed.method)
    ) {
      return null;
    }
    return { at: parsed.at, method: parsed.method, userId: parsed.userId };
  } catch {
    return null;
  }
}

/**
 * A new code for `userId`, replacing any earlier one. Returned once; only its
 * hash is stored.
 */
export async function issueRecoveryCode(
  d1: D1Database,
  userId: string,
  now: Date,
): Promise<{ code: string; expiresAt: Date }> {
  const code = generateRecoveryCode();
  const hash = await hashRecoveryCode(normalizeRecoveryCode(code) as string);
  const expiresAt = new Date(now.getTime() + RECOVERY_CODE_TTL_MS);
  const db = createDb(d1);
  const identifier = issuedCodeIdentifier(userId);
  await db.batch([
    db.delete(verification).where(eq(verification.identifier, identifier)),
    db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier,
      value: hash,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }),
  ]);
  return { code, expiresAt };
}
