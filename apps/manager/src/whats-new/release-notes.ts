import { z } from "zod";
import { compareVersions, parseVersion } from "../catalog/versions";

/**
 * Appflare's release notes as "What's new" shows them. The cron reads
 * GitHub's releases list of appflare/appflare (the same request that finds
 * the newest release), keeps the newest published Appflare releases, and
 * stores them in KV; the browser only ever sees that copy. Client-safe.
 */

/** How many releases are kept. */
export const RELEASE_NOTES_LIMIT = 10;
/** Longer release bodies are cut, so one release cannot bloat every page load. */
export const RELEASE_BODY_MAX_CHARS = 20_000;

const TAG_PREFIX = "manager@";
const RELEASE_PAGE_PREFIX = "https://github.com/appflare/appflare/releases/";

export const releaseNoteSchema = z.object({
  /** `manager@<version>`. */
  tag: z.string().min(1),
  version: z.string().min(1),
  /** The release title, such as "Appflare 0.1.0". */
  name: z.string(),
  /** ISO 8601; null when GitHub did not say. */
  publishedAt: z.string().nullable(),
  /** Markdown, rendered without raw HTML. */
  body: z.string(),
  /** The release page on GitHub. */
  url: z.string(),
});
export type ReleaseNote = z.infer<typeof releaseNoteSchema>;

export const releaseNotesSchema = z.array(releaseNoteSchema);

const githubReleaseSchema = z.looseObject({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullable().optional(),
});

/** Ends a body cut at RELEASE_BODY_MAX_CHARS. */
const CUT_MARK = "\n\n…";

/**
 * Changesets writes each entry as `- <short commit>: <text>`; the commit id
 * means nothing to someone reading what changed, so it is dropped. Bodies
 * longer than RELEASE_BODY_MAX_CHARS are cut. Cleaning a cleaned body
 * changes nothing (the release check caches cleaned bodies).
 */
export function cleanReleaseBody(body: string): string {
  const cleaned = body
    .replace(/\r\n/g, "\n")
    .replace(/^(\s*[-*] )[0-9a-f]{7,40}: /gm, "$1")
    .trim();
  const alreadyCut =
    cleaned.endsWith(CUT_MARK) && cleaned.length <= RELEASE_BODY_MAX_CHARS + CUT_MARK.length;
  return cleaned.length > RELEASE_BODY_MAX_CHARS && !alreadyCut
    ? `${cleaned.slice(0, RELEASE_BODY_MAX_CHARS).trimEnd()}${CUT_MARK}`
    : cleaned;
}

/** The release page, trusted only when it is one of appflare/appflare's release pages. */
function releasePage(htmlUrl: string | undefined, tag: string): string {
  if (htmlUrl?.startsWith(RELEASE_PAGE_PREFIX)) return htmlUrl;
  return `${RELEASE_PAGE_PREFIX}tag/${encodeURIComponent(tag)}`;
}

/**
 * The newest published Appflare releases in a GitHub releases list, newest
 * first by version. Drafts, pre-releases and the repository's other tags
 * (the CLI, the sandbox Worker) are skipped. Unlike the update check, a
 * release missing its artifact still has notes worth reading.
 */
export function pickReleaseNotes(releases: unknown, limit = RELEASE_NOTES_LIMIT): ReleaseNote[] {
  if (!Array.isArray(releases)) return [];
  const notes = new Map<string, ReleaseNote>();
  for (const item of releases) {
    const parsed = githubReleaseSchema.safeParse(item);
    if (!parsed.success) continue;
    const release = parsed.data;
    if (release.draft === true || release.prerelease === true) continue;
    if (!release.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = release.tag_name.slice(TAG_PREFIX.length);
    if (!/^\d/.test(version) || parseVersion(version) === null) continue;
    if (notes.has(version)) continue;
    const name = release.name?.trim();
    notes.set(version, {
      tag: release.tag_name,
      version,
      name: name ? name : `Appflare ${version}`,
      publishedAt: release.published_at ?? null,
      body: cleanReleaseBody(release.body ?? ""),
      url: releasePage(release.html_url, release.tag_name),
    });
  }
  return [...notes.values()]
    .sort((a, b) => compareVersions(b.version, a.version) ?? 0)
    .slice(0, limit);
}

/**
 * Whether a user has yet to read `note`. `seen` is the newest version they
 * saw in "What's new". Before they first open it, the notes of the running
 * version and of every newer release count as unread, so a new manager
 * starts with what is in the version it runs rather than ten old releases.
 */
export function isUnread(note: ReleaseNote, seen: string | null, current: string): boolean {
  if (seen !== null) return (compareVersions(note.version, seen) ?? 0) > 0;
  return (compareVersions(note.version, current) ?? 0) >= 0;
}

/** How many of `notes` the user has yet to read. */
export function unreadCount(
  notes: readonly ReleaseNote[],
  seen: string | null,
  current: string,
): number {
  return notes.filter((note) => isUnread(note, seen, current)).length;
}

/** The badge text: the count, or "9+" beyond nine. */
export function unreadLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

/** The newest version among `notes` (they are kept newest first), or null. */
export function newestVersion(notes: readonly ReleaseNote[]): string | null {
  return notes[0]?.version ?? null;
}
