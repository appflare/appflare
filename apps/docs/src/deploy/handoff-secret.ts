/**
 * The handoff secret: a random value only this browser knows. The hosted
 * installer receives its SHA-256 (`handoffHash`) and gives it to the new
 * Appflare, which can then prove it is that installation without ever
 * holding the secret, and accepts the Cloudflare connection only from
 * whoever presents the secret itself.
 *
 * - secret: 32 random bytes, base64url without padding (43 characters).
 * - handoffHash: lowercase hex SHA-256 of the secret's characters (UTF-8).
 * - proof for a challenge: base64url(HMAC-SHA256(key = the raw 32 bytes of
 *   that SHA-256, message = "appflare-handoff:" + challenge)).
 */

const PROOF_PREFIX = "appflare-handoff:";

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function random(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** A fresh handoff secret. */
export function newHandoffSecret(): string {
  return random(32);
}

/** A fresh challenge for the proof: 24 random bytes, 32 characters. */
export function newChallenge(): string {
  return random(24);
}

async function sha256(secret: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
}

/** The hash the hosted installer gets. */
export async function handoffHash(secret: string): Promise<string> {
  return [...(await sha256(secret))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The proof an Appflare holding this secret's hash gives for `challenge`. */
export async function handoffProof(secret: string, challenge: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    await sha256(secret),
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
