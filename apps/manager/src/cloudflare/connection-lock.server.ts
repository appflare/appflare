import { releaseSettingsLock, tryAcquireSettingsLock } from "../db/settings-lock";

/**
 * Serializes every change of the Cloudflare connection: saving or rotating
 * an API token (server/token.server.ts) and storing a grant (grant.server.ts).
 * The same `settings` lease the token step has always used, so a manager
 * running an older version still waits for it.
 */
const CONNECTION_LOCK_KEY = "cf_token_lock";
const CONNECTION_LOCK_TTL_MS = 60_000;

/** Runs `run` holding the lease; throws `busy()` when another change holds it. */
export async function withConnectionLock<T>(
  db: D1Database,
  busy: () => Error,
  run: () => Promise<T>,
): Promise<T> {
  const owner = crypto.randomUUID();
  if (!(await tryAcquireSettingsLock(db, CONNECTION_LOCK_KEY, owner, CONNECTION_LOCK_TTL_MS))) {
    throw busy();
  }
  try {
    return await run();
  } finally {
    await releaseSettingsLock(db, CONNECTION_LOCK_KEY, owner);
  }
}
