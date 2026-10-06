import { ACCESS_REQUIREMENT } from "./access";
import { type ArtifactManifest, catalogVarProblems } from "./artifact";
import { type CatalogManifest, secretKey } from "./catalog";
import { SECRET_KEYS_REQUIREMENT } from "./manager-features";

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
 *   `postInstall`, `name`, ...), and how the app goes with Cloudflare Access
 *   (`access`, and `"access"` in `requires`): the revised catalog manifest
 *   when the index lists one for that build, else the catalog manifest
 *   inside the artifact.
 *
 * A revision may change only the form fields, the copy and the Access
 * protection, but those reach the app: var defaults become its vars,
 * generated secrets its secrets, and `access` decides who reaches it and what
 * stays public. That is why the revised file is signed like the release, and
 * a manager accepts it only when the signature verifies with the release's
 * key id, everything outside {@link REVISABLE_CATALOG_FIELDS} equals the
 * signed copy (`requires` may only gain `"access"`, and `"secret-keys"` for
 * keys on the secrets it adds), and its revision is
 * above the signed one ({@link revisedArtifactProblem}). An index can never
 * change what gets built or provisioned for the Worker, nor what the account
 * must offer it; the one thing it may ask more of is Cloudflare Access
 * protection, which the manager checks the account for before it protects an
 * app. While a release lists a revision, installing it needs the revised
 * file: when it cannot be fetched or does not verify, installs and updates to
 * that release fail rather than fall back to the older form.
 */

/**
 * The top-level catalog manifest fields a revision may change: how the entry
 * is presented (where its Open buttons go, `openPath`, included), what its
 * install and settings forms ask for (a field's `link` too), and how the app
 * goes with Cloudflare Access (`access`: the protection the manager puts in
 * front of the Worker, never the Worker itself). Everything else (`slug`,
 * `repo`, `source`, `install`, `plan`, `requires`, `tokenPermissions`,
 * `resources`) describes the build or what an install provisions, and
 * changes only with a new build, with one exception: a revision may add
 * `"access"` or `"secret-keys"` to `requires`
 * ({@link requirementsRevisionProblem}).
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
  "access",
  "openPath",
];

/**
 * What a revision may do to `requires`, or why it may not: add `"access"` or
 * `"secret-keys"` and nothing else. Adding one only narrows which managers
 * list the entry (one that does not know the requirement leaves the entry
 * out). A manager that knows `"access"` asks for nothing more unless the app
 * is protected, which the revision's `access` block and the admin decide;
 * `"secret-keys"` comes with keys on secrets the revision adds
 * ({@link secretKeysRevisionProblem}), which ask nothing of the account. Any other value
 * describes what the account must offer the build, and removing one (`"access"`
 * included: the signed Worker may read the Access placeholders) could let a
 * manager install the build where it does not work.
 */
export function requirementsRevisionProblem(
  released: readonly string[],
  revised: readonly string[],
): string | null {
  const before = new Set(released);
  const after = new Set(revised);
  const removed = [...before].filter((r) => !after.has(r));
  if (removed.length > 0) {
    return `it removes ${removed.map((r) => `"${r}"`).join(", ")} from requires, which only a new build can change`;
  }
  const revisable: readonly string[] = [ACCESS_REQUIREMENT, SECRET_KEYS_REQUIREMENT];
  const added = [...after].filter((r) => !before.has(r) && !revisable.includes(r));
  if (added.length > 0) {
    return `it adds ${added.map((r) => `"${r}"`).join(", ")} to requires; a revision may add only ${revisable.map((r) => `"${r}"`).join(" or ")}, and anything else needs a new build`;
  }
  return null;
}

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
 * released one, and it may change only {@link REVISABLE_CATALOG_FIELDS}, and
 * `requires` only as {@link requirementsRevisionProblem} allows. Both are
 * parsed catalog manifests, so the schema's own rules (an Access placeholder
 * or `access.mode: "required"` needs `"access"` in `requires`) already hold
 * for `revised`.
 */
/**
 * Why a revision's secrets cannot replace the released ones, or null: a
 * revision may give a key only to a secret it adds, never change the key of
 * a released secret (giving it one, taking it away, or another), since
 * installs record a secret by its key and would lose track of the value they
 * have. A secret counts as re-keyed when the revision drops a released
 * secret's key and adds one of the same name under a key the release does
 * not have.
 */
export function secretKeysRevisionProblem(
  released: CatalogManifest["secrets"],
  revised: CatalogManifest["secrets"],
): string | null {
  const before = new Set(released.map(secretKey));
  const after = new Set(revised.map(secretKey));
  const rekeyed = revised.filter(
    (r) =>
      !before.has(secretKey(r)) &&
      released.some((s) => s.name === r.name && !after.has(secretKey(s))),
  );
  if (rekeyed.length === 0) return null;
  return `it changes the key of the secret ${rekeyed.map((r) => r.name).join(", ")}; a revision may give a key only to a secret it adds, and changing a released secret's key needs a new build`;
}

export function catalogRevisionProblem(
  released: CatalogManifest,
  revised: CatalogManifest,
): string | null {
  const from = released.revision;
  const to = revised.revision;
  if (to <= from) {
    return `its revision ${to} is not above revision ${from}, which the release was built with`;
  }
  const changed = catalogFieldChanges(released, revised);
  const fixed = changed.filter(
    (field) => field !== "requires" && !REVISABLE_CATALOG_FIELDS.includes(field),
  );
  if (fixed.length > 0) {
    return `it changes ${fixed.join(", ")}, which only a new build can change`;
  }
  if (changed.includes("secrets")) {
    const keys = secretKeysRevisionProblem(released.secrets, revised.secrets);
    if (keys !== null) return keys;
  }
  return changed.includes("requires")
    ? requirementsRevisionProblem(released.requires, revised.requires)
    : null;
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
