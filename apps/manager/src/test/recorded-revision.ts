import { env } from "cloudflare:workers";
import { recordCatalogRevision } from "../catalog/revisions.server";
import { createDb } from "../db/client";
import type { ArtifactFixture } from "./artifact-fixture";

/**
 * Test-only: the fixture's revised catalog manifest recorded for its release
 * in `catalog_revisions`, as a manager that verified it leaves it.
 */
export async function recordFixtureRevision(
  f: ArtifactFixture,
  now: Date = new Date(1_000),
): Promise<void> {
  const file = f.index.catalogManifest;
  if (f.revised === null || file === undefined) throw new Error("the fixture has no revision");
  await recordCatalogRevision(
    createDb(env.DB),
    f.digest,
    { catalog: f.revised.catalog, text: new TextDecoder().decode(f.revised.bytes), file },
    now,
    f.manifest.catalog,
  );
}

/** Test-only: the install runs the fixture's signed release (`manifest_json` and its digest). */
export async function setInstallRelease(installId: string, f: ArtifactFixture): Promise<void> {
  await env.DB.prepare("UPDATE installs SET manifest_json = ?2, artifact_digest = ?3 WHERE id = ?1")
    .bind(installId, new TextDecoder().decode(f.manifestBytes), f.digest)
    .run();
}
