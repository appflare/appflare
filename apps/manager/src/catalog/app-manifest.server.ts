import type { FetchLike } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  type CatalogManifest,
  catalogManifestSchema,
  type IndexApp,
  type IndexCatalogManifest,
  indexAppArtifact,
  revisedArtifactProblem,
  type SigningKey,
  withRevisedCatalog,
} from "@appflare/schema";
import { createDb } from "../db/client";
import { fetchWhole, verifyArtifactManifest } from "../jobs/install/artifact";
import { verifyCatalogManifest } from "../sandbox/verify";
import {
  type RecordedRevision,
  readCatalogRevision,
  recordCatalogRevision,
  revisionApplies,
  verifyRevisedCatalog,
} from "./revisions.server";
import { OFFICIAL_CATALOG_ID } from "./sources";

/**
 * The verified artifact manifest behind a catalog entry. `index.json` carries only
 * the listing; the install form (secrets, vars, post-install notes, license) lives
 * in the signed `manifest.json`. It is fetched and verified (signature by keyId,
 * digest from the index) the first time an app version is viewed and cached in
 * KV by digest, so KV sees one write per published version, not per view. The
 * install job verifies again before it uploads anything. When the index lists
 * a revised catalog manifest for the release, the form comes from that
 * revision instead (see `revisions.server.ts`), cached the same way by its own
 * digest.
 */

/**
 * KV key of a verified `manifest.json`, addressed by its sha256 (the index
 * `digest`) and by the catalog whose keys verified it: the official
 * catalog's keep `catalog:manifest:<digest>`, a custom catalog's live under
 * `catalog:<id>:manifest:<digest>`, so what one catalog's keys verified is
 * never read as verified for another.
 */
export function manifestCacheKey(digest: string, catalogId: string = OFFICIAL_CATALOG_ID): string {
  return catalogId === OFFICIAL_CATALOG_ID
    ? `catalog:manifest:${digest}`
    : `catalog:${catalogId}:manifest:${digest}`;
}
/** Old versions age out of KV on their own. */
export const MANIFEST_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface AppManifestEnv {
  KV: KVNamespace;
  /**
   * Where a verified revised catalog manifest is recorded for installs of its
   * release (`catalog_revisions`); nothing is recorded without it.
   */
  DB?: D1Database;
}

/**
 * `catalogId` and `signingKeys` are the entry's catalog trust
 * (`CatalogTrust`): the keys its releases verify with (the built-in keys
 * when omitted, which is the official catalog) and the catalog its caches
 * belong to (the official one when omitted).
 */
export interface AppManifestOptions {
  fetch?: FetchLike;
  signingKeys?: readonly SigningKey[];
  catalogId?: string;
}

export type AppManifestRead =
  | { ok: true; manifest: ArtifactManifest }
  | { ok: false; error: string };

