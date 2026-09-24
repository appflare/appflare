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
