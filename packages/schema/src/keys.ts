/**
 * Artifact signing public keys (Ed25519), embedded verbatim in the manager and the
 * CLI. Every artifact manifest names the `keyId` that signed it,
 * so several keys can be trusted at once and a key can be rotated
 * without invalidating already-published artifacts: add the new key here, keep the
 * retired one until every live artifact has been re-signed or expired, then drop
 * the old entry.
 *
 * The matching private keys live ONLY in the `appflare` GitHub org's Actions
 * secrets. Generate a new pair with `pnpm --filter @appflare/schema keygen`.
 *
 * {@link verifyManifestSignature} below is the runtime verifier the manager and
 * the CLI use. `@appflare/pack`'s `verify` (packages/pack/src/verify.ts) keeps its
 * own lookup over the same `signingKeys` and mirrors its rules: select by
 * `manifest.keyId`, reject unknown ids and "unsigned".
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

/** The `keyId` of an artifact packed without a key; never trusted. */
const UNSIGNED_KEY_ID = "unsigned";

/**
 * The 2026-09 public key. ONE private key, the org Actions secret
 * `APPFLARE_SIGNING_KEY`, currently signs both the manager's own releases
 * (appflare/appflare, key id `appflare-2026-09`) and catalog app releases
 * (appflare/catalog, key id `catalog-2026-09`). The two key ids are distinct on
 * purpose: either repository can later move to its own key by changing only its
 * entry below and its secret, without touching the other's artifacts.
 */
const PUBLIC_KEY_2026_09 = "HYmxJhxMa0jtF1nDO7yuDXxjVSm+ph6NnrXABpoDqG8=";

/** Trusted artifact signing keys, selected by `manifest.keyId`. */
export const signingKeys: readonly SigningKey[] = [
  // Manager releases: `manager@<version>` on appflare/appflare (docs/RELEASING.md).
  { keyId: "appflare-2026-09", publicKeyBase64: PUBLIC_KEY_2026_09 },
  // Catalog app releases: `<slug>@<version>` on appflare/catalog.
  { keyId: "catalog-2026-09", publicKeyBase64: PUBLIC_KEY_2026_09 },
];

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Decodes a key's base64 public key; throws unless it is exactly 32 bytes. */
export function decodePublicKey(key: SigningKey): Uint8Array<ArrayBuffer> {
  const bytes = base64ToBytes(key.publicKeyBase64);
  if (bytes.length !== 32) {
    throw new Error(`signing key ${key.keyId} is ${bytes.length} bytes, expected 32`);
  }
  return bytes;
}

/**
 * Verifies `manifest.sig` over the exact bytes of `manifest.json`,
 * with WebCrypto, so it runs unchanged in Workers and Node >= 20.
 *
 * The key is selected by the `keyId` read from the signed bytes themselves, so a
 * caller cannot pair a manifest with the wrong key. Rejects `keyId: "unsigned"`,
 * unknown key ids, malformed signatures, and signatures that do not verify.
 * Returns the key id on success. Callers still validate the manifest against
 * `artifactManifestSchema` and check every file's sha256.
 */
export async function verifyManifestSignature(
  manifestBytes: Uint8Array,
  signatureBase64: string,
  keys: readonly SigningKey[] = signingKeys,
): Promise<{ keyId: string }> {
  let keyId: unknown;
  try {
    keyId = (JSON.parse(new TextDecoder().decode(manifestBytes)) as { keyId?: unknown }).keyId;
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (typeof keyId !== "string" || keyId.length === 0) {
    throw new Error("manifest.json has no keyId");
  }
  if (keyId === UNSIGNED_KEY_ID) {
    throw new Error('artifact is unsigned (keyId "unsigned")');
  }
  const key = keys.find((k) => k.keyId === keyId);
  if (!key) {
    throw new Error(`no trusted signing key matches keyId "${keyId}"`);
  }
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64ToBytes(signatureBase64);
  } catch {
    throw new Error("manifest.sig is not valid base64");
  }
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decodePublicKey(key),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  // Copied into a fresh ArrayBuffer-backed view (WebCrypto's BufferSource type).
  const data = new Uint8Array(manifestBytes);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, data);
  if (!ok) {
    throw new Error(`manifest signature does not verify with keyId "${keyId}"`);
  }
  return { keyId };
}
