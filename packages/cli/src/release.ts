import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { artifactZipName, MANAGER_APP } from "./artifact.ts";

/** Where manager releases are published (docs/RELEASING.md). */
export const RELEASE_REPO = "appflare/appflare";
/** Manager release tags are `manager@<version>`. */
export const RELEASE_TAG_PREFIX = "manager@";

/**
 * One kind of release in RELEASE_REPO: its tag prefix, its zip's name, and
 * how messages call it. Every signed Worker release in the repository has the
 * same shape (`<prefix><version>` with the zip, `manifest.json`, and
 * `manifest.sig`); only these differ.
 */
export interface ReleaseChannel {
  tagPrefix: string;
  /** "manager": used in messages. */
  label: string;
  /** The artifact's `manifest.app`; its zip is `<app>-<version>.zip`. */
  app: string;
  /** What to do later when the newest release is still being published. */
  laterHint: string;
}

export const MANAGER_RELEASES: ReleaseChannel = {
  tagPrefix: RELEASE_TAG_PREFIX,
  label: "manager",
  app: MANAGER_APP,
  laterHint: "or update from the manager later",
};

const GITHUB_API = "https://api.github.com";

const assetSchema = z.looseObject({
  name: z.string(),
  /** API URL; with `Accept: application/octet-stream` it serves the bytes (also for private repos). */
  url: z.url(),
  size: z.int().min(0),
});
const releaseSchema = z.looseObject({
  id: z.int(),
  tag_name: z.string(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(assetSchema),
});
export type ReleaseAsset = z.infer<typeof assetSchema>;
export type Release = z.infer<typeof releaseSchema>;

/** The three downloads of one release. */
export interface ReleaseAssets {
  version: string;
  tag: string;
  zip: ReleaseAsset;
  manifest: ReleaseAsset;
  signature: ReleaseAsset;
}

/** The three downloads of one manager release. */
export type ManagerReleaseAssets = ReleaseAssets;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The API URL that lists releases (`version` unset) or reads `<prefix><version>`. */
export function releaseApiUrl(
  version?: string,
  channel: ReleaseChannel = MANAGER_RELEASES,
): string {
  const base = `${GITHUB_API}/repos/${RELEASE_REPO}/releases`;
  return version === undefined
    ? `${base}?per_page=100`
    : `${base}/tags/${encodeURIComponent(`${channel.tagPrefix}${version}`)}`;
}

/**
 * The newest published release of a channel in a releases listing (GitHub
 * returns newest first). Only the channel's tags count, so releases of other
 * packages in the repository never shadow it; drafts and pre-releases are
 * skipped.
 */
function isPublished(release: Release, channel: ReleaseChannel): boolean {
  return release.tag_name.startsWith(channel.tagPrefix) && !release.draft && !release.prerelease;
}

export function pickLatestRelease(releases: Release[], channel: ReleaseChannel): Release {
  const release = releases.find((r) => isPublished(r, channel));
  if (!release) {
    throw new Error(
      `no published ${channel.label} release (tag ${channel.tagPrefix}<version>) found`,
    );
  }
  return release;
}

export function pickLatestManagerRelease(releases: Release[]): Release {
  return pickLatestRelease(releases, MANAGER_RELEASES);
}

/** Picks `<app>-<version>.zip`, `manifest.json`, and `manifest.sig` from a release. */
export function selectReleaseAssets(
  release: Release,
  channel: ReleaseChannel = MANAGER_RELEASES,
): ReleaseAssets {
  if (!release.tag_name.startsWith(channel.tagPrefix)) {
    throw new Error(`release ${release.tag_name} is not a ${channel.label} release`);
  }
  const version = release.tag_name.slice(channel.tagPrefix.length);
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
    zip: find(artifactZipName(version, channel.app)),
    manifest: find("manifest.json"),
    signature: find("manifest.sig"),
  };
}

/**
 * Whether `url` may receive the GitHub token: only https://api.github.com. An
 * asset URL from a release listing is data from the network; a token must
 * never follow it anywhere else.
 */
export function mayReceiveToken(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "api.github.com" && u.port === "";
  } catch {
    return false;
  }
}

function githubHeaders(
  env: NodeJS.ProcessEnv,
  accept: string,
  url: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept,
    "user-agent": "create-appflare",
    "x-github-api-version": "2022-11-28",
  };
  // Optional, for private repositories and rate limits. Sent only to
  // api.github.com: fetch drops it on the cross-origin redirect to the asset host.
  const token = env.GITHUB_TOKEN?.trim();
  if (token && mayReceiveToken(url)) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Called with a message when the installer falls back to an older release. */
export type WarnFn = (message: string) => void;

/**
 * The error for a GitHub answer that may mean "no access": the repository can
 * be private, and GitHub answers 404 (not 403) to requests without access.
 */
export function githubAccessError(status: number, what: string, env: NodeJS.ProcessEnv): Error {
  return new Error(`GitHub answered ${status} for ${what}. ${accessHint(env)}`);
}

