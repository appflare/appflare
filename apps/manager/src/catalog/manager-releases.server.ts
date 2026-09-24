import type { FetchLike } from "@appflare/cf-api";
import { indexArtifactsSchema } from "@appflare/schema";
import { z } from "zod";
import { pickReleaseNotes } from "../whats-new/release-notes";
import { storeReleaseNotes } from "../whats-new/release-notes.server";
import { releaseFetch } from "./release-fetch";
import { compareVersions, isUpdateAvailable, parseVersion } from "./versions";

/**
 * The manager's own release feed. Appflare releases are GitHub Releases on
 * appflare/appflare tagged `manager@<version>`, each with
 * `appflare-<version>.zip`, `manifest.json`, and `manifest.sig`. The cron
 * reads the releases list, picks the newest published (not draft, not
 * pre-release) manager release, and keeps it in KV under `manager:latest`
 * with the time of the check. Whether an update is available is computed at
 * read time against the running `APPFLARE_VERSION`. The same list also
 * gives "What's new" its release notes (whats-new/).
 *
 * KV writes are scarce on the free plan (1,000 a day): one write per check,
 * so the half-hourly cron costs 48 a day, plus one when the notes change.
 */

export const DEFAULT_MANAGER_RELEASES_URL =
  "https://api.github.com/repos/appflare/appflare/releases";
export const MANAGER_LATEST_KEY = "manager:latest";
export const MANAGER_TAG_PREFIX = "manager@";
/** `APPFLARE_VERSION` of a local build; older than every release. */
export const DEV_VERSION = "0.0.0-dev";

export const managerReleaseSchema = z.object({
  version: z.string().min(1),
  tag: z.string().min(1),
  assets: indexArtifactsSchema,
  /** ISO 8601; null when GitHub did not say. */
  publishedAt: z.string().nullable(),
  /** ISO 8601 time of the check that found it. */
  checkedAt: z.string(),
});
export type ManagerRelease = z.infer<typeof managerReleaseSchema>;

export interface ManagerReleasesEnv {
  KV: KVNamespace;
  APPFLARE_VERSION: string;
  /** Needed only while the repository is private. Never logged. */
  GITHUB_TOKEN?: string;
  /** Releases API base override (local dev, tests). */
  MANAGER_RELEASES_URL?: string;
}

export interface ManagerReleasesOptions {
  fetch?: FetchLike;
  now?: () => Date;
}

/** Why the feed could not be read; the message is safe to show. */
export class ManagerReleasesError extends Error {
  override name = "ManagerReleasesError";
}

export function managerReleasesUrl(env: Pick<ManagerReleasesEnv, "MANAGER_RELEASES_URL">): string {
  const configured = env.MANAGER_RELEASES_URL?.trim();
  return configured ? configured : DEFAULT_MANAGER_RELEASES_URL;
}

/** Semver without a leading `v`, as release tags carry it. */
function releaseVersionOf(tag: string): string | null {
  if (!tag.startsWith(MANAGER_TAG_PREFIX)) return null;
  const version = tag.slice(MANAGER_TAG_PREFIX.length);
  return /^\d/.test(version) && parseVersion(version) !== null ? version : null;
}

const githubAssetSchema = z.looseObject({
  name: z.string(),
  /** The API URL (`/repos/<o>/<r>/releases/assets/<id>`), readable with a token. */
  url: z.string().optional(),
  browser_download_url: z.string().optional(),
});

