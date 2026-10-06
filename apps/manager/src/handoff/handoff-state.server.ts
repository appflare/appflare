/**
 * Where the handoff of a manager installed from the browser stands:
 * `waiting` for the page that installed it, `received` once that page has
 * handed over the Cloudflare connection, `done` once an owner exists.
 */

/** `settings` row: ISO 8601 time the Cloudflare connection was handed over. */
export const HANDOFF_RECEIVED_KEY = "handoff_received_at";

export type HandoffState = "waiting" | "received" | "done";

/** One read. */
export async function readHandoffState(d1: D1Database): Promise<HandoffState> {
  const row = await d1
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM user) AS has_user,
              (SELECT value FROM settings WHERE key = ?1) AS received`,
    )
    .bind(HANDOFF_RECEIVED_KEY)
    .first<{ has_user: number; received: string | null }>();
  if (row?.has_user === 1) return "done";
  return row?.received ? "received" : "waiting";
}

/**
 * `settings` row of the authorization the browser handed over, kept sealed
 * between tries of the handoff (handed-grant.server.ts).
 */
export const HANDED_GRANT_KEY = "handoff_grant";

/**
 * Deletes that row once setup no longer needs it: the owner exists, or a
 * pasted API token became the connection instead. It cannot be revoked
 * here: only the raw handoff secret opens it, which only the installing
 * browser holds and these callers never see. Sealed, its refresh token is
 * useless to anyone, and Cloudflare expires it.
 */
export async function forgetHandedGrant(d1: D1Database): Promise<void> {
  await d1.prepare("DELETE FROM settings WHERE key = ?1").bind(HANDED_GRANT_KEY).run();
}
