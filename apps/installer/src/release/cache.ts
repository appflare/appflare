/**
 * The newest release's version, as `POST release` last verified it, kept in
 * the isolate for a few minutes. The deploy page asks for it on every review;
 * this keeps those requests from reaching GitHub each time.
 */

export const RELEASE_CACHE_MS = 5 * 60 * 1000;

export class ReleaseCache {
  private entry: { source: string; version: string; at: number } | null = null;

  /** The version verified less than {@link RELEASE_CACHE_MS} ago from `source`, or null. */
  get(source: string, now: number): string | null {
    const entry = this.entry;
    if (entry === null || entry.source !== source) return null;
    if (now - entry.at >= RELEASE_CACHE_MS || now < entry.at) return null;
    return entry.version;
  }

  set(source: string, version: string, now: number): void {
    this.entry = { source, version, at: now };
  }
}
