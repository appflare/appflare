import { semverSchema } from "@appflare/schema";

/**
 * Artifact version derivation, first match wins:
 *
 * 1. `install.version` from the catalog manifest, when set. Used when the
 *    repository's tags do not describe the app (a monorepo of many apps).
 * 2. The `source.ref` semver tag (optionally `v`-prefixed) without the `v`.
 * 3. `0.0.0-<YYYYMMDD>.<first 7 of sha>`, where the date is the commit date
 *    when the checkout is a git repo, else the build date.
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
  /** The catalog manifest's `install.version`, when set. */
  installVersion?: string | undefined;
  ref: string;
  sha: string;
  /** `YYYYMMDD` commit date, or null when the checkout is not a git repo. */
  commitDate: string | null;
  /** `YYYYMMDD` build-date fallback. */
  buildDate: string;
}

/** Where a derived version came from, in the order the rules are tried. */
export type VersionOrigin = "install.version" | "tag" | "commit";

/**
 * Derives the artifact `version` and says which rule produced it. Throws when
 * `installVersion` is set but is not semver without a leading `v`.
 */
export function deriveVersionWithOrigin({
  installVersion,
  ref,
  sha,
  commitDate,
  buildDate,
}: DeriveVersionInput): { version: string; origin: VersionOrigin } {
  if (installVersion !== undefined) {
    if (!semverSchema.safeParse(installVersion).success) {
      throw new Error(
        `install.version "${installVersion}" is not a semver version such as 1.2.3 ` +
          "(no leading v)",
      );
    }
    return { version: installVersion, origin: "install.version" };
  }
  const semver = semverFromRef(ref);
  if (semver) {
    return { version: semver, origin: "tag" };
  }
  const date = commitDate ?? buildDate;
  return { version: `0.0.0-${date}.${sha.slice(0, 7)}`, origin: "commit" };
}

/** Derives the artifact `version` string (see {@link deriveVersionWithOrigin}). */
export function deriveVersion(input: DeriveVersionInput): string {
  return deriveVersionWithOrigin(input).version;
}
