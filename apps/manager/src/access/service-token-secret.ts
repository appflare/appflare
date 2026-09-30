import { Buffer } from "node:buffer";

/**
 * An install's Access service token client secret at rest. Cloudflare shows
 * it once, when the token is created or rotated, and it lets its holder past
 * the install's Access application, so it is kept in D1 only sealed.
 *
 * Key custody is the notification credentials' (notifications/crypto.ts): an
 * AES-GCM key derived with HKDF-SHA256 from the Worker secret
 * `BETTER_AUTH_SECRET`, under labels used for nothing else, so the key lives
 * only in the Worker's secrets while the ciphertext lives in D1. A secret of
 * its own on the Worker would deploy a version on first use, race between
 * isolates, and be lost on a rollback. Rotating `BETTER_AUTH_SECRET` makes the
 * sealed value unreadable; the service token is then rotated for a new one
 * (install-access.server.ts), since the old value cannot be recovered anyway.
 *
 * Each ciphertext is bound to its install and token ids (AES-GCM additional
 * data), so a sealed value cannot be moved to another install's row.
 */

/** What a sealed secret is bound to. */
export interface SealedFor {
  installId: string;
  tokenId: string;
}

const boundTo = ({ installId, tokenId }: SealedFor) =>
  new TextEncoder().encode(`${installId}/${tokenId}`);

const FORMAT = "v1";
const HKDF_SALT = "appflare/access-service-token";
const HKDF_INFO = "service token client secret v1";

export class ServiceTokenKeyError extends Error {
  override name = "ServiceTokenKeyError";
}

/** Derived keys, per isolate; only finished derivations are kept (see notifications/crypto.ts). */
const keys = new Map<string, CryptoKey>();

async function sealingKey(authSecret: string | undefined): Promise<CryptoKey> {
  if (authSecret === undefined || authSecret.length === 0) {
    throw new ServiceTokenKeyError("BETTER_AUTH_SECRET is not set on this Worker.");
  }
  const known = keys.get(authSecret);
  if (known !== undefined) return known;
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authSecret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(HKDF_SALT),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  keys.set(authSecret, key);
  return key;
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const fromB64url = (text: string): Uint8Array<ArrayBuffer> => {
  const bytes = Buffer.from(text, "base64url");
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
};

/** `v1.<iv>.<ciphertext>`; throws `ServiceTokenKeyError` without `BETTER_AUTH_SECRET`. */
export async function sealServiceTokenSecret(
  authSecret: string | undefined,
  sealedFor: SealedFor,
  clientSecret: string,
): Promise<string> {
  const key = await sealingKey(authSecret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: boundTo(sealedFor) },
    key,
    new TextEncoder().encode(clientSecret),
  );
  return `${FORMAT}.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`;
}

/**
 * The client secret, or null when it cannot be read: no `BETTER_AUTH_SECRET`,
 * a different one than it was sealed with, another install's or token's
 * value, or a damaged row. Never throws.
 */
export async function openServiceTokenSecret(
  authSecret: string | undefined,
  sealedFor: SealedFor,
  sealed: string,
): Promise<string | null> {
  const [format, iv, data] = sealed.split(".");
  if (format !== FORMAT || iv === undefined || data === undefined) return null;
  try {
    const key = await sealingKey(authSecret);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64url(iv), additionalData: boundTo(sealedFor) },
      key,
      fromB64url(data),
    );
    const secret = new TextDecoder().decode(plain);
    return secret.length > 0 ? secret : null;
  } catch {
    return null;
  }
}
