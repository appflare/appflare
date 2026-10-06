/**
 * Attempts per client address for the doors that are open before anyone
 * signs in: setup's token step, the browser installer's handoff, the owner
 * claim on `/setup`, and the return from "Sign in with Cloudflare". Each
 * counts under its own `scope` with its own limit.
 *
 * Counted in a fixed window in Better Auth's `rate_limit` table (D1, never
 * KV: a counter is written on every attempt), under a key of Appflare's own,
 * `appflare:<scope>:<sha-256 of the address>`, so no address is stored.
 */

export interface AttemptLimit {
  max: number;
  windowMs: number;
}

/** 20 attempts in 10 minutes: what every one of those doors allows. */
export const DEFAULT_ATTEMPT_LIMIT: AttemptLimit = { max: 20, windowMs: 10 * 60_000 };

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Counts one attempt for `client` at `scope`; false once the window's attempts are used up. */
export async function takeAttempt(
  d1: D1Database,
  scope: string,
  client: string,
  now: Date | number,
  limit: AttemptLimit = DEFAULT_ATTEMPT_LIMIT,
): Promise<boolean> {
  const key = `appflare:${scope}:${await sha256Hex(client)}`;
  const t = typeof now === "number" ? now : now.getTime();
  const row = await d1
    .prepare(
      `INSERT INTO rate_limit (id, key, count, last_request) VALUES (?1, ?1, 1, ?2)
       ON CONFLICT(id) DO UPDATE SET
         count = CASE WHEN ?2 - last_request >= ?3 THEN 1 ELSE count + 1 END,
         last_request = CASE WHEN ?2 - last_request >= ?3 THEN ?2 ELSE last_request END
       RETURNING count`,
    )
    .bind(key, t, limit.windowMs)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit.max;
}
