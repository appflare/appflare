import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { artifactZipName } from "./artifact.ts";

/** Where manager releases are published (docs/RELEASING.md). */
export const RELEASE_REPO = "appflare/appflare";
/** Manager release tags are `manager@<version>`. */
export const RELEASE_TAG_PREFIX = "manager@";

const GITHUB_API = "https://api.github.com";

const assetSchema = z.looseObject({
  name: z.string(),
  /** API URL; with `Accept: application/octet-stream` it serves the bytes (also for private repos). */
  url: z.url(),
  size: z.int().min(0),
});
const releaseSchema = z.looseObject({
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(assetSchema),
});
export type ReleaseAsset = z.infer<typeof assetSchema>;
export type Release = z.infer<typeof releaseSchema>;

/** The three downloads of one manager release. */
export interface ManagerReleaseAssets {
  version: string;
  tag: string;
  zip: ReleaseAsset;
  manifest: ReleaseAsset;
  signature: ReleaseAsset;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The API URL that lists releases (`version` unset) or reads `manager@<version>`. */
export function releaseApiUrl(version?: string): string {
  const base = `${GITHUB_API}/repos/${RELEASE_REPO}/releases`;
  return version === undefined
    ? `${base}?per_page=100`
    : `${base}/tags/${encodeURIComponent(`${RELEASE_TAG_PREFIX}${version}`)}`;
}

/**
 * The newest published manager release in a releases listing (GitHub returns
 * newest first). Only `manager@` tags count, so releases of other packages in
 * the repository never shadow the manager; drafts and pre-releases are skipped.
 */
export function pickLatestManagerRelease(releases: Release[]): Release {
  const release = releases.find(
    (r) => r.tag_name.startsWith(RELEASE_TAG_PREFIX) && !r.draft && !r.prerelease,
  );
  if (!release) {
    throw new Error(`no published manager release (tag ${RELEASE_TAG_PREFIX}<version>) found`);
  }
  return release;
}

/** Picks `appflare-<version>.zip`, `manifest.json`, and `manifest.sig` from a manager release. */
export function selectReleaseAssets(release: Release): ManagerReleaseAssets {
  if (!release.tag_name.startsWith(RELEASE_TAG_PREFIX)) {
    throw new Error(`release ${release.tag_name} is not a manager release`);
  }
  const version = release.tag_name.slice(RELEASE_TAG_PREFIX.length);
  const find = (name: string): ReleaseAsset => {
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) {
      throw new Error(`release ${release.tag_name} has no ${name} asset`);
    }
    return asset;
  };
  return {
    version,
    tag: release.tag_name,
    zip: find(artifactZipName(version)),
    manifest: find("manifest.json"),
    signature: find("manifest.sig"),
  };
}

function githubHeaders(env: NodeJS.ProcessEnv, accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept,
    "user-agent": "create-appflare",
    "x-github-api-version": "2022-11-28",
  };
  // Optional, for private repositories and rate limits. Sent only to
  // api.github.com: fetch drops it on the cross-origin redirect to the asset host.
  const token = env.GITHUB_TOKEN?.trim();
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Finds the manager release to install: `manager@<version>`, or the newest published one. */
export async function findManagerRelease(
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  version?: string,
): Promise<ManagerReleaseAssets> {
  const url = releaseApiUrl(version);
  const response = await fetchFn(url, {
    headers: githubHeaders(env, "application/vnd.github+json"),
  });
  if (response.status === 404 && version !== undefined) {
    throw new Error(`there is no manager release ${RELEASE_TAG_PREFIX}${version}`);
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${url}`);
  }
  const body: unknown = await response.json();
  const release =
    version === undefined
      ? pickLatestManagerRelease(z.array(releaseSchema).parse(body))
      : releaseSchema.parse(body);
  return selectReleaseAssets(release);
}

/** Downloads one release asset to `dest`, checking the size GitHub reported. */
export async function downloadAsset(
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  asset: ReleaseAsset,
  dest: string,
): Promise<void> {
  const response = await fetchFn(asset.url, {
    headers: githubHeaders(env, "application/octet-stream"),
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`downloading ${asset.name} failed: HTTP ${response.status}`);
  }
  let size = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => {
    size += chunk.length;
  });
  await pipeline(body, createWriteStream(dest));
  if (size !== asset.size) {
    throw new Error(`downloaded ${asset.name} is ${size} bytes, expected ${asset.size}`);
  }
}

/** Downloads a manager release's three assets into `dir`. */
export async function downloadManagerRelease(
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  release: ManagerReleaseAssets,
  dir: string,
): Promise<void> {
  for (const asset of [release.manifest, release.signature, release.zip]) {
    await downloadAsset(fetchFn, env, asset, path.join(dir, asset.name));
  }
}
