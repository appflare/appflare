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

/** Key ids: lowercase letters, digits and dashes; never "unsigned". */
export const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The fingerprint of a public key, as people compare it by eye: `SHA256:`
 * and the unpadded base64 of the sha256 of the raw 32-byte key (the form
 * OpenSSH prints). Throws unless the key is 32 bytes.
 */
export async function publicKeyFingerprint(publicKeyBase64: string): Promise<string> {
  const raw = decodePublicKey({ keyId: "fingerprint", publicKeyBase64 });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `SHA256:${btoa(binary).replace(/=+$/, "")}`;
}

/**
 * The line a signing key's owner publishes and a manager's admin pastes: the
 * key in the shape this module embeds, as JSON on one line.
 */
export function formatPublicKey(key: SigningKey): string {
  return JSON.stringify({ keyId: key.keyId, publicKeyBase64: key.publicKeyBase64 });
}

/** Why pasted public keys were refused; the message is safe to show. */
export class PublicKeyFormatError extends Error {
  override name = "PublicKeyFormatError";
}

/** Most keys one pasted key set may hold: the current key and a few for a rotation. */
export const MAX_PASTED_KEYS = 4;

function field(item: unknown, name: string): unknown {
  return typeof item === "object" && item !== null && !Array.isArray(item)
    ? (item as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Reads pasted public keys: one `{"keyId": ..., "publicKeyBase64": ...}`
 * object (what {@link formatPublicKey} writes) or an array of them, for a
 * signer in the middle of a key rotation. Each key id must match
 * {@link KEY_ID_PATTERN} and appear once; each key must be 32 raw bytes.
 * Throws {@link PublicKeyFormatError}.
 */
export function parsePublicKeys(text: string): SigningKey[] {
  let json: unknown;
  try {
    json = JSON.parse(text.trim());
  } catch {
    throw new PublicKeyFormatError(
      'Paste the public key as its catalog publishes it: {"keyId": "...", "publicKeyBase64": "..."}.',
    );
  }
  const items: unknown[] = Array.isArray(json) ? json : [json];
  if (items.length === 0) throw new PublicKeyFormatError("Paste at least one public key.");
  if (items.length > MAX_PASTED_KEYS) {
    throw new PublicKeyFormatError(`Paste at most ${MAX_PASTED_KEYS} public keys.`);
  }
  const keys: SigningKey[] = [];
  for (const item of items) {
    const keyId = field(item, "keyId");
    const publicKeyBase64 = field(item, "publicKeyBase64");
    if (typeof keyId !== "string" || typeof publicKeyBase64 !== "string") {
      throw new PublicKeyFormatError('Each public key needs a "keyId" and a "publicKeyBase64".');
    }
    if (!KEY_ID_PATTERN.test(keyId) || keyId === UNSIGNED_KEY_ID) {
      throw new PublicKeyFormatError(
        `The key id "${keyId.slice(0, 64)}" must be lowercase letters, digits and dashes, and not "unsigned".`,
      );
    }
    if (keys.some((k) => k.keyId === keyId)) {
      throw new PublicKeyFormatError(`The key id "${keyId}" appears twice.`);
    }
    const key = { keyId, publicKeyBase64: publicKeyBase64.trim() };
    try {
      decodePublicKey(key);
    } catch {
      throw new PublicKeyFormatError(
        `The public key "${keyId}" is not the base64 of a 32-byte Ed25519 public key.`,
      );
    }
    keys.push(key);
  }
  return keys;
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
  await verifySignature(manifestBytes, signatureBase64, keyId, keys);
  return { keyId };
}

/** How {@link verifySignature} names what it checks in its errors. */
export interface SignatureLabels {
  /** The signature, e.g. `manifest.sig`. */
  signature: string;
  /** The signed document, e.g. `manifest`. */
  subject: string;
}

/**
 * Verifies a base64 Ed25519 signature over the exact `bytes` with the trusted
 * key `keyId`, with WebCrypto. {@link verifyManifestSignature} uses it with the
 * key id read from the signed manifest; a revised catalog manifest (whose
 * signature and key id the catalog index carries) uses it with the key id of
 * the release it revises. Rejects `"unsigned"`, unknown key ids, malformed
 * signatures, and signatures that do not verify.
 */
export async function verifySignature(
  bytes: Uint8Array,
  signatureBase64: string,
  keyId: string,
  keys: readonly SigningKey[] = signingKeys,
  labels: SignatureLabels = { signature: "manifest.sig", subject: "manifest" },
): Promise<void> {
  const key = keyId === UNSIGNED_KEY_ID ? undefined : keys.find((k) => k.keyId === keyId);
  if (!key) {
    throw new Error(`no trusted signing key matches keyId "${keyId}"`);
  }
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64ToBytes(signatureBase64);
  } catch {
    throw new Error(`${labels.signature} is not valid base64`);
  }
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decodePublicKey(key),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  // Copied into a fresh ArrayBuffer-backed view (WebCrypto's BufferSource type).
  const data = new Uint8Array(bytes);
  // WebCrypto throws on a signature of the wrong length; that is a bad signature too.
  const ok = await crypto.subtle
    .verify({ name: "Ed25519" }, publicKey, signature, data)
    .catch(() => false);
  if (!ok) {
    throw new Error(`${labels.subject} signature does not verify with keyId "${keyId}"`);
  }
}
