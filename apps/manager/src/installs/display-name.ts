import { z } from "zod";

/**
 * An install's display name: an optional name an admin gives it ("Team link
 * shortener"), set in the install form and changed from the app page. When
 * it is not set, the install is shown by its Worker name, as the Worker name
 * alone tells two installs of one app apart. It only ever reaches the UI and
 * notification messages; usage data never carries it. Client-safe.
 */

/** Longest display name accepted, after trimming. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

/** Control characters (tabs, newlines, escapes) would break one-line titles and messages. */
const CONTROL_CHARACTER = /\p{Cc}/u;

export const DISPLAY_NAME_HINT = `Use 1 to ${DISPLAY_NAME_MAX_LENGTH} characters, without line breaks or tabs.`;

/** A display name as stored: trimmed, 1 to 60 characters, no control characters. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "The name cannot be empty.")
  .max(DISPLAY_NAME_MAX_LENGTH, `Use at most ${DISPLAY_NAME_MAX_LENGTH} characters.`)
  .refine((value) => !CONTROL_CHARACTER.test(value), "The name cannot hold line breaks or tabs.");

/**
 * A display name as typed: empty (or only spaces) means none, so the
 * install is shown by its Worker name; anything else must be a valid name.
 */
export const displayNameInput = z
  .string()
  .max(1000)
  .transform((value) => value.trim())
  .transform((value) => (value === "" ? null : value))
  .pipe(displayNameSchema.nullable());

/** Why a typed display name is refused, or null when it is fine (empty is fine). */
export function displayNameProblem(typed: string): string | null {
  const parsed = displayNameInput.safeParse(typed);
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? DISPLAY_NAME_HINT);
}

/**
 * What the UI calls an install wherever it names one: its display name,
 * else its Worker name.
 */
export function installLabel(install: { displayName: string | null; workerName: string }): string {
  return install.displayName ?? install.workerName;
}

/**
 * What the rename field on an app's page starts with: the name the page's
 * title shows, which is the display name, else the app's name.
 */
export function renameStartValue(install: { displayName: string | null; name: string }): string {
  return install.displayName ?? install.name;
}

/**
 * What saving the rename field sends: null when nothing would change, else
 * the display name to store, where empty clears it. The app's own name counts
 * as no display name (the page shows it either way), so saving the field
 * untouched changes nothing.
 */
export function renameChange(
  install: { displayName: string | null; name: string },
  typed: string,
): string | null {
  const trimmed = typed.trim();
  const next = trimmed === install.name ? "" : trimmed;
  return next === (install.displayName ?? "") ? null : next;
}
