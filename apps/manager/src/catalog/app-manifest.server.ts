import type { FetchLike } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  type IndexApp,
  type SigningKey,
} from "@appflare/schema";
import { fetchWhole, verifyArtifactManifest } from "../jobs/install/artifact";

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
  const key = manifestCacheKey(app.digest);
  const cached = await env.KV.get(key);
  const fromCache = cached === null ? null : parse(cached);
  if (fromCache !== null) return { ok: true, manifest: fromCache };

  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  try {
    const [manifestFile, sigFile] = await Promise.all([
      fetchWhole(fetchImpl, app.artifacts.manifest),
      fetchWhole(fetchImpl, app.artifacts.sig),
    ]);
    const manifest = await verifyArtifactManifest(
      manifestFile.bytes,
      new TextDecoder().decode(sigFile.bytes),
      { slug: app.slug, version: app.version, digest: app.digest },
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
