/**
 * Password recovery codes: a one-time code that lets someone reset an admin's
 * password from the sign-in page. Two places issue them:
 *
 * - `create-appflare recover`, run by whoever can change the manager's Worker
 *   in the Cloudflare account. It stores only the code's hash and its expiry
 *   as the Worker secret `RECOVERY_CODE_HASH` and prints the code once.
 *   Being able to write that secret is the proof of ownership.
 * - An admin in Settings, for another user; the manager keeps the hash in its
 *   own database.
 *
 * `recover --email` binds a code to one admin: the email (lower-cased) is
 * hashed together with the code, so the code works only with that email.
 *
 * The code is 20 characters from a 32-symbol alphabet (100 random bits),
 * shown in groups of five. With that much entropy a single SHA-256 is enough
 * to store it; the manager compares hashes in constant time and rate limits
 * attempts. WebCrypto only, so the Worker and the Node installer share it.
 */

/** The Worker secret `create-appflare recover` writes. */
export const RECOVERY_CODE_SECRET = "RECOVERY_CODE_HASH";

/** How long a recovery code works. */
export const RECOVERY_CODE_TTL_MS = 30 * 60_000;

/** No 0/O or 1/I: the code is read off a terminal and typed. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 20;
const GROUP = 5;

/**
 * Prefix of the secret value, `<prefix>.<expires at, epoch ms>.<sha-256 hex>`:
 * `v1` for a code any admin's email works with, `v1-email` for one bound to
 * a single email.
 */
const SECRET_VERSION = "v1";
const SECRET_VERSION_EMAIL = "v1-email";

/** An email as a code is bound to it: trimmed and lower-cased. */
export function normalizeRecoveryEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A new random recovery code, formatted `XXXXX-XXXXX-XXXXX-XXXXX`. */
export function generateRecoveryCode(): string {
  // 256 is a multiple of 32, so `byte % 32` is uniform.
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let raw = "";
  for (const b of bytes) raw += ALPHABET[b % ALPHABET.length];
  return formatRecoveryCode(raw);
}

function formatRecoveryCode(raw: string): string {
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += GROUP) groups.push(raw.slice(i, i + GROUP));
  return groups.join("-");
}

/**
 * The code as typed, without spaces or dashes, upper-cased; null when it
 * cannot be a recovery code (wrong length or a character outside the alphabet).
 */
export function normalizeRecoveryCode(input: string): string | null {
  const raw = input.replace(/[\s-]/g, "").toUpperCase();
  if (raw.length !== CODE_LENGTH) return null;
  for (const ch of raw) if (!ALPHABET.includes(ch)) return null;
  return raw;
}

/**
 * SHA-256 (lower-case hex) of a normalized code, with a fixed prefix so the
 * hash is never reused elsewhere, and with the email when the code is bound
 * to one.
 */
export async function hashRecoveryCode(normalized: string, email?: string): Promise<string> {
  const bound = email === undefined ? "" : `:email:${normalizeRecoveryEmail(email)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`appflare-recovery-code:${normalized}${bound}`),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RecoveryCodeSecret {
  /** SHA-256 hex of the normalized code. */
  hash: string;
  /** Epoch ms after which the code no longer works. */
  expiresAt: number;
  /** The hash includes an email: the code works only with that email. */
  emailBound: boolean;
}

/**
 * The value of `RECOVERY_CODE_HASH` for `code`, working until `expiresAt`
 * (epoch ms), and only with `email` when one is given.
 */
export async function recoveryCodeSecretValue(
  code: string,
  expiresAt: number,
  email?: string,
): Promise<string> {
  const normalized = normalizeRecoveryCode(code);
  if (normalized === null) throw new Error("not a recovery code");
  const prefix = email === undefined ? SECRET_VERSION : SECRET_VERSION_EMAIL;
  return `${prefix}.${Math.trunc(expiresAt)}.${await hashRecoveryCode(normalized, email)}`;
}

/** Reads a `RECOVERY_CODE_HASH` value; null when absent or not in the expected form. */
export function parseRecoveryCodeSecret(value: string | undefined): RecoveryCodeSecret | null {
  if (value === undefined) return null;
  const match = /^(v1|v1-email)\.(\d{1,16})\.([0-9a-f]{64})$/.exec(value.trim());
  if (match === null) return null;
  return {
    expiresAt: Number(match[2]),
    hash: match[3] as string,
    emailBound: match[1] === SECRET_VERSION_EMAIL,
  };
}
