import type { FetchLike } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  type CatalogManifest,
  catalogManifestSchema,
  type IndexApp,
  indexAppArtifact,
  type SigningKey,
} from "@appflare/schema";
import { fetchWhole, verifyArtifactManifest } from "../jobs/install/artifact";
import { verifyCatalogManifest } from "../sandbox/verify";

/**
 * The verified artifact manifest behind a catalog entry. `index.json` carries only
 * the listing; the install form (secrets, vars, post-install notes, license) lives
 * in the signed `manifest.json`. It is fetched and verified (signature by keyId,
 * digest from the index) the first time an app version is viewed and cached in
 * KV by digest, so KV sees one write per published version, not per view. The
 * install job verifies again before it uploads anything.
 */

const MANIFEST_KEY_PREFIX = "catalog:manifest:";

/** KV key of a verified `manifest.json`, addressed by its sha256 (the index `digest`). */
export function manifestCacheKey(digest: string): string {
  return `${MANIFEST_KEY_PREFIX}${digest}`;
}
/** Old versions age out of KV on their own. */
export const MANIFEST_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface AppManifestEnv {
  KV: KVNamespace;
}

export interface AppManifestOptions {
  fetch?: FetchLike;
  signingKeys?: readonly SigningKey[];
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

export async function getAppManifest(
  env: AppManifestEnv,
  app: IndexApp,
  opts: AppManifestOptions = {},
): Promise<AppManifestRead> {
  const release = indexAppArtifact(app);
  if (release === null) {
    return {
      ok: false,
      error: `${app.slug} ${app.version} has no prebuilt artifact; it is built in this account.`,
    };
  }
  const key = manifestCacheKey(release.digest);
  const cached = await env.KV.get(key);
  const fromCache = cached === null ? null : parse(cached);
  if (fromCache !== null) return { ok: true, manifest: fromCache };

  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  try {
    const [manifestFile, sigFile] = await Promise.all([
      fetchWhole(fetchImpl, release.artifacts.manifest),
      fetchWhole(fetchImpl, release.artifacts.sig),
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

/** KV key of a verified sandbox tier catalog manifest, addressed by its sha256. */
export function catalogManifestCacheKey(digest: string): string {
  return `catalog:entry:${digest}`;
}

export type CatalogManifestRead =
  | {
      ok: true;
      catalog: CatalogManifest;
      /** The signed artifact manifest; null for a sandbox tier entry, which is built later. */
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
 * The catalog manifest behind an index entry, whatever its tier: from the
 * signed artifact manifest for an `artifact` entry, or, for a `sandbox`
 * entry, from the catalog manifest the catalog publishes next to the index
 * (checked against the index's digest, slug, tier and pin, then cached in KV
 * by digest like artifact manifests).
 */
export async function getCatalogManifest(
  env: AppManifestEnv,
  app: IndexApp,
  opts: AppManifestOptions = {},
): Promise<CatalogManifestRead> {
  if (indexAppArtifact(app) !== null && app.tier !== "sandbox") {
    const read = await getAppManifest(env, app, opts);
    return read.ok ? { ok: true, catalog: read.manifest.catalog, manifest: read.manifest } : read;
  }
  const build = app.build;
  if (app.tier !== "sandbox" || build === undefined) {
    return { ok: false, error: `Appflare cannot install ${app.tier} tier apps yet.` };
  }
  const key = catalogManifestCacheKey(build.manifestDigest);
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
