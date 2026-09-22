/**
 * A lease held as a `settings` row: `value` is the owner id, `updated_at` the
 * acquisition time. Acquiring is one conditional upsert, so exactly one caller
 * wins; a lease older than its TTL is considered abandoned and may be taken over.
 * Requires the `settings` table to exist.
 */

export async function tryAcquireSettingsLock(
  db: D1Database,
  key: string,
  owner: string,
  ttlMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE settings.updated_at <= ?4`,
    )
    .bind(key, owner, now, now - ttlMs)
    .run();
  return result.meta.changes === 1;
}

/** Deletes the lease only if `owner` still holds it. */
export function releaseSettingsLockStatement(
  db: D1Database,
  key: string,
  owner: string,
): D1PreparedStatement {
  return db.prepare("DELETE FROM settings WHERE key = ?1 AND value = ?2").bind(key, owner);
}

export async function releaseSettingsLock(
  db: D1Database,
  key: string,
  owner: string,
): Promise<void> {
  await releaseSettingsLockStatement(db, key, owner).run();
}
