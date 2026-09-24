import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { featured_dismissals } from "../db/schema";

/** Ids of the sponsored items `userId` has hidden. */
export async function dismissedFeaturedIds(db: Database, userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: featured_dismissals.item_id })
    .from(featured_dismissals)
    .where(eq(featured_dismissals.user_id, userId));
  return new Set(rows.map((r) => r.id));
}

/** Hides a sponsored item for one user. One D1 write; hiding it again changes nothing. */
export async function dismissFeaturedItem(
  db: Database,
  userId: string,
  itemId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(featured_dismissals)
    .values({ user_id: userId, item_id: itemId, dismissed_at: now })
    .onConflictDoNothing();
}
