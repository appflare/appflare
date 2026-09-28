import {
  type ArtifactManifest,
  type CatalogManifest,
  catalogManifestSchema,
  catalogRevision,
  type IndexCatalogManifest,
  revisedArtifactProblem,
  type SigningKey,
  signingKeys,
  verifySignature,
  withRevisedCatalog,
} from "@appflare/schema";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { catalog_revisions } from "../db/schema";
import { ArtifactError, sha256Hex } from "../jobs/install/artifact";

/**
 * Revised catalog manifests of signed releases. A release is immutable, so
 * when the catalog edits only an entry's form or copy (a label, a `select`
 * var, a secret the app already reads) it raises the entry's `revision`,
 * signs the revised catalog manifest with the key that signs its releases,
 * and publishes it next to the index; the row's `catalogManifest` gives its
 * URL, sha256, key id and signature. Nothing is rebuilt and the version does
 * not change, so there is no update and no job: the forms read the revision
 * instead.
 *
 * Which copy is authoritative: the Worker, and every catalog field a
 * revision may not change, always come from the signed `manifest.json`. The
 * forms and copy (secrets, vars, post-install notes, name, ...) come from the
 * newest revision this manager verified for that release, recorded in
 * `catalog_revisions` by the release's digest, else from the signed copy.
 * Form fields reach the Worker (var defaults become its vars, generated
 * secrets its secrets), so a revision is accepted only when its bytes match
 * the index, its signature verifies with the embedded keys under the key id
 * that signed the release, it is for the same app, and
 * `revisedArtifactProblem` finds nothing (it changes only the form and copy,
 * and its vars suit the signed Worker).
 */

/** What a revised catalog manifest must be: the index's signed file, for this signed release. */
export interface ExpectedRevision {
  file: IndexCatalogManifest;
  /** The verified signed artifact manifest of the release it revises. */
  artifact: ArtifactManifest;
  /** The index row's `revision`, when it lists one. */
  revision?: number;
  /** Trusted signing keys; the embedded `signingKeys` unless a test injects others. */
  keys?: readonly SigningKey[];
}

/**
 * Verifies a revised catalog manifest: the index's sha256, the signature (the
 * same verifier as `manifest.sig`, with the release's own key id), then the
 * fields against the signed release. Throws `ArtifactError`; an unsigned or
 * badly signed revision is refused before its contents are read.
 */
export async function verifyRevisedCatalog(
  bytes: Uint8Array,
  expected: ExpectedRevision,
): Promise<CatalogManifest> {
  const { artifact, file } = expected;
  const digest = await sha256Hex(bytes);
  if (digest !== file.sha256) {
    throw new ArtifactError(
      `the revised catalog manifest's digest ${digest} does not match the catalog index (${file.sha256})`,
    );
  }
  if (file.keyId !== artifact.keyId) {
    throw new ArtifactError(
      `the revised catalog manifest is signed with key "${file.keyId}", but ${artifact.app} ${artifact.version} was released with key "${artifact.keyId}"`,
    );
  }
  try {
    await verifySignature(bytes, file.signature, file.keyId, expected.keys ?? signingKeys, {
      signature: "the revised catalog manifest's signature",
      subject: "the revised catalog manifest's",
    });
  } catch (error) {
    throw new ArtifactError(error instanceof Error ? error.message : String(error));
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ArtifactError("the revised catalog manifest is not valid JSON");
  }
  const parsed = catalogManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ArtifactError(`the revised catalog manifest is not valid: ${parsed.error.message}`);
  }
  const catalog = parsed.data;
  if (catalog.slug !== artifact.app) {
    throw new ArtifactError(
      `the revised catalog manifest is for "${catalog.slug}", not "${artifact.app}"`,
    );
  }
  if (expected.revision !== undefined && catalogRevision(catalog) !== expected.revision) {
    throw new ArtifactError(
      `the revised catalog manifest is revision ${catalogRevision(catalog)}, the catalog index lists revision ${expected.revision}`,
    );
  }
  const problem = revisedArtifactProblem(artifact, catalog);
  if (problem !== null) {
    throw new ArtifactError(
      `the revised catalog manifest cannot replace the one ${artifact.app} ${artifact.version} was built with: ${problem}`,
    );
  }
  return catalog;
}

