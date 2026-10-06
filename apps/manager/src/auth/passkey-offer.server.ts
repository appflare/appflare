import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import { movedHere } from "../domains/moved-note";

/**
 * The passkey offered once after Appflare moved: right after a user's first
 * password sign-in at the new address, unless a passkey of theirs works
 * there already. Adding one, or Not now, ends it for that user at that
 * address for good: a `settings` row `passkey_offer_done:<user id>` holds the
 * address it ended at, so a later move offers again.
 */

const KEY_PREFIX = "passkey_offer_done:";

/** Whether the offer is due for `userId` at `host`. One settings read. */
export async function passkeyOfferDue(
  db: D1Database,
  input: { userId: string; host: string; now: Date; passkeyWorksHere: boolean },
): Promise<boolean> {
  if (input.passkeyWorksHere) return false;
  const rows = await readSettings(createDb(db), [
    SETTING.managerHostname,
    SETTING.managerPreviousHostname,
    SETTING.managerMovedAt,
  ]);
  const moved = movedHere(
    {
      hostname: rows.manager_hostname || null,
      previousHostname: rows.manager_previous_hostname || null,
      movedAt: rows.manager_moved_at || null,
    },
    input.host,
    input.now,
  );
  if (!moved) return false;
  const done = await db
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(`${KEY_PREFIX}${input.userId}`)
    .first<{ value: string }>();
  return done?.value.toLowerCase() !== input.host.toLowerCase();
}

/** Ends the offer for `userId` at `host` (a passkey was added, or Not now). */
export async function endPasskeyOffer(
  db: D1Database,
  input: { userId: string; host: string; now: Date },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(`${KEY_PREFIX}${input.userId}`, input.host.toLowerCase(), input.now.getTime())
    .run();
}
