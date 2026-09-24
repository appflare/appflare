import { type ReleaseNote, releaseNotesSchema } from "./release-notes";

/**
 * The stored copy of Appflare's release notes, in the manager's KV next to
 * the newest release (`manager:latest`). Written by the release check in the
 * cron (and by "Check for updates"), read by "What's new".
 *
 * KV writes are scarce on the free plan (1,000 a day), so the notes are
 * written only when they changed: a release, or an edit to a release's
 * notes. Every other check costs one read.
 */

export const RELEASE_NOTES_KEY = "manager:release-notes";

/** Stores `notes` unless the stored copy is the same. Returns whether it wrote. */
export async function storeReleaseNotes(
  kv: KVNamespace,
  notes: readonly ReleaseNote[],
): Promise<boolean> {
  const text = JSON.stringify(notes);
  if ((await kv.get(RELEASE_NOTES_KEY)) === text) return false;
  await kv.put(RELEASE_NOTES_KEY, text);
  return true;
}

/** The stored notes, newest first; empty before the first check or when unreadable. */
export async function readReleaseNotes(kv: KVNamespace | undefined): Promise<ReleaseNote[]> {
  const text = await kv?.get(RELEASE_NOTES_KEY);
  if (text == null) return [];
  try {
    const parsed = releaseNotesSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