/** How to get access to a private release repository. */
export function accessHint(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_TOKEN?.trim()
    ? `GITHUB_TOKEN is set; check that it can read ${RELEASE_REPO} (a fine-grained token needs "Contents: read" on it).`
    : `The repository ${RELEASE_REPO} may be private. Pass a GitHub token that can read it in ` +
        "GITHUB_TOKEN, for example `GITHUB_TOKEN=$(gh auth token) npx create-appflare`.";
}

async function getJson(
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  url: string,
  what: string,
): Promise<unknown> {
  const response = await fetchFn(url, {
    headers: githubHeaders(env, "application/vnd.github+json", url),
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw githubAccessError(response.status, what, env);
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${what}`);
  }
  return response.json();
}

function isComplete(release: Release, channel: ReleaseChannel): boolean {
  try {
    selectReleaseAssets(release, channel);
    return true;
  } catch {
    return false;
  }
}

/**
 * The release with all three assets, or null. A release that was just
 * published can list no (or not all) assets for a few minutes; its assets are
 * then fetched by release id before giving up on it.
 */
async function withAssets(
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  release: Release,
  channel: ReleaseChannel,
): Promise<Release | null> {
  if (isComplete(release, channel)) {
    return release;
  }
  const url = `${GITHUB_API}/repos/${RELEASE_REPO}/releases/${release.id}/assets?per_page=100`;
  const assets = z
    .array(assetSchema)
    .parse(await getJson(fetchFn, env, url, `the assets of ${release.tag_name}`));
  const refreshed = { ...release, assets };
  return isComplete(refreshed, channel) ? refreshed : null;
}

/**
 * Finds the manager release to install: `manager@<version>`, or the newest
 * published one with all three assets. When the newest is still being
 * published (its assets are not all there yet), falls back to the previous
 * complete release and says so through `warn`.
 */
export function findManagerRelease(
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  version?: string,
  warn: WarnFn = () => {},
): Promise<ReleaseAssets> {
  return findRelease(MANAGER_RELEASES, fetchFn, env, version, warn);
}

/** {@link findManagerRelease} for any release channel. */
export async function findRelease(
  channel: ReleaseChannel,
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  version?: string,
  warn: WarnFn = () => {},
): Promise<ReleaseAssets> {
  if (version !== undefined) {
    const tag = `${channel.tagPrefix}${version}`;
    const url = releaseApiUrl(version, channel);
    const response = await fetchFn(url, {
      headers: githubHeaders(env, "application/vnd.github+json", url),
    });
    if (response.status === 404) {
      throw new Error(
        `There is no ${channel.label} release ${tag}, or it is not visible. ${accessHint(env)}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw githubAccessError(response.status, `release ${tag}`, env);
    }
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} for release ${tag}`);
    }
    const release = releaseSchema.parse(await response.json());
    const complete = await withAssets(fetchFn, env, release, channel);
    if (!complete) {
      // Throws naming the missing asset.
      selectReleaseAssets(release, channel);
      throw new Error(`release ${tag} is incomplete`);
    }
    return selectReleaseAssets(complete, channel);
  }

  const releases = z
    .array(releaseSchema)
    .parse(await getJson(fetchFn, env, releaseApiUrl(), `the releases of ${RELEASE_REPO}`));
  const newest = pickLatestRelease(releases, channel);
  const candidates = releases.filter((r) => isPublished(r, channel));
  for (const candidate of candidates) {
    const complete = await withAssets(fetchFn, env, candidate, channel);
    if (complete) {
      if (candidate !== newest) {
        warn(
          `${newest.tag_name} is still being published (its files are not all uploaded yet); ` +
            `installing ${candidate.tag_name} instead. Run again in a few minutes for ` +
            `${newest.tag_name}, ${channel.laterHint}.`,
        );
      }
      return selectReleaseAssets(complete, channel);
    }
  }
  throw new Error(
    `no ${channel.label} release has all its files yet (${newest.tag_name} is still being published); try again in a few minutes`,
  );
}

/** Downloads one release asset to `dest`, checking the size GitHub reported. */
export async function downloadAsset(
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  asset: ReleaseAsset,
  dest: string,
): Promise<void> {
  const response = await fetchFn(asset.url, {
    headers: githubHeaders(env, "application/octet-stream", asset.url),
    redirect: "follow",
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw githubAccessError(response.status, `the download of ${asset.name}`, env);
  }
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

/** Downloads a release's three assets into `dir`. */
export async function downloadRelease(
  fetchFn: FetchLike,
  env: NodeJS.ProcessEnv,
  release: ReleaseAssets,
  dir: string,
): Promise<void> {
  for (const asset of [release.manifest, release.signature, release.zip]) {
    await downloadAsset(fetchFn, env, asset, path.join(dir, asset.name));
  }
}

/** {@link downloadRelease}, by the name the installer has always used. */
export const downloadManagerRelease = downloadRelease;
