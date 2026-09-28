import type { AppEntry } from "../server/gate.functions";

/**
 * The signed-in layout's gate answer (`enterApp`), kept in the browser for a
 * short while so moving between pages, and hovering links (which preload
 * them), do not ask the server again before any page data is read. The
 * server still checks the session on every server function, so a session
 * ended meanwhile is caught by the page's own data, which sends the visitor
 * to sign in. The answer is dropped on leaving the signed-in pages (signing
 * out, being sent to sign in or to setup) and after changes to the viewer.
 */

/** How long a gate answer serves page changes. */
export const APP_ENTRY_FRESH_MS = 30_000;

export interface EntryMemo<T> {
  /** The answer kept, while it is fresh at `now`; null otherwise. */
  recall(now: number): T | null;
  remember(entry: T, now: number): void;
  forget(): void;
}

export function entryMemo<T>(freshMs: number = APP_ENTRY_FRESH_MS): EntryMemo<T> {
  let held: { entry: T; at: number } | null = null;
  return {
    recall(now) {
      if (held === null) return null;
      // A clock moved backwards counts as stale too.
      if (now < held.at || now - held.at >= freshMs) {
        held = null;
        return null;
      }
      return held.entry;
    },
    remember(entry, now) {
      held = { entry, at: now };
    },
    forget() {
      held = null;
    },
  };
}

/** The browser's one gate answer, used by the `_app` layout. */
export const appEntryMemo: EntryMemo<AppEntry> = entryMemo<AppEntry>();
