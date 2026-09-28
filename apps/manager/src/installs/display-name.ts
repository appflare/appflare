import { z } from "zod";

/**
 * An install's display name: an optional name an admin gives it ("Team link
 * shortener"), set in the install form and changed from the app page. When
 * it is not set, the install goes by the app's name ("Sink"), everywhere the
 * UI and notifications name it; two installs that would read the same are
 * told apart by their Worker names (`distinctLabels`). It only ever reaches
 * the UI and notification messages; usage data never carries it.
 * Client-safe.
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
 * install goes by the app's name; anything else must be a valid name.
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
 * else the app's name. Never its Worker name, which means nothing to most
 * people; where two installs would read the same, `distinctLabels` adds it.
 */
export function installLabel(install: { displayName: string | null; name: string }): string {
  return install.displayName ?? install.name;
}

/** An install as `distinctLabels` compares it. */
export interface NamedInstall {
  id: string;
  displayName: string | null;
  /** The app's name. */
  name: string;
  workerName: string;
}

/** Two labels read the same when they differ only in case or in spaces around them. */
function readingOf(label: string): string {
  return label.trim().toLocaleLowerCase();
}

/**
 * What each install is called where installs are named side by side (the
 * sidebar, the jobs, notifications): its `installLabel`, followed by its
 * Worker name in parentheses only when another of `installs` reads the same,
 * as two installs of one app without names of their own do ("Sink (sink)",
 * "Sink (sink-2)"). An install listed twice counts once. By install id.
 */
export function distinctLabels(installs: readonly NamedInstall[]): Map<string, string> {
  const byId = new Map(installs.map((install) => [install.id, install]));
  const uses = new Map<string, number>();
  for (const install of byId.values()) {
    const reading = readingOf(installLabel(install));
    uses.set(reading, (uses.get(reading) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const [id, install] of byId) {
    const label = installLabel(install);
    const shared = (uses.get(readingOf(label)) ?? 0) > 1;
    labels.set(id, shared ? `${label} (${install.workerName})` : label);
  }
  return labels;
}

/**
 * What the rename field on an app's page starts with: the install's label,
 * which is the display name, else the app's name (never the Worker name,
 * which the page's title may add to tell two installs apart).
 */
export function renameStartValue(install: { displayName: string | null; name: string }): string {
  return installLabel(install);
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
