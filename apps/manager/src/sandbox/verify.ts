import {
  type ArtifactManifest,
  artifactManifestSchema,
  type CatalogManifest,
  catalogManifestSchema,
  type InstallTier,
} from "@appflare/schema";
import { ArtifactError, sha256Hex } from "../jobs/install/artifact";

/**
 * Trust checks for the sandbox tier. A sandbox tier entry has no signed
 * artifact: the catalog publishes its catalog manifest next to the index,
 * addressed by sha256, and the sandbox Worker builds an unsigned artifact
 * from the pinned commit in the user's own account. What the manager checks:
 *
 * - the catalog manifest's bytes match the digest in the index, it is for
 *   this slug, it is a `sandbox` tier entry, and it pins the index's commit;
 * - the built `manifest.json` came over the `SANDBOX` binding, its sha256 is
 *   the digest the same build reported, it is unsigned (`keyId: "unsigned"`,
 *   which the signed path always refuses), and its app, version, commit and
 *   embedded catalog manifest are the ones the build was asked for.
 */

/** Keys sorted at every level, so two parses of the same document compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

export interface ExpectedCatalogManifest {
  slug: string;
  /** The index's `build.pin`. */
  pin: string;
  /** The index's `build.manifestDigest`. */
  digest: string;
  /**
   * The index entry's tier: `sandbox` (the default) or `self-deploying`,
   * whose catalog manifest is published the same way and holds the
   * installer's commands.
   */
  tier?: Exclude<InstallTier, "artifact">;
}

/** Verifies a sandbox entry's published catalog manifest. Throws `ArtifactError`. */
export async function verifyCatalogManifest(
  bytes: Uint8Array,
  expected: ExpectedCatalogManifest,
): Promise<CatalogManifest> {
  const digest = await sha256Hex(bytes);
  if (digest !== expected.digest) {
    throw new ArtifactError(
      `the catalog manifest's digest ${digest} does not match the catalog index (${expected.digest})`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ArtifactError("the catalog manifest is not valid JSON");
  }
  const parsed = catalogManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ArtifactError(`the catalog manifest is not valid: ${parsed.error.message}`);
  }
  const catalog = parsed.data;
  if (catalog.slug !== expected.slug) {
    throw new ArtifactError(
      `the catalog manifest is for "${catalog.slug}", not "${expected.slug}"`,
    );
  }
  const tier = expected.tier ?? "sandbox";
  if (catalog.install.tier !== tier) {
    throw new ArtifactError(
      `the catalog manifest is a ${catalog.install.tier} tier entry, not a ${tier} tier entry`,
    );
  }
  if (catalog.source.sha !== expected.pin) {
    throw new ArtifactError(
      `the catalog manifest pins ${catalog.source.sha}, the catalog index ${expected.pin}`,
    );
  }
  return catalog;
}

export interface ExpectedBuild {
  slug: string;
  version: string;
  /** The commit the build was asked to check out. */
  pin: string;
  /** The sha256 of `manifest.json` that the sandbox Worker's build result reported. */
  digest: string;
  /** The catalog manifest the build was asked to pack. */
  catalog: CatalogManifest;
}

/**
 * Verifies the `manifest.json` of a sandbox build. Call it only on bytes read
 * through the `SANDBOX` binding: an unsigned manifest is acceptable only
 * because it was built in this account by this account's sandbox Worker.
 * Throws `ArtifactError`.
 */
export async function verifyBuiltManifest(
  bytes: Uint8Array,
  expected: ExpectedBuild,
): Promise<ArtifactManifest> {
  const digest = await sha256Hex(bytes);
  if (digest !== expected.digest) {
    throw new ArtifactError(
      `the built manifest.json's digest ${digest} does not match the one the build reported (${expected.digest})`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ArtifactError("the built manifest.json is not valid JSON");
  }
  const parsed = artifactManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ArtifactError(
      `the built manifest.json is not a valid artifact manifest: ${parsed.error.message}`,
    );
  }
  const manifest = parsed.data;
  if (manifest.keyId !== "unsigned") {
    throw new ArtifactError(
      `the built manifest.json names signing key "${manifest.keyId}"; a sandbox build is always unsigned`,
    );
  }
  if (manifest.app !== expected.slug || manifest.catalog.slug !== expected.slug) {
    throw new ArtifactError(`the build is for "${manifest.app}", not "${expected.slug}"`);
  }
  if (manifest.version !== expected.version) {
    throw new ArtifactError(
      `the build is version ${manifest.version}, the catalog lists ${expected.version}`,
    );
  }
  if (manifest.source.sha !== expected.pin) {
    throw new ArtifactError(
      `the build is from commit ${manifest.source.sha}, not the pinned ${expected.pin}`,
    );
  }
  if (manifest.catalog.install.tier !== "sandbox") {
    throw new ArtifactError("the build does not carry a sandbox tier catalog manifest");
  }
  // The embedded catalog manifest decides the secrets form, the post-install
  // notes and the health check; it must be the one the catalog published.
  if (canonical(manifest.catalog) !== canonical(expected.catalog)) {
    throw new ArtifactError(
      "the build's manifest.json does not carry the catalog manifest it was built from",
    );
  }
  return manifest;
}

