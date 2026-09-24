/**
 * Constant-time comparison of two secrets. Both sides are hashed to 32-byte
 * SHA-256 digests first, so `crypto.subtle.timingSafeEqual` always compares
 * equal-length buffers and neither the comparison time nor an early length
 * mismatch reveals anything about the expected value. A missing or empty value
 * on either side never matches.
 */
export async function constantTimeEquals(
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
