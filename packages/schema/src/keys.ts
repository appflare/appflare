/**
 * Catalog signing public keys (Ed25519), embedded verbatim in the manager and the
 * CLI. Every artifact manifest names the `keyId` that signed it,
 * so several keys can be trusted at once and a key can be rotated
 * without invalidating already-published artifacts: add the new key here, keep the
 * retired one until every live artifact has been re-signed or expired, then drop
 * the old entry.
 *
 * The matching private key lives ONLY in the `appflare` GitHub org's Actions
 * secrets. This list stays empty until that key is generated.
 */
export interface SigningKey {
  /** Stable identifier recorded in `manifest.json.keyId`, e.g. "catalog-2026-09". */
  keyId: string;
  /**
   * Base64 of the raw Ed25519 public key, verified with WebCrypto
   * (`crypto.subtle.verify` with `{ name: "Ed25519" }`).
   */
  publicKeyBase64: string;
}

/** Trusted catalog signing keys. Empty until the signing key is generated. */
export const signingKeys: SigningKey[] = [];
