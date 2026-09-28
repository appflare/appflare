/**
 * The names of the account's Workers, kept in this isolate for a minute so an
 * app's catalog page does not list the account's scripts on every view (it
 * uses them only to suggest a free Worker name; the install checks again).
 * Dropped whenever a job starts or ends here, and by the pages' "Check
 * again" and catalog refresh, since those are when the list may change.
 */

export const SCRIPTS_CACHE_MS = 60_000;

const held = new Map<string, { at: number; names: readonly string[] }>();

/** Bumped by every invalidation, so a listing that was under way then is not kept. */
let generation = 0;

/** Forgets every account's Worker names. */
export function invalidateScriptsCache(): void {
  held.clear();
  generation += 1;
}

/**
 * The Worker names of `accountId`: from this isolate's copy while it is
 * fresh at `now`, else from `load` (kept when nothing invalidated the cache
 * meanwhile). A failed `load` is not kept.
 */
export async function cachedScriptNames(
  accountId: string,
  load: () => Promise<readonly string[]>,
  now: number = Date.now(),
): Promise<string[]> {
  const copy = held.get(accountId);
  if (copy !== undefined && now >= copy.at && now - copy.at < SCRIPTS_CACHE_MS) {
    return [...copy.names];
  }
  const started = generation;
  const names = await load();
  if (started === generation) held.set(accountId, { at: now, names: [...names] });
  return [...names];
}
