import { constantTimeEquals } from "../auth/constant-time";

/**
 * The handoff secret and the proof built on it. A manager installed from
 * the browser holds `APPFLARE_HANDOFF = v1.<sha256 hex>`, set by the hosted
 * installer that deployed it: the SHA-256 of a secret only the installing
 * browser knows.
 *
 * - The secret: 32 random bytes, base64url without padding (43 characters).
 * - Its hash: lowercase hex SHA-256 of the secret's characters (UTF-8).
 * - The proof for a challenge: base64url(HMAC-SHA256(key = the 32 raw bytes
 *   of that hash, message = "appflare-handoff:" + challenge)). The browser
 *   (which knows the secret) and the installer (which knows the hash) both
 *   compute it, so an answer with the right proof comes from this
 *   installation and not from some other page at the same address.
 *
 * WebCrypto only; nothing here touches the database.
 */

export const HANDOFF_PATH = "/api/handoff";

const BINDING = /^v1\.([0-9a-f]{64})$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{16,64}$/;
const PROOF_PREFIX = "appflare-handoff:";

/** The hash in `APPFLARE_HANDOFF`, or null when it is unset or not in the `v1.<hex>` form. */
export function handoffHashOf(binding: string | undefined): string | null {
  if (binding === undefined) return null;
  return BINDING.exec(binding.trim())?.[1] ?? null;
}

/** A challenge the proof may be asked for: 16 to 64 base64url characters. */
export function isChallenge(value: string | null): value is string {
  return value !== null && CHALLENGE.test(value);
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The proof for `challenge`, from the hash in `APPFLARE_HANDOFF`. */
export async function handoffProof(hash: string, challenge: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexBytes(hash),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(PROOF_PREFIX + challenge),
  );
  return base64url(new Uint8Array(mac));
}

/**
 * Whether `secret` is the handoff secret whose hash is `hash`: a 43-character
 * base64url value whose SHA-256 matches, compared in constant time.
 */
export async function handoffSecretMatches(secret: unknown, hash: string): Promise<boolean> {
  if (typeof secret !== "string" || !SECRET.test(secret)) return false;
  return constantTimeEquals(await sha256Hex(secret), hash);
}

/**
 * A key for sealing a Cloudflare authorization the browser handed over,
 * derived (HKDF-SHA-256) from the raw handoff secret, which only the
 * installing browser knows and sends with every handoff, and a random salt
 * kept with what it seals. Never from `APPFLARE_HANDOFF`: the hosted
 * installer wrote that hash, so a key derived from it would let the
 * installer open the authorization. A retry carries the same secret; a new
 * secret cannot open what the old one sealed.
 */
export async function handedGrantKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(salt),
      info: new TextEncoder().encode("appflare-handoff-grant-key"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * A key for sealing what the manager keeps about the installer itself (the
 * key of its installation record, which the installer issued and knows
 * anyway), derived from the hash (HKDF-SHA-256). The hash lives only in the
 * Worker's secret, so a copy of the database alone cannot open what it
 * seals. Not for anything of the account's or the owner's: the installer
 * knows the hash.
 */
export async function installerDetailsKey(hash: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", hexBytes(hash), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("appflare-handoff-installer-key"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
