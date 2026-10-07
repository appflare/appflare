import type { FetchLike } from "@appflare/cf-api";
import type { SigningKey } from "@appflare/schema";
import type { InstallerConfig } from "../config";
import { DEV_KEY_PREFIX } from "../config";
import { compareVersions } from "../versions";
import { fetchWhole, ReleaseError, ReleaseFetchError } from "./fetch";
import {
  deployProblem,
  MANAGER_APP,
  type VerifiedManifest,
  verifyReleaseManifest,
} from "./manifest";

/**
 * Where the release comes from: the newest Appflare release on GitHub, read
 * without GitHub's API (whose limit for requests without a token is shared
 * by every Worker on the same address). github.com's "latest release" page
 * redirects to the tag the release workflow marks as latest, and each asset
 * has a fixed download URL; the download redirects once to storage that
 * honours Range requests.
 */

export const RELEASE_REPOSITORY = "appflare/appflare";
export const RELEASE_TAG_PREFIX = "manager@";
/** Appflare's own releases are signed by keys with these ids, never a catalog key. */
export const RELEASE_KEY_PREFIX = "appflare-";

export interface ChosenRelease extends VerifiedManifest {
  version: string;
  zipUrl: string;
}

const LATEST_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/latest`;

function downloadUrl(tag: string, name: string): string {
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export function zipName(version: string): string {
  return `${MANAGER_APP}-${version}.zip`;
}

/** The tag github.com's latest-release redirect points at, or null. */
export function tagOfLatestRedirect(location: string | null): string | null {
  if (location === null) return null;
  let url: URL;
  try {
    url = new URL(location, "https://github.com/");
  } catch {
    return null;
  }
  const prefix = `/${RELEASE_REPOSITORY}/releases/tag/`;
  if (url.hostname !== "github.com" || !url.pathname.startsWith(prefix)) return null;
  const encoded = url.pathname.slice(prefix.length);
  if (encoded.length === 0 || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

async function latestTag(fetch: FetchLike): Promise<string> {
  let response: Response;
  try {
    response = await fetch(LATEST_URL, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "appflare-installer" },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "BudgetExceededError") throw error;
    throw new ReleaseFetchError("GitHub did not answer", true);
  }
  await response.body?.cancel();
  if (response.status === 429 || response.status >= 500) {
    throw new ReleaseFetchError(`GitHub answered ${response.status}`, true);
  }
  const tag = tagOfLatestRedirect(response.headers.get("location"));
  if (tag === null || !tag.startsWith(RELEASE_TAG_PREFIX)) {
    throw new ReleaseError("missing", "GitHub lists no Appflare release as the latest one");
  }
  return tag;
}

/**
 * The release to deploy, its signature, schema and deployability checked,
 * and at least `minManagerVersion`. Five subrequests from GitHub (the
 * latest-release redirect, then each file and its redirect), four from a
 * development release URL. Throws `ReleaseError` (not deployable) or
 * `ReleaseFetchError` (the host did not answer properly).
 */
export async function chooseRelease(
  fetch: FetchLike,
  config: InstallerConfig,
  keys: readonly SigningKey[],
): Promise<ChosenRelease> {
  let manifestUrl: string;
  let sigUrl: string;
  let expectedVersion: string | undefined;
  let verifyKeys: readonly SigningKey[];
  let prefix: string;
  const dev = config.devRelease;
  if (dev !== null) {
    manifestUrl = `${dev.url}/manifest.json`;
    sigUrl = `${dev.url}/manifest.sig`;
    verifyKeys = dev.keys;
    prefix = DEV_KEY_PREFIX;
  } else {
    const tag = await latestTag(fetch);
    expectedVersion = tag.slice(RELEASE_TAG_PREFIX.length);
    manifestUrl = downloadUrl(tag, "manifest.json");
    sigUrl = downloadUrl(tag, "manifest.sig");
    verifyKeys = keys.filter((k) => k.keyId.startsWith(RELEASE_KEY_PREFIX));
    prefix = RELEASE_KEY_PREFIX;
  }
  const manifestBytes = await fetchWhole(fetch, manifestUrl);
  const signature = new TextDecoder().decode(await fetchWhole(fetch, sigUrl));
  const verified = await verifyReleaseManifest(manifestBytes, signature, {
    keys: verifyKeys,
    keyIdPrefix: prefix,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  });
  const version = verified.manifest.version;
  const order = compareVersions(version, config.minManagerVersion);
  if (order === null || order < 0) {
    throw new ReleaseTooOldError(version, config.minManagerVersion);
  }
  const problem = deployProblem(verified.manifest);
  if (problem !== null) throw new ReleaseUnsupportedError(version, problem);
  const zipUrl =
    dev !== null
      ? `${dev.url}/${zipName(version)}`
      : downloadUrl(`${RELEASE_TAG_PREFIX}${version}`, zipName(version));
  return { ...verified, version, zipUrl };
}

/** The newest release is older than the installer deploys. */
export class ReleaseTooOldError extends ReleaseError {
  override name = "ReleaseTooOldError";
  constructor(
    readonly version: string,
    readonly minimum: string,
  ) {
    super("too-old", `release ${version} is older than ${minimum}`);
  }
}

/** The newest release needs something this installer does not do. */
export class ReleaseUnsupportedError extends ReleaseError {
  override name = "ReleaseUnsupportedError";
  constructor(
    readonly version: string,
    readonly problem: string,
  ) {
    super("unsupported", problem);
  }
}