/** A verified revision as `catalog_revisions` holds it. */
export interface RecordedRevision {
  revision: number;
  sha256: string;
  keyId: string;
  signature: string;
  /** The revised catalog manifest, exactly as published and verified. */
  text: string;
  catalog: CatalogManifest;
}

function parseCatalog(text: string): CatalogManifest | null {
  try {
    const parsed = catalogManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The newest revision recorded for the release with this `manifest.json` digest, or null. */
export async function readCatalogRevision(
  orm: Database,
  artifactDigest: string,
): Promise<RecordedRevision | null> {
  const [row] = await orm
    .select()
    .from(catalog_revisions)
    .where(eq(catalog_revisions.artifact_digest, artifactDigest))
    .limit(1);
  if (row === undefined) return null;
  const catalog = parseCatalog(row.catalog_json);
  return catalog === null
    ? null
    : {
        revision: row.revision,
        sha256: row.sha256,
        keyId: row.key_id,
        signature: row.signature,
        text: row.catalog_json,
        catalog,
      };
}

/**
 * Records a verified revision of the release with `artifactDigest`, with its
 * digest and signature. Skips a lower revision than the one held (an older
 * index cannot bring back an older form) and the same one again; refuses the
 * same revision with other bytes, which the catalog never publishes (it must
 * raise the revision to change the file). Writes only when something changes
 * (D1 writes are metered). Returns whether it wrote. Throws `ArtifactError`.
 */
export async function recordCatalogRevision(
  orm: Database,
  artifactDigest: string,
  revised: { text: string; file: IndexCatalogManifest; catalog: CatalogManifest },
  now: Date,
): Promise<boolean> {
  const revision = catalogRevision(revised.catalog);
  const { sha256, keyId, signature } = revised.file;
  const current = await readCatalogRevision(orm, artifactDigest);
  if (current !== null && current.revision > revision) return false;
  if (current !== null && current.revision === revision) {
    if (current.sha256 === sha256) return false;
    throw new ArtifactError(
      `revision ${revision} of this release is already recorded with other bytes (sha256 ${current.sha256}, now ${sha256}); a changed revised catalog manifest must raise its revision`,
    );
  }
  const values = {
    artifact_digest: artifactDigest,
    revision,
    sha256,
    key_id: keyId,
    signature,
    catalog_json: revised.text,
    recorded_at: now,
  };
  const { artifact_digest: _key, ...set } = values;
  await orm
    .insert(catalog_revisions)
    .values(values)
    .onConflictDoUpdate({ target: catalog_revisions.artifact_digest, set });
  return true;
}

/** The recorded revision applies to `manifest`: its release's key, and only form and copy changed. */
export function revisionApplies(manifest: ArtifactManifest, recorded: RecordedRevision): boolean {
  return (
    recorded.keyId === manifest.keyId && revisedArtifactProblem(manifest, recorded.catalog) === null
  );
}

/**
 * The newest revision recorded for the release, when it applies to
 * `manifest` (checked again on every read; it costs nothing and keeps a row
 * from ever applying to another release). Null otherwise.
 */
export async function recordedRevisionFor(
  orm: Database,
  manifest: ArtifactManifest,
  artifactDigest: string | null,
): Promise<RecordedRevision | null> {
  if (artifactDigest === null) return null;
  const recorded = await readCatalogRevision(orm, artifactDigest);
  return recorded !== null && revisionApplies(manifest, recorded) ? recorded : null;
}

/**
 * The artifact manifest as an install of the release with `artifactDigest`
 * uses it: the signed Worker, with the newest recorded revision of its catalog
 * manifest in place of the one it was built with. The signed manifest as it
 * is when nothing is recorded (or `artifactDigest` is null).
 */
export async function effectiveManifest(
  orm: Database,
  manifest: ArtifactManifest,
  artifactDigest: string | null,
): Promise<ArtifactManifest> {
  const recorded = await recordedRevisionFor(orm, manifest, artifactDigest);
  return recorded === null ? manifest : withRevisedCatalog(manifest, recorded.catalog);
}

/**
 * `manifest` as {@link effectiveManifest} gives it, from a recorded revision
 * the caller already read (`readCatalogRevision`); the signed manifest when
 * it is null or does not apply.
 */
export function manifestWithRevision(
  manifest: ArtifactManifest,
  recorded: RecordedRevision | null,
): ArtifactManifest {
  return recorded !== null && revisionApplies(manifest, recorded)
    ? withRevisedCatalog(manifest, recorded.catalog)
    : manifest;
}