/** What a build from a repository (or from source) is expected to be. */
export interface ExpectedSourceBuild {
  /** `owner/repo` the build was asked for. */
  repo: string;
  /** The commit the sandbox Worker reported building. */
  commit: string;
  /** The version the sandbox Worker reported. */
  version: string;
  /** The sha256 of `manifest.json` the build reported. */
  digest: string;
  /** For a catalog app built from source: its catalog slug, which the build must keep. */
  slug?: string;
  /**
   * For a catalog app built from source: the catalog manifest the build was
   * asked to keep. What decides what the install sets up and asks for (see
   * {@link catalogTerms}) must be the catalog's, whatever the commit's own
   * build did to the packer's output.
   */
  baseline?: CatalogManifest;
}

/**
 * The parts of a catalog manifest that decide what an install sets up and
 * what it asks the admin for: the secrets (by name), the Worker name rules,
 * Email Routing, the health check, the app's own token permissions, the
 * post-install notes, the plan and requirements, and resource shapes. A
 * build from source replaces only the source, the tier, the version and
 * the build command.
 */
export function catalogTerms(catalog: CatalogManifest): string {
  return canonical({
    slug: catalog.slug,
    repo: catalog.repo,
    secrets: catalog.secrets.map((s) => [s.name, s.generate]),
    workerName: catalog.install.workerName,
    fixedWorkerName: catalog.install.fixedWorkerName ?? false,
    emailRouting: catalog.install.emailRouting ?? null,
    healthPath: catalog.install.healthPath ?? null,
    healthMode: catalog.install.healthMode ?? null,
    tokenPermissions: catalog.tokenPermissions,
    postInstall: catalog.postInstall,
    plan: catalog.plan,
    requires: catalog.requires,
    resources: catalog.resources ?? null,
  });
}

/**
 * Verifies the `manifest.json` of a build from a repository, read through
 * the `SANDBOX` binding: its sha256 is the digest the build reported, it is
 * unsigned and valid, it is a sandbox tier build of the repository and
 * commit that were built, under the version reported, and a catalog app
 * built from source keeps its slug. Its catalog manifest was worked out by
 * the sandbox Worker, not published by the catalog, so nothing else of it can
 * be checked; the admin reviews it before installing. Throws `ArtifactError`.
 */
export async function verifySourceBuildManifest(
  bytes: Uint8Array,
  expected: ExpectedSourceBuild,
): Promise<ArtifactManifest> {
  const digest = await sha256Hex(bytes);
  if (digest !== expected.digest) {
    throw new ArtifactError(
      `the built manifest.json's digest ${digest} does not match the one the build reported (${expected.digest})`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ArtifactError("the built manifest.json is not valid JSON");
  }
  const parsed = artifactManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ArtifactError(
      `the built manifest.json is not a valid artifact manifest: ${parsed.error.message}`,
    );
  }
  const manifest = parsed.data;
  const problems = [
    manifest.keyId === "unsigned" ? null : `it names signing key "${manifest.keyId}"`,
    manifest.app === manifest.catalog.slug
      ? null
      : `its app ${manifest.app} is not its catalog slug`,
    expected.slug === undefined || manifest.app === expected.slug
      ? null
      : `it is "${manifest.app}", not "${expected.slug}"`,
    manifest.version === expected.version ? null : `it is version ${manifest.version}`,
    manifest.source.repo === expected.repo ? null : `it is from ${manifest.source.repo}`,
    manifest.source.sha === expected.commit ? null : `it is from ${manifest.source.sha}`,
    manifest.catalog.repo === expected.repo
      ? null
      : `its catalog manifest names ${manifest.catalog.repo}`,
    manifest.catalog.install.tier === "sandbox" ? null : "it is not a sandbox tier build",
    expected.baseline === undefined ||
    catalogTerms(manifest.catalog) === catalogTerms(expected.baseline)
      ? null
      : "its catalog manifest is not the catalog's",
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) {
    throw new ArtifactError(
      `the built manifest.json does not describe this build of ${expected.repo} at ${expected.commit.slice(0, 12)}: ${problems.join("; ")}`,
    );
  }
  return manifest;
}
