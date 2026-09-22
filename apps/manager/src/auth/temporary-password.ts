/** No 0/O, 1/l/I: the password is read off the screen and typed once. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const TEMPORARY_PASSWORD_LENGTH = 20;

/**
 * A random temporary password for a user an admin creates (no email
 * provider, the password is shown once). Uniform over the alphabet via rejection
 * sampling; 20 characters of a 57-symbol alphabet is about 116 bits.
 */
export function generateTemporaryPassword(length = TEMPORARY_PASSWORD_LENGTH): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const b of bytes) {
      if (b < limit && out.length < length) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}
