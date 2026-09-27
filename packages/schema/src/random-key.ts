/**
 * `generate: "base64-key-32"`: a 256-bit key as padded base64, the form apps
 * that read a raw AES key from a secret take (`atob` then 32 bytes).
 * WebCrypto only, so the manager Worker, the browser and Node share it.
 */

/** Length of a padded base64 encoding of 32 bytes. */
export const BASE64_KEY_32_LENGTH = 44;

/** Whether `value` is padded base64 that decodes to exactly 32 bytes. */
export function isBase64Key32(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  try {
    return atob(value).length === 32;
  } catch {
    return false;
  }
}

/** 32 random bytes as padded base64 (44 characters). Synchronous, for a form as it renders. */
export function generateBase64Key32(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
