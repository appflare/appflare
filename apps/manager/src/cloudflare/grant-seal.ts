/**
 * Sealing the stored Cloudflare grant. The refresh token and the access
 * token are encrypted with AES-256-GCM under the manager's own key: 32 random
 * bytes the manager generates and writes on its Worker as the `CF_GRANT_KEY`
 * secret the first time it stores a grant. That key has nothing to do with
 * `BETTER_AUTH_SECRET`, so rotating the auth secret never disconnects
 * Cloudflare. Each value gets a fresh 96-bit IV, and the grant id and the
 * field name are the additional data, so a sealed value cannot be moved to
 * another grant or another field. WebCrypto only.
 */

/** The Worker secret that holds the key. */
export const GRANT_KEY_SECRET = "CF_GRANT_KEY";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const SEALED_PREFIX = "v1";

/** Thrown when a sealed value cannot be opened; it never carries the value or the key. */
export class GrantSealError extends Error {
  override name = "GrantSealError";
}

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (value.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A new key, as the secret's text: 32 random bytes, base64url. */
export function generateGrantKey(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/**
 * The key's fingerprint, stored with the grant to name the key that sealed
 * it: the first 16 hex digits of the SHA-256 of the secret's text. It tells
 * keys apart without revealing them.
 */
export async function grantKeyId(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A usable key and its fingerprint. */
export interface GrantKey {
  id: string;
  key: CryptoKey;
}

/** Imports the secret's text; null when it is not a 32-byte base64url value. */
export async function importGrantKey(secret: string): Promise<GrantKey | null> {
  const raw = fromBase64url(secret.trim());
  if (raw === null || raw.length !== KEY_BYTES) return null;
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { id: await grantKeyId(secret.trim()), key };
}

/** What a sealed value is bound to: its grant and its field. */
export function sealContext(grantId: string, field: "refresh" | "access"): string {
  return `appflare-cloudflare-grant:${grantId}:${field}`;
}

/** `v1.<iv>.<ciphertext>`, both base64url. */
export async function sealValue(key: CryptoKey, value: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(value),
  );
  return `${SEALED_PREFIX}.${toBase64url(iv)}.${toBase64url(new Uint8Array(sealed))}`;
}

/** Opens a value {@link sealValue} made with the same key and context. */
export async function openValue(key: CryptoKey, sealed: string, context: string): Promise<string> {
  const [prefix, ivText, dataText, ...rest] = sealed.split(".");
  const iv = ivText === undefined ? null : fromBase64url(ivText);
  const data = dataText === undefined ? null : fromBase64url(dataText);
  if (prefix !== SEALED_PREFIX || rest.length > 0 || iv?.length !== IV_BYTES || data === null) {
    throw new GrantSealError("The stored Cloudflare connection is not in a format Appflare reads.");
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
      key,
      data,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new GrantSealError("The stored Cloudflare connection could not be opened with this key.");
  }
}
