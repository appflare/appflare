import type { FetchLike } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  artifactManifestSchema,
  SANDBOX_BUCKET_BINDING,
  SANDBOX_CONTAINERS,
  SANDBOX_RELEASE_TAG_PREFIX,
  SANDBOX_VERSION_METADATA_BINDING,
  type SigningKey,
  signingKeys,
  verifyManifestSignature,
  workerUploadProblem,
} from "@appflare/schema";
import { z } from "zod";
import sandboxPackage from "../../../sandbox/package.json";
import {
  type GithubRepository,
  rateLimitMessage,
  rateLimitOf,
  releaseDownloadUrl,
  repositoryOfReleasesApi,
  retryTime,
} from "../catalog/github-releases";
import { managerReleasesUrl } from "../catalog/manager-releases.server";
import { type ReleaseAssets, releaseAssetsSchema } from "../catalog/release-assets";
import { compareVersions } from "../catalog/versions";
import { ArtifactError } from "../jobs/install/artifact";
import { isManagerKeyId } from "../jobs/self-update/plan";

/**
 * The sandbox Worker release this manager deploys. The manager and the
 * sandbox Worker are released from the same commit (`manager@<version>` and
 * `sandbox@<version>` come out of one release run), so each manager build
 * pins the sandbox Worker version of its own commit: enabling deploys exactly
 * that release, and a manager whose pin is newer than the deployed sandbox
 * Worker offers "Update sandbox".
 */
export const PINNED_SANDBOX_VERSION: string = sandboxPackage.version;

/** The artifact manifest's `app` of every sandbox Worker release. */
export const SANDBOX_APP = "appflare-sandbox";

/** Whether the deployed sandbox Worker (by its reported version) is older than the pin. */
export function sandboxUpdateAvailable(
  deployed: string | null | undefined,
  pinned: string = PINNED_SANDBOX_VERSION,
): boolean {
  if (deployed == null || deployed === pinned) return false;
  const order = compareVersions(deployed, pinned);
  return order !== null && order < 0;
}

/** The GitHub API URL of one sandbox Worker release, next to the manager's own feed. */
export function sandboxReleaseUrl(env: { MANAGER_RELEASES_URL?: string }, version: string): string {
  return `${managerReleasesUrl(env)}/tags/${encodeURIComponent(`${SANDBOX_RELEASE_TAG_PREFIX}${version}`)}`;
}