function parse(text: string): ArtifactManifest | null {
  try {
    const parsed = artifactManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The verified artifact manifest behind a catalog entry, as installs use it:
 * its `catalog` is the newest signed revision of the release's catalog
 * manifest (see `revisions.server.ts`), the higher of the one recorded in
 * `catalog_revisions` (when `env.DB` is given) and the one the index lists.
 * A listed revision is verified (digest, signature, fields), cached in KV by
 * its sha256 and recorded; one that cannot be read or does not verify fails
 * the read rather than fall back to an older form. The Worker is always the
 * signed one.
 */
export async function getAppManifest(
  env: AppManifestEnv,
  app: IndexApp,
  opts: AppManifestOptions = {},
): Promise<AppManifestRead> {
  const release = indexAppArtifact(app);
  const [signed, held] = await Promise.all([
    getSignedAppManifest(env, app, opts),
    // Keyed by the release's digest, so read alongside the signed manifest.
    release === null || env.DB === undefined
      ? null
      : readCatalogRevision(createDb(env.DB), release.digest),
  ]);
  if (!signed.ok || release === null) return signed;
  const recorded = held !== null && revisionApplies(signed.manifest, held) ? held : null;
  const listed = app.catalogManifest;
  if (listed === undefined || (recorded !== null && recorded.revision >= app.revision)) {
    return recorded === null
      ? signed
      : { ok: true, manifest: withRevisedCatalog(signed.manifest, recorded.catalog) };
  }
  try {
    const catalog = await loadRevisedCatalog(env, app, listed, {
      artifact: signed.manifest,
      artifactDigest: release.digest,
      fetch: opts.fetch,
      signingKeys: opts.signingKeys,
      catalogId: opts.catalogId,
    });
    return { ok: true, manifest: withRevisedCatalog(signed.manifest, catalog) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn("revised catalog manifest refused", {
      slug: app.slug,
      version: app.version,
      revision: app.revision,
      error: reason,
    });
    return {
      ok: false,
      error: `Could not load revision ${app.revision} of the catalog manifest for ${app.slug} ${app.version}: ${reason}`,
    };
  }
}

/**
 * A verified revised catalog manifest: from the KV cache (by its sha256) or
 * fetched, verified either way against the index (digest and signature) and
 * the signed release, then recorded for the release when `env.DB` is given.
 */
async function loadRevisedCatalog(
  env: AppManifestEnv,
  app: IndexApp,
  file: IndexCatalogManifest,
  release: {
    artifact: ArtifactManifest;
    artifactDigest: string;
    fetch: FetchLike | undefined;
    signingKeys: readonly SigningKey[] | undefined;
    catalogId: string | undefined;
  },
): Promise<CatalogManifest> {
  const key = catalogManifestCacheKey(file.sha256, release.catalogId);
  const expected = {
    file,
    artifact: release.artifact,
    revision: app.revision,
    ...(release.signingKeys === undefined ? {} : { keys: release.signingKeys }),
  };
  const cached = await env.KV.get(key);
  let text: string;
  let catalog: CatalogManifest;
  if (cached !== null) {
    text = cached;
    catalog = await verifyRevisedCatalog(new TextEncoder().encode(cached), expected);
  } else {
    const fetchImpl: FetchLike = release.fetch ?? ((input, init) => fetch(input, init));
    const fetched = await fetchWhole(fetchImpl, file.url);
    catalog = await verifyRevisedCatalog(fetched.bytes, expected);
    text = new TextDecoder().decode(fetched.bytes);
    await env.KV.put(key, text, { expirationTtl: MANIFEST_TTL_SECONDS });
  }
  if (env.DB !== undefined) {
    await recordCatalogRevision(
      createDb(env.DB),
      release.artifactDigest,
      { text, file, catalog },
      new Date(),
    );
  }
  return catalog;
}

/** The verified signed `manifest.json` of an entry's release, exactly as built. */
async function getSignedAppManifest(
  env: AppManifestEnv,
  app: IndexApp,
  opts: AppManifestOptions,
): Promise<AppManifestRead> {
  const release = indexAppArtifact(app);
  if (release === null) {
    return {
      ok: false,
      error: `${app.slug} ${app.version} has no prebuilt artifact; it is built in this account.`,
    };
  }
  const key = manifestCacheKey(release.digest, opts.catalogId);
  const cached = await env.KV.get(key);
  const fromCache = cached === null ? null : parse(cached);
  if (fromCache !== null) return { ok: true, manifest: fromCache };

  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  try {
    const [manifestFile, sigFile] = await Promise.all([
      fetchWhole(fetchImpl, release.manifest),
      fetchWhole(fetchImpl, release.sig),
    ]);
    const manifest = await verifyArtifactManifest(
      manifestFile.bytes,
      new TextDecoder().decode(sigFile.bytes),
      { slug: app.slug, version: app.version, digest: release.digest },
      opts.signingKeys,
    );
    await env.KV.put(key, new TextDecoder().decode(manifestFile.bytes), {
      expirationTtl: MANIFEST_TTL_SECONDS,
    });
    return { ok: true, manifest };
  } catch (error) {
    return {
      ok: false,
      error: `Could not load the signed manifest for ${app.slug} ${app.version}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * KV key of a verified catalog manifest (a sandbox or self-deploying tier
 * entry's, or a revision of a release's), addressed by its sha256 and, like
 * {@link manifestCacheKey}, by its catalog.
 */
export function catalogManifestCacheKey(
  digest: string,
  catalogId: string = OFFICIAL_CATALOG_ID,
): string {
  return catalogId === OFFICIAL_CATALOG_ID
    ? `catalog:entry:${digest}`
    : `catalog:${catalogId}:entry:${digest}`;
}

export type CatalogManifestRead =
  | {
      ok: true;
      catalog: CatalogManifest;
      /** The signed artifact manifest; null for a sandbox (built later) or self-deploying tier entry. */
      manifest: ArtifactManifest | null;
    }
  | { ok: false; error: string };

function parseCatalog(text: string): CatalogManifest | null {
  try {
    const parsed = catalogManifestSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The catalog manifest behind an index entry when it is already cached in KV
 * (verified before it was stored), without fetching anything; null when it is
 * not cached yet. The catalog list uses it to read every entry cheaply.
 */
export async function readCachedCatalogManifest(
  env: AppManifestEnv,
  app: IndexApp,
  catalogId: string = OFFICIAL_CATALOG_ID,
): Promise<Extract<CatalogManifestRead, { ok: true }> | null> {
  const release = indexAppArtifact(app);
  if (release !== null && app.tier === "artifact") {
    const cached = await env.KV.get(manifestCacheKey(release.digest, catalogId));
    const manifest = cached === null ? null : parse(cached);
    if (manifest === null) return null;
    if (app.catalogManifest === undefined) {
      return { ok: true, catalog: manifest.catalog, manifest };
    }
    // A revision of the release: only once it is cached too (verified before
    // it was stored; the cheap check keeps it to this release).
    const revisedText = await env.KV.get(
      catalogManifestCacheKey(app.catalogManifest.sha256, catalogId),
    );
    const revised = revisedText === null ? null : parseCatalog(revisedText);
    if (
      revised === null ||
      app.catalogManifest.keyId !== manifest.keyId ||
      revisedArtifactProblem(manifest, revised) !== null
    ) {
      return null;
    }
    const effective = withRevisedCatalog(manifest, revised);
    return { ok: true, catalog: effective.catalog, manifest: effective };
  }
  if (app.tier === "artifact" || app.build === undefined) return null;
  const cached = await env.KV.get(catalogManifestCacheKey(app.build.manifestDigest, catalogId));
  const catalog = cached === null ? null : parseCatalog(cached);
  return catalog === null ? null : { ok: true, catalog, manifest: null };
}

/**
 * The catalog manifest behind an index entry, whatever its tier: from the
 * signed artifact manifest for an `artifact` entry, or, for a `sandbox` or
 * `self-deploying`
 * entry, from the catalog manifest the catalog publishes next to the index
 * (checked against the index's digest, slug, tier and pin, then cached in KV
 * by digest like artifact manifests).
 */
export async function getCatalogManifest(
  env: AppManifestEnv,
  app: IndexApp,
  opts: AppManifestOptions = {},
): Promise<CatalogManifestRead> {
  if (indexAppArtifact(app) !== null && app.tier === "artifact") {
    const read = await getAppManifest(env, app, opts);
    return read.ok ? { ok: true, catalog: read.manifest.catalog, manifest: read.manifest } : read;
  }
  const build = app.build;
  if (app.tier === "artifact" || build === undefined) {
    return {
      ok: false,
      error: `${app.slug} ${app.version} lists neither a release nor a catalog manifest to install it from.`,
    };
  }
  const key = catalogManifestCacheKey(build.manifestDigest, opts.catalogId);
  const cached = await env.KV.get(key);
  const fromCache = cached === null ? null : parseCatalog(cached);
  if (fromCache !== null) return { ok: true, catalog: fromCache, manifest: null };
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  try {
    const file = await fetchWhole(fetchImpl, build.manifest);
    const catalog = await verifyCatalogManifest(file.bytes, {
      slug: app.slug,
      pin: build.pin,
      digest: build.manifestDigest,
      tier: app.tier,
    });
    await env.KV.put(key, new TextDecoder().decode(file.bytes), {
      expirationTtl: MANIFEST_TTL_SECONDS,
    });
    return { ok: true, catalog, manifest: null };
  } catch (error) {
    return {
      ok: false,
      error: `Could not load the catalog manifest for ${app.slug} ${app.version}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/** What {@link refreshInstalledRevision} reads of an install. */
export interface InstalledRelease {
  catalog_version: string;
  /** sha256 of the installed `manifest.json`; null for installs that predate it. */
  artifact_digest: string | null;
}

/**
 * Records the revision the index lists for an install's release when this
 * manager does not hold it yet, so the install's Settings (and the next
 * reconfigure) show that form. A revision changes neither the version nor
 * the Worker, so it starts no job and offers no update. Does nothing unless
 * `listed` is the installed release (same version and digest) and lists a
 * newer revision than the recorded one; a failure leaves the recorded form in
 * place until the next read. `recorded` is the release's recorded revision
 * when the caller already read it (`readCatalogRevision`). Returns whether it
 * tried to record one, after which the recorded revision is read again.
 */
export async function refreshInstalledRevision(
  env: AppManifestEnv & { DB: D1Database },
  install: InstalledRelease,
  listed: IndexApp | null | undefined,
  opts: AppManifestOptions = {},
  recorded?: RecordedRevision | null,
): Promise<boolean> {
  const file = listed?.catalogManifest;
  if (
    listed == null ||
    file === undefined ||
    install.artifact_digest === null ||
    listed.version !== install.catalog_version ||
    listed.artifacts?.digest !== install.artifact_digest
  ) {
    return false;
  }
  const held =
    recorded === undefined
      ? await readCatalogRevision(createDb(env.DB), install.artifact_digest)
      : recorded;
  if (held !== null && held.revision >= listed.revision) return false;
  // Verifies and records it; a refusal is logged there and leaves the recorded form.
  await getAppManifest(env, listed, opts);
  return true;
}
