/**
 * Artifact version derivation.
 *
 * If the catalog `source.ref` is a semver tag (optionally `v`-prefixed) the
 * version is that tag without the `v`. Otherwise the version is
 * `0.0.0-<YYYYMMDD>.<first 7 of sha>`, where the date is the commit date when the
 * checkout is a git repo, else the build date.
 */

// Semver with optional leading `v`, optional pre-release and build metadata.
const SEMVER_TAG =
  /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;

/** Returns the semver core (without a leading `v`) when `ref` is a semver tag. */
export function semverFromRef(ref: string): string | null {
  const match = SEMVER_TAG.exec(ref.trim());
  return match ? (match[1] as string) : null;
}

/** Formats a Date as `YYYYMMDD` in UTC. */
export function formatBuildDate(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}${m}${d}`;
}

export interface DeriveVersionInput {
  ref: string;
  sha: string;
  /** `YYYYMMDD` commit date, or null when the checkout is not a git repo. */
  commitDate: string | null;
  /** `YYYYMMDD` build-date fallback. */
  buildDate: string;
}

/** Derives the artifact `version` string. */
export function deriveVersion({ ref, sha, commitDate, buildDate }: DeriveVersionInput): string {
  const semver = semverFromRef(ref);
  if (semver) {
    return semver;
  }
  const date = commitDate ?? buildDate;
  return `0.0.0-${date}.${sha.slice(0, 7)}`;
}
