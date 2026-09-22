import { webcrypto } from "node:crypto";

/** The `keyId` recorded when an artifact is packed with no key id at all. */
export const UNSIGNED_KEY_ID = "unsigned";

/** Imports a base64 PKCS#8 Ed25519 private key. Never logs or echoes the key. */
async function importPrivateKey(keyBase64: string, extractable: boolean) {
  try {
    return await webcrypto.subtle.importKey(
      "pkcs8",
      Buffer.from(keyBase64, "base64"),
      { name: "Ed25519" },
      extractable,
      ["sign"],
    );
  } catch {
    // Deliberately generic: the underlying error could quote key material.
    throw new Error("the signing key is not a valid base64 PKCS#8 Ed25519 private key");
  }
}

/** Signs `bytes` with a base64 PKCS#8 Ed25519 private key; returns base64. */
export async function signBytes(bytes: Uint8Array, keyBase64: string): Promise<string> {
  const key = await importPrivateKey(keyBase64, false);
  const sig = await webcrypto.subtle.sign({ name: "Ed25519" }, key, bytes);
  return Buffer.from(new Uint8Array(sig)).toString("base64");
}

/** Derives the raw base64 Ed25519 public key from a base64 PKCS#8 private key. */
export async function publicKeyFromPrivate(keyBase64: string): Promise<string> {
  const key = await importPrivateKey(keyBase64, true);
  // An OKP private-key JWK carries the public point `x` (base64url, 32 bytes).
  const jwk = await webcrypto.subtle.exportKey("jwk", key);
  if (!jwk.x) {
    throw new Error("could not derive the public key from the signing key");
  }
  return Buffer.from(jwk.x, "base64url").toString("base64");
}