const githubReleaseSchema = z.looseObject({
  tag_name: z.string(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullable().optional(),
  assets: z.array(githubAssetSchema).optional(),
});

function isApiAssetUrl(url: string | undefined): url is string {
  return url?.startsWith("https://api.github.com/") === true;
}

/**
 * The newest manager release in a GitHub releases list, or null. Drafts,
 * pre-releases, other tags, and releases missing one of the three assets are
 * skipped. With `viaApi` (a token is configured, so the repository may be
 * private) assets are addressed by their API URL, which a token can read;
 * otherwise by their public download URL.
 */
export function pickLatestManagerRelease(
  releases: unknown,
  opts: { viaApi: boolean },
): Omit<ManagerRelease, "checkedAt"> | null {
  if (!Array.isArray(releases)) return null;
  let best: Omit<ManagerRelease, "checkedAt"> | null = null;
  for (const item of releases) {
    const parsed = githubReleaseSchema.safeParse(item);
    if (!parsed.success) continue;
    const release = parsed.data;
    if (release.draft === true || release.prerelease === true) continue;
    const version = releaseVersionOf(release.tag_name);
    if (version === null) continue;
    const urlOf = (name: string): string | null => {
      const asset = release.assets?.find((a) => a.name === name);
      if (asset === undefined) return null;
      if (opts.viaApi && isApiAssetUrl(asset.url)) return asset.url;
      return asset.browser_download_url ?? null;
    };
    const zip = urlOf(`appflare-${version}.zip`);
    const manifest = urlOf("manifest.json");
    const sig = urlOf("manifest.sig");
    if (zip === null || manifest === null || sig === null) continue;
    const assets = indexArtifactsSchema.safeParse({ zip, manifest, sig });
    if (!assets.success) continue;
    if (best !== null && (compareVersions(version, best.version) ?? 0) <= 0) continue;
    best = {
      version,
      tag: release.tag_name,
      assets: assets.data,
      publishedAt: release.published_at ?? null,
    };
  }
  return best;
}

/**
 * Whether `latest` is newer than the running version. A local build
 * (`0.0.0-dev`) is older than every release.
 */
export function isManagerUpdateAvailable(
  current: string,
  latest: string | null | undefined,
): boolean {
  if (latest == null || latest === current) return false;
  if (current === DEV_VERSION) return true;
  return isUpdateAvailable(current, latest);
}

/** Reads the releases list and stores the newest manager release. Throws `ManagerReleasesError`. */
export async function refreshManagerReleases(
  env: ManagerReleasesEnv,
  opts: ManagerReleasesOptions = {},
): Promise<ManagerRelease | null> {
  const base = managerReleasesUrl(env);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ManagerReleasesError(`MANAGER_RELEASES_URL is not a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ManagerReleasesError(`MANAGER_RELEASES_URL must be an http(s) URL.`);
  }
  url.searchParams.set("per_page", "100");
  const token = env.GITHUB_TOKEN?.trim() || undefined;
  const fetchImpl = releaseFetch(opts.fetch ?? ((input, init) => fetch(input, init)), {
    token,
    userAgent: `Appflare/${env.APPFLARE_VERSION}`,
  });
  const where = `${url.host}${url.pathname}`;
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ManagerReleasesError(
      `Could not reach the release feed at ${where}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    const hint =
      response.status === 404 && token === undefined
        ? " While the repository is private, the feed needs a GITHUB_TOKEN secret."
        : "";
    throw new ManagerReleasesError(
      `The release feed at ${where} answered HTTP ${response.status}.${hint}`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ManagerReleasesError(`The release feed at ${where} did not return JSON.`);
  }
  if (!Array.isArray(json)) {
    throw new ManagerReleasesError(`The release feed at ${where} did not return a list.`);
  }
  const picked = pickLatestManagerRelease(json, { viaApi: token !== undefined });
  let release: ManagerRelease | null = null;
  if (picked !== null) {
    release = { ...picked, checkedAt: (opts.now ?? (() => new Date()))().toISOString() };
    await env.KV.put(MANAGER_LATEST_KEY, JSON.stringify(release));
  }
  // "What's new" reads the same list: written only when the notes changed. Its
  // failure is logged and never stops the update check or the rest of the cron.
  try {
    await storeReleaseNotes(env.KV, pickReleaseNotes(json));
  } catch (error) {
    console.error("release notes not stored", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return release;
}

/** The stored newest release, or null when none was found yet (or the entry is unreadable). */
export async function readManagerLatest(
  kv: KVNamespace | undefined,
): Promise<ManagerRelease | null> {
  const text = await kv?.get(MANAGER_LATEST_KEY);
  if (text == null) return null;
  try {
    const parsed = managerReleaseSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface ManagerUpdateView {
  /** The running `APPFLARE_VERSION`. */
  current: string;
  latest: { version: string; tag: string; publishedAt: string | null } | null;
  updateAvailable: boolean;
  /** ISO 8601 time of the last check that found a release; null when none did yet. */
  checkedAt: string | null;
}

export function managerUpdateView(
  current: string,
  latest: ManagerRelease | null,
): ManagerUpdateView {
  return {
    current,
    latest:
      latest === null
        ? null
        : { version: latest.version, tag: latest.tag, publishedAt: latest.publishedAt },
    updateAvailable: isManagerUpdateAvailable(current, latest?.version),
    checkedAt: latest?.checkedAt ?? null,
  };
}
