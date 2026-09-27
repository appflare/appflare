/**
 * VAPID keys (RFC 8292), the key pair a Web Push sender signs its requests
 * with: an ECDSA P-256 key. The encodings are the ones web-push libraries
 * (`web-push`, `@block65/webcrypto-web-push`, the browser's
 * `applicationServerKey`) take: the private key as the unpadded base64url of
 * its raw 32-byte scalar, the public key as the unpadded base64url of its
 * 65-byte uncompressed point (`0x04 || x || y`).
 *
 * WebCrypto only (`crypto.getRandomValues`, `crypto.subtle`), so the manager
 * Worker, the browser and Node share it.
 */

/** Length of a VAPID private key: the unpadded base64url of 32 bytes. */
export const VAPID_PRIVATE_KEY_LENGTH = 43;
/** Length of a VAPID public key: the unpadded base64url of 65 bytes. */
export const VAPID_PUBLIC_KEY_LENGTH = 87;

/** The order of the P-256 group: a private key is a scalar in [1, n - 1]. */
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/**
 * The DER of a PKCS #8 `PrivateKeyInfo` for a P-256 key up to its 32-byte
 * scalar: version 0, algorithm id-ecPublicKey with prime256v1, and an
 * `ECPrivateKey` (version 1) whose optional public key is left out.
 * WebCrypto computes the public key from the scalar on import.
 */
const PKCS8_P256_PREFIX = new Uint8Array([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
  0x01, 0x04, 0x20,
]);

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function scalarOf(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  return n;
}

/** The 32-byte scalar of `value`, or null when `value` is not a VAPID private key. */
function privateScalar(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = fromBase64Url(value);
  // The last character carries two spare bits; only the canonical text counts.
  if (bytes.length !== 32 || toBase64Url(bytes) !== value) return null;
  const d = scalarOf(bytes);
  return d > 0n && d < P256_ORDER ? bytes : null;
}

/**
 * Whether `value` is a VAPID private key: 43 base64url characters (no
 * padding) encoding a P-256 scalar in [1, n - 1].
 */
export function isVapidPrivateKey(value: string): boolean {
  return privateScalar(value) !== null;
}

/**
 * A new VAPID private key. A P-256 private key is a uniformly random scalar
 * in [1, n - 1]; 32 random bytes outside that range (a chance of about
 * 2^-32) are drawn again. Synchronous, so a form can fill in a field with it
 * as it renders.
 */
export function generateVapidPrivateKey(): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const d = scalarOf(bytes);
    if (d > 0n && d < P256_ORDER) return toBase64Url(bytes);
  }
}

/**
 * The VAPID public key of `privateKey`: WebCrypto imports the scalar as a
 * PKCS #8 ECDSA P-256 key, which computes its public point, and exports it as
 * a JWK, whose `x` and `y` make the uncompressed point. Throws when
 * `privateKey` is not a VAPID private key ({@link isVapidPrivateKey}); the
 * message never repeats the value.
 */
export async function vapidPublicKey(privateKey: string): Promise<string> {
  const scalar = privateScalar(privateKey);
  if (scalar === null) {
    throw new Error(
      `not a VAPID private key: expected the base64url of a 32-byte P-256 private key (${VAPID_PRIVATE_KEY_LENGTH} characters)`,
    );
  }
  const pkcs8 = new Uint8Array(PKCS8_P256_PREFIX.length + scalar.length);
  pkcs8.set(PKCS8_P256_PREFIX);
  pkcs8.set(scalar, PKCS8_P256_PREFIX.length);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as { x?: unknown; y?: unknown };
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("WebCrypto exported a P-256 key without its public point");
  }
  const x = fromBase64Url(jwk.x);
  const y = fromBase64Url(jwk.y);
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1 + 32 - x.length);
  point.set(y, 33 + 32 - y.length);
  return toBase64Url(point);
}
