/**
 * Constant-time check of the `/setup?token=` value against the `SETUP_TOKEN`
 * secret. Both sides are hashed to 32-byte SHA-256 digests first, so
 * `crypto.subtle.timingSafeEqual` always compares equal-length buffers and neither
 * the comparison time nor an early length mismatch reveals anything about the
 * secret. A missing or empty secret never matches.
 */
export async function setupTokenMatches(
  provided: string | null | undefined,
  expected: string | null | undefined,
): Promise<boolean> {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
