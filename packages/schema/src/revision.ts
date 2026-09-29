import { type ArtifactManifest, catalogVarProblems } from "./artifact";
import type { CatalogManifest } from "./catalog";

/**
 * Catalog manifest revisions: an edit of an entry's form or copy for a build
 * that is already released.
 *
 * A release `<slug>@<version>` is immutable, and its signed `manifest.json`
 * embeds the catalog manifest it was built with. An edit that changes only
 * {@link REVISABLE_CATALOG_FIELDS} (a label, a `select` var, a new secret the
 * app already reads) raises the manifest's `revision` instead of moving its
 * pin. The release stays exactly as it is; catalog CI signs the revised
 * catalog manifest with the key that signs its releases (same key and key id
 * as `manifest.sig`, in the signing job that runs no app code) and publishes
 * it next to its index. The index row points at it with the sha256 of its
 * bytes and the signature (`catalogManifest`). Release identity is the pair
 * (version, revision).
 *
 * Which copy is authoritative:
 *
 * - the Worker (modules, bindings, compatibility, assets, migrations) and
 *   every catalog field outside {@link REVISABLE_CATALOG_FIELDS}: always the
 *   signed artifact manifest;
 * - the install and settings forms and the copy (`secrets`, `vars`,
 *   `postInstall`, `name`, ...): the revised catalog manifest when the index
 *   lists one for that build, else the catalog manifest inside the artifact.
 *
 * A revision may change only the form fields and copy, but those reach the
 * Worker: var defaults become its vars, and generated secrets its secrets.
 * That is why the revised file is signed like the release, and a manager
 * accepts it only when the signature verifies with the release's key id,
 * everything outside {@link REVISABLE_CATALOG_FIELDS} equals the signed copy,
 * and its revision is above the signed one ({@link revisedArtifactProblem}).
 * An index can never change what gets built, provisioned, or asked of the
 * account. While a release lists a revision, installing it needs the revised
 * file: when it cannot be fetched or does not verify, installs and updates to
 * that release fail rather than fall back to the older form.
 */

/**
 * The top-level catalog manifest fields a revision may change: how the entry
 * is presented and what its install and settings forms ask for. Everything
 * else (`slug`, `repo`, `source`, `install`, `plan`, `requires`,
 * `tokenPermissions`, `resources`) describes the build or what an install
 * provisions, and changes only with a new build.
 */
export const REVISABLE_CATALOG_FIELDS: readonly string[] = [
  "$schema",
  "name",
  "summary",
  "tagline",
  "homepage",
  "license",
  "licenseNote",
  "categories",
  "authors",
  "maintainers",
  "secrets",
  "vars",
  "postInstall",
  "bump",
  "revision",
];

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** JSON with object keys sorted at every level, so equal documents compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "undefined";
}

/** The top-level fields whose values differ between two catalog manifests, sorted. */
export function catalogFieldChanges(a: CatalogManifest, b: CatalogManifest): string[] {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])]
    .filter((key) => canonicalJson(x[key]) !== canonicalJson(y[key]))
    .sort();
}

/**
 * Why `revised` cannot stand in for `released`, the catalog manifest a
 * release was built with, or null when it can: its revision must be above the
 * released one, and it may change only {@link REVISABLE_CATALOG_FIELDS}.
 */
export function catalogRevisionProblem(
  released: CatalogManifest,
  revised: CatalogManifest,
): string | null {
  const from = released.revision;
  const to = revised.revision;
  if (to <= from) {
    return `its revision ${to} is not above revision ${from}, which the release was built with`;
  }
  const fixed = catalogFieldChanges(released, revised).filter(
    (field) => !REVISABLE_CATALOG_FIELDS.includes(field),
  );
  if (fixed.length > 0) {
    return `it changes ${fixed.join(", ")}, which only a new build can change`;
  }
  return null;
}

/**
 * Why `revised` cannot stand in for the catalog manifest inside `artifact`,
 * or null when it can: {@link catalogRevisionProblem}, and its vars must suit
 * the artifact's Worker as the packer requires of the signed copy (a var the
 * Worker reads as JSON takes JSON text).
 */
export function revisedArtifactProblem(
  artifact: Pick<ArtifactManifest, "catalog" | "worker">,
  revised: CatalogManifest,
): string | null {
  return (
    catalogRevisionProblem(artifact.catalog, revised) ??
    catalogVarProblems(artifact.worker.bindings, revised.vars)[0] ??
    null
  );
}

/**
 * The artifact manifest as installs use it: the signed Worker with the revised
 * catalog manifest in place of the one it was built with. Check the revision
 * with {@link revisedArtifactProblem} first.
 */
export function withRevisedCatalog<T extends Pick<ArtifactManifest, "catalog">>(
  artifact: T,
  revised: CatalogManifest,
): T {
  return { ...artifact, catalog: revised };
}