const githubReleaseSchema = z.looseObject({
  tag_name: z.string(),
  draft: z.boolean().optional(),
  assets: z
    .array(
      z.looseObject({
        name: z.string(),
        url: z.string().optional(),
        browser_download_url: z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * The three asset URLs of the sandbox Worker release `version`, from GitHub's
 * answer for its tag: with `viaApi` (a GitHub token is configured, so the
 * repository may be private) the API asset URLs a token can read, otherwise
 * the public download URLs. Throws `ArtifactError` for a release that is a
 * draft, has another tag, or lacks an asset.
 */
export function sandboxReleaseAssets(
  release: unknown,
  version: string,
  opts: { viaApi: boolean },
): ReleaseAssets {
  const parsed = githubReleaseSchema.safeParse(release);
  const tag = `${SANDBOX_RELEASE_TAG_PREFIX}${version}`;
  if (!parsed.success || parsed.data.tag_name !== tag) {
    throw new ArtifactError(`GitHub did not answer with the release ${tag}`);
  }
  if (parsed.data.draft === true) {
    throw new ArtifactError(`the release ${tag} is not published yet`);
  }
  const urlOf = (name: string): string => {
    const asset = parsed.data.assets?.find((a) => a.name === name);
    const url =
      opts.viaApi && asset?.url?.startsWith("https://api.github.com/")
        ? asset.url
        : asset?.browser_download_url;
    if (url === undefined) throw new ArtifactError(`the release ${tag} has no ${name}`);
    return url;
  };
  const assets = releaseAssetsSchema.safeParse({
    zip: urlOf(`${SANDBOX_APP}-${version}.zip`),
    manifest: urlOf("manifest.json"),
    sig: urlOf("manifest.sig"),
  });
  if (!assets.success) throw new ArtifactError(`the release ${tag} has unusable asset URLs`);
  return assets.data;
}

/**
 * The repository whose public download URLs serve the sandbox Worker
 * release when no token reads it through GitHub's API: the release feed's
 * repository on GitHub. Null with a token, or for a feed that is not GitHub's.
 */
function downloadRepository(
  env: { MANAGER_RELEASES_URL?: string },
  opts: { viaApi: boolean },
): GithubRepository | null {
  return opts.viaApi ? null : repositoryOfReleasesApi(managerReleasesUrl(env));
}

/** The three assets of the sandbox Worker release `version` at their public download URLs. */
export function sandboxDownloadAssets(
  repository: GithubRepository,
  version: string,
): ReleaseAssets {
  const tag = `${SANDBOX_RELEASE_TAG_PREFIX}${version}`;
  return releaseAssetsSchema.parse({
    zip: releaseDownloadUrl(repository, tag, `${SANDBOX_APP}-${version}.zip`),
    manifest: releaseDownloadUrl(repository, tag, "manifest.json"),
    sig: releaseDownloadUrl(repository, tag, "manifest.sig"),
  });
}

/**
 * The first byte of the release's `manifest.json` at its download URL: a
 * published release serves it (a draft's assets are not public), a missing
 * one answers 404. This is github.com, not the API, so the API's rate limit
 * does not apply.
 */
async function askForManifest(fetchImpl: FetchLike, assets: ReleaseAssets): Promise<Response> {
  return fetchImpl(assets.manifest, {
    headers: { range: "bytes=0-0" },
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * The retryable error for a refusal that does not mean "no such release",
 * naming GitHub's rate limit when it is one. `via`: the API with or without a
 * token, or a download URL (github.com, which the API's limit does not
 * cover). Consumes the body.
 */
async function githubRefusal(
  response: Response,
  via: "token" | "no-token" | "download",
): Promise<{ error: Error; rateLimited: boolean }> {
  const now = Date.now();
  const until = await rateLimitOf(response, now);
  if (until === null) {
    return {
      error: new Error(`GitHub answered HTTP ${response.status} for the sandbox Worker release`),
      rateLimited: false,
    };
  }
  const message =
    via === "download"
      ? `GitHub is limiting downloads from Cloudflare's network right now (HTTP ${response.status}). Try again after ${retryTime(until, now)}.`
      : rateLimitMessage(until, now, via === "token", "retry");
  return { error: new Error(message), rateLimited: true };
}

/**
 * Finds the release `version` on GitHub through `fetchImpl` (the release
 * feed's fetch, which carries the GitHub token only to GitHub). Without a
 * token its assets have fixed download URLs, and one request for the
 * manifest proves it is published; with one, GitHub's API answers for the
 * tag. A missing release is final; an outage or a rate limit is retried by
 * the step.
 */
export async function findSandboxRelease(
  fetchImpl: FetchLike,
  env: { MANAGER_RELEASES_URL?: string },
  version: string,
  opts: { viaApi: boolean },
): Promise<ReleaseAssets> {
  const tag = `${SANDBOX_RELEASE_TAG_PREFIX}${version}`;
  const repository = downloadRepository(env, opts);
  if (repository !== null) {
    const assets = sandboxDownloadAssets(repository, version);
    const response = await askForManifest(fetchImpl, assets);
    if (response.ok || response.status === 404) await response.body?.cancel();
    if (response.ok) return assets;
    if (response.status === 404) {
      throw new ArtifactError(`GitHub has no sandbox Worker release ${tag} (HTTP 404).`);
    }
    throw (await githubRefusal(response, "download")).error;
  }
  const response = await fetchImpl(sandboxReleaseUrl(env, version), {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    if (response.status === 404) {
      await response.body?.cancel();
      throw new ArtifactError(`GitHub has no sandbox Worker release ${tag} (HTTP 404).`);
    }
    const refusal = await githubRefusal(response, opts.viaApi ? "token" : "no-token");
    if (refusal.rateLimited || response.status === 429 || response.status >= 500) {
      throw refusal.error;
    }
    throw new ArtifactError(
      `GitHub has no sandbox Worker release ${tag} (HTTP ${response.status}).`,
    );
  }
  return sandboxReleaseAssets(await response.json(), version, opts);
}

/**
 * Why the release `version` cannot be read, for a start that turns sandbox
 * builds on before an install or build: one GitHub call, the same one the
 * enable job makes first. Null when the release is there (with a token, the
 * API's answer shows all three assets; without one, only `manifest.json`
 * is asked for, and a missing zip or signature surfaces when the job reads
 * them), and also when GitHub could not tell (a rate limit, an outage, a
 * network error), since the job's own step retries those.
 */
export async function sandboxReleaseProblem(
  fetchImpl: FetchLike,
  env: { MANAGER_RELEASES_URL?: string },
  version: string,
  opts: { viaApi: boolean },
): Promise<string | null> {
  const missing = `GitHub has no sandbox Worker release ${SANDBOX_RELEASE_TAG_PREFIX}${version}.`;
  const repository = downloadRepository(env, opts);
  if (repository !== null) {
    try {
      const response = await askForManifest(fetchImpl, sandboxDownloadAssets(repository, version));
      await response.body?.cancel();
      return response.status === 404 ? missing : null;
    } catch {
      return null;
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(sandboxReleaseUrl(env, version), {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 404 ? missing : null;
  }
  try {
    sandboxReleaseAssets(await response.json(), version, opts);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `The sandbox Worker release cannot be used: ${message}.`;
  }
}

/**
 * The bindings a sandbox Worker release must declare, exactly: the two
 * container classes, the build bucket, and its version var, plus the version
 * metadata binding releases carry since it existed. Anything else means a
 * sandbox Worker newer than this manager, which is refused rather than
 * deployed half-configured.
 */
function checkSandboxBindings(manifest: ArtifactManifest): string[] {
  const problems: string[] = [];
  const expected = new Set([
    ...SANDBOX_CONTAINERS.map((c) => `durable_object_namespace:${c.class_name}`),
    `r2_bucket:${SANDBOX_BUCKET_BINDING}`,
    "plain_text:APPFLARE_VERSION",
  ]);
  const optional = new Set([`version_metadata:${SANDBOX_VERSION_METADATA_BINDING}`]);
  for (const binding of manifest.worker.bindings) {
    const key = `${binding.type}:${binding.name}`;
    if (optional.delete(key)) continue;
    if (!expected.delete(key)) {
      problems.push(
        `the release has a ${binding.type} binding (${binding.name}) this version of Appflare does not know; update Appflare first`,
      );
      continue;
    }
    if (binding.type === "plain_text" && binding.text !== manifest.version) {
      problems.push(
        `the release's APPFLARE_VERSION is ${JSON.stringify(binding.text)}, not ${manifest.version}`,
      );
    }
    if (binding.type === "durable_object_namespace") {
      const container = SANDBOX_CONTAINERS.find((c) => c.class_name === binding.name);
      if (binding.class_name !== container?.class_name) {
        problems.push(`the release binds ${binding.name} to another class`);
      }
    }
  }
  if (expected.size > 0) problems.push(`the release lacks ${[...expected].join(", ")}`);
  if (manifest.worker.migrations.length === 0) {
    problems.push("the release declares no Durable Object migrations for its container classes");
  }
  return problems;
}

/**
 * Verifies a sandbox Worker release's `manifest.json` against `manifest.sig`:
 * the signature (key by the manifest's `keyId`; only Appflare's own release
 * keys, never a catalog key), the schema, `app`, the requested version, its
 * bindings, and that its modules fit one upload. Throws `ArtifactError`.
 * Every module's sha256 is checked again when the upload reads it.
 */
export async function verifySandboxManifest(
  manifestBytes: Uint8Array,
  signatureBase64: string,
  expectedVersion: string,
  keys: readonly SigningKey[] = signingKeys,
): Promise<ArtifactManifest> {
  let keyId: string;
  try {
    ({ keyId } = await verifyManifestSignature(manifestBytes, signatureBase64.trim(), keys));
  } catch (error) {
    throw new ArtifactError(error instanceof Error ? error.message : String(error));
  }
  if (!isManagerKeyId(keyId)) {
    throw new ArtifactError(
      `manifest.json is signed with "${keyId}", which does not sign Appflare releases`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new ArtifactError("manifest.json is not valid JSON");
  }
  const parsed = artifactManifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new ArtifactError(
      `manifest.json is not a valid artifact manifest: ${parsed.error.message}`,
    );
  }
  const manifest = parsed.data;
  if (manifest.app !== SANDBOX_APP) {
    throw new ArtifactError(`the artifact is "${manifest.app}", not a sandbox Worker release`);
  }
  if (manifest.version !== expectedVersion) {
    throw new ArtifactError(
      `the artifact is version ${manifest.version}, the release is ${expectedVersion}`,
    );
  }
  // The sandbox Worker runs code; an artifact of static assets only cannot be one.
  if (manifest.worker.mainModule === undefined) {
    throw new ArtifactError("the release has no Worker code (it serves static assets only)");
  }
  const tooBig = workerUploadProblem(manifest.worker.modules, "The release");
  const problems = [...checkSandboxBindings(manifest), ...(tooBig === null ? [] : [tooBig])];
  if (problems.length > 0) throw new ArtifactError(problems.join("; "));
  return manifest;
}
