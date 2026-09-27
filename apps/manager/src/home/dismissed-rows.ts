import { useEffect } from "react";
import { localChoice } from "../components/local-choice";

/**
 * The account rows of "Needs attention" put away with "Not needed",
 * remembered per browser (`local-choice.ts`) as one comma-separated list of
 * row keys (`accountRowKey`: the row and the installs that needed it). A
 * key stays only while its row still needs action for the same installs;
 * `pruneDismissed` drops the others, so the row comes back when it needs
 * action again or another app needs it. Only the Home list and its count
 * leave dismissed rows out; Your account still shows them.
 */

export const DISMISSED_ROWS_KEY = "appflare:attention-dismissed";

const KEY = /^[a-z0-9-]{1,40}:[0-9a-f]{8}$/;

/** A stored list, cleaned: well-formed keys only, no repeats, in order. */
export function parseDismissedRows(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  const keys = value
    .split(",")
    .map((key) => key.trim())
    .filter((key) => KEY.test(key));
  return [...new Set(keys)].sort().join(",");
}

export function dismissedSet(stored: string): ReadonlySet<string> {
  return new Set(stored === "" ? [] : stored.split(","));
}

/** The stored list with `key` added. */
export function withDismissed(stored: string, key: string): string {
  return parseDismissedRows(stored === "" ? key : `${stored},${key}`);
}

/** The stored list without the keys of rows that no longer show as they did. */
export function pruneDismissed(stored: string, current: ReadonlySet<string>): string {
  return [...dismissedSet(stored)].filter((key) => current.has(key)).join(",");
}

const choice = localChoice(DISMISSED_ROWS_KEY, parseDismissedRows);

/**
 * The rows put away in this browser, and "Not needed" for one more. With
 * `current` (the keys of the account rows now needing action, known only to
 * admins), stored keys of other rows are dropped.
 */
export function useDismissedRows(
  current: ReadonlySet<string> | null,
): [ReadonlySet<string>, (key: string) => void] {
  const [stored, set] = choice.useChoice();
  useEffect(() => {
    if (current === null) return;
    const pruned = pruneDismissed(stored, current);
    if (pruned !== stored) set(pruned);
  }, [stored, current, set]);
  // `stored` is a string, so the set changes only when the list does.
  return [dismissedSetOf(stored), (key) => set(withDismissed(stored, key))];
}

let lastStored: string | null = null;
let lastSet: ReadonlySet<string> = new Set();

function dismissedSetOf(stored: string): ReadonlySet<string> {
  if (stored !== lastStored) {
    lastStored = stored;
    lastSet = dismissedSet(stored);
  }
  return lastSet;
}
