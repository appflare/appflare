import { eq, sql } from "drizzle-orm";
import { compareVersions } from "../catalog/versions";
import type { Database } from "../db/client";
import { settings } from "../db/schema";

/**
 * The newest release each user has seen in "What's new": one `settings` row
 * per user, `whats_new_seen:<user id>` = the version. It only moves forward.
 */

export function seenKey(userId: string): string {
  return `whats_new_seen:${userId}`;
}

/** The newest version `userId` has seen, or null before they first opened "What's new". */
export async function readSeenVersion(db: Database, userId: string): Promise<string | null> {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, seenKey(userId)))
    .limit(1);
  return rows[0]?.value ?? null;
}

/**
 * Records that `userId` has seen the notes up to `version`, unless they had
 * already seen a newer one. Returns the version now stored.
 */
export async function markSeen(
  db: Database,
  userId: string,
  version: string,
  now: Date = new Date(),
): Promise<string> {
  const stored = await readSeenVersion(db, userId);
  if (stored !== null && (compareVersions(version, stored) ?? 1) <= 0) return stored;
  await db
    .insert(settings)
    .values({ key: seenKey(userId), value: version, updated_at: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`excluded.value`, updated_at: sql`excluded.updated_at` },
    });
  return version;
}
