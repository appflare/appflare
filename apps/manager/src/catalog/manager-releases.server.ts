import type { FetchLike } from "@appflare/cf-api";
import { z } from "zod";
import { releaseTokenOptions, releaseTokenSecret } from "../github/release-access.server";
import { GITHUB_ACCESS_PLACE } from "../github/tokens";
import { runningVersion } from "../server/build-version";
import { cleanReleaseBody, pickReleaseNotes } from "../whats-new/release-notes";
import { storeReleaseNotes } from "../whats-new/release-notes.server";
import { type CacheValidator, validatorFor } from "./conditional-fetch";
import {
  type GithubRepository,
  latestReleaseTag,
  rateLimitMessage,
  rateLimitOf,
  releaseDownloadUrl,
  repositoryOfReleasesApi,
} from "./github-releases";
import { releaseAssetsSchema } from "./release-assets";
import { releaseFetch, releaseFetchAuthenticated } from "./release-fetch";
import { compareVersions, isUpdateAvailable, parseVersion } from "./versions";

/**
 * The manager's own release feed. Appflare releases are GitHub Releases on
 * appflare/appflare tagged `manager@<version>`, each with
 * `appflare-<version>.zip`, `manifest.json`, and `manifest.sig`. The cron
 * reads the releases list, picks the newest published (not draft, not
 * pre-release) manager release, and keeps it in KV under `manager:latest`
 * with the time of the check. Whether an update is available is computed at
 * read time against the running version (`runningVersion`). The same list also
 * gives "What's new" its release notes (whats-new/). Without a token the
 * newest release comes from github.com instead, and the list is read rarely
 * (see `refreshManagerReleases`).
 *
 * KV writes are scarce on the free plan (1,000 a day): one write per check,
 * so the half-hourly cron costs 48 a day, plus one when the manager
 * releases in the list or the notes change (not when only its ETag does:
 * GitHub's changes with every download count), one a day for the list's
 * freshness without a token, and one per rate-limit refusal.
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
  assets: releaseAssetsSchema,
  /** ISO 8601; null when GitHub did not say. */
  publishedAt: z.string().nullable(),
  /** ISO 8601 time of the check that found it. */
  checkedAt: z.string(),
});
export type ManagerRelease = z.infer<typeof managerReleaseSchema>;

export interface ManagerReleasesEnv {
  KV: KVNamespace;
  APPFLARE_VERSION: string;
  /**
   * Optional, when no GitHub access token is marked for release downloads:
   * the feed is then read through GitHub's API with the token's own rate
   * limit. Never logged.
   */
  GITHUB_TOKEN?: string;
  /** Releases API base override (local dev, tests). */
  MANAGER_RELEASES_URL?: string;
  /** Where the GitHub access token marked for release downloads is recorded. */
  DB?: D1Database;
  /** The sandbox Worker, which holds that token and makes the requests with it. */
  SANDBOX?: unknown;
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
    const assets = releaseAssetsSchema.safeParse({ zip, manifest, sig });
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

/**
 * The manager releases of the last list read, trimmed to what the update
 * check and "What's new" use (bodies cut as "What's new" cuts them), with
 * the list's ETag as KV metadata (see conditional-fetch.ts): the next read
 * sends it, and an unchanged list costs a `304` without a body. Rewritten
 * only when the trimmed releases changed; GitHub's ETag also changes with
 * every asset download, which would otherwise cost a write per read.
 */
export const MANAGER_RELEASES_KEY = "manager:releases";
/**
 * Present while GitHub's API refuses for its rate limit; expires when GitHub
 * said it may be asked again. Until then the list is not requested.
 */
export const MANAGER_FEED_LIMITED_KEY = "manager:feed-limited";
/**
 * Present for a day after the list was read without a token. Meanwhile the
 * newest release comes from github.com's latest-release redirect, and the
 * list (for release notes) is read again only for a release it lacks.
 */
export const MANAGER_RELEASES_FRESH_KEY = "manager:releases-fresh";
const RELEASES_CACHE_FORMAT = 1;
const LIST_FRESH_SECONDS = 24 * 60 * 60;

/** One entry of the list as cached: unknown fields are dropped. */
const cachedReleaseSchema = z.object({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  html_url: z.string().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().nullable().optional(),
  assets: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().optional(),
        browser_download_url: z.string().optional(),
      }),
    )
    .optional(),
});
type CachedRelease = z.infer<typeof cachedReleaseSchema>;

/** The manager releases of a releases list, with only the fields read from them. */
function trimReleases(list: readonly unknown[]): CachedRelease[] {
  return list.flatMap((item) => {
    const parsed = cachedReleaseSchema.safeParse(item);
    if (!parsed.success || !parsed.data.tag_name.startsWith(MANAGER_TAG_PREFIX)) return [];
    const { body, ...release } = parsed.data;
    return [body == null ? release : { ...release, body: cleanReleaseBody(body) }];
  });
}

interface CachedList {
  releases: CachedRelease[];
  etag: string | null;
  raw: { value: string | null; metadata: unknown };
}

/** The cached list read from `url`, or null when there is none for that URL. */
async function readCachedList(kv: KVNamespace, url: string): Promise<CachedList | null> {
  const raw = await kv.getWithMetadata(MANAGER_RELEASES_KEY);
  const meta = raw.metadata as Partial<CacheValidator> | null;
  if (raw.value === null || meta?.v !== RELEASES_CACHE_FORMAT || meta.url !== url) return null;
  try {
    const parsed = z.array(cachedReleaseSchema).safeParse(JSON.parse(raw.value));
    if (!parsed.success) return null;
    return {
      releases: parsed.data,
      etag: validatorFor(raw.metadata, url, RELEASES_CACHE_FORMAT),
      raw: { value: raw.value, metadata: raw.metadata },
    };
  } catch {
    return null;
  }
}

const feedLimitSchema = z.object({ until: z.number(), authenticated: z.boolean() });

/** Until when GitHub's API is refusing requests made like this one, or null. */
async function readFeedLimit(
  kv: KVNamespace,
  authenticated: boolean,
  now: number,
): Promise<number | null> {
  const text = await kv.get(MANAGER_FEED_LIMITED_KEY);
  if (text === null) return null;
  try {
    const parsed = feedLimitSchema.safeParse(JSON.parse(text));
    if (!parsed.success || parsed.data.authenticated !== authenticated) return null;
    return parsed.data.until > now ? parsed.data.until : null;
  } catch {
    return null;
  }
}

async function writeFeedLimit(
  kv: KVNamespace,
  until: number,
  authenticated: boolean,
  now: number,
): Promise<void> {
  // KV refuses an expiry less than 60 seconds away.
  const expirationTtl = Math.max(60, Math.ceil((until - now) / 1000));
  await kv.put(MANAGER_FEED_LIMITED_KEY, JSON.stringify({ until, authenticated }), {
    expirationTtl,
  });
}

interface ListRead {
  env: ManagerReleasesEnv;
  fetchImpl: FetchLike;
  url: URL;
  authenticated: boolean;
  cached: CachedList | null;
  now: number;
}

/**
 * The manager releases of GitHub's releases list: one conditional request,
 * cached in KV when the list changed. While GitHub's rate limit refuses, no
 * request is made. Throws `ManagerReleasesError`.
 */
async function readReleaseList(read: ListRead): Promise<CachedRelease[]> {
  const { env, url, authenticated, cached, now } = read;
  const where = `${url.host}${url.pathname}`;
  const limited = await readFeedLimit(env.KV, authenticated, now);
  if (limited !== null) {
    throw new ManagerReleasesError(rateLimitMessage(limited, now, authenticated));
  }
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (cached?.etag != null) headers["if-none-match"] = cached.etag;
  let response: Response;
  try {
    response = await read.fetchImpl(url.toString(), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new ManagerReleasesError(
      `Could not reach the release feed at ${where}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 304 && cached?.etag != null) {
    await response.body?.cancel();
    return cached.releases;
  }
  if (!response.ok) {
    const until = await rateLimitOf(response, now);
    if (until !== null) {
      await writeFeedLimit(env.KV, until, authenticated, now);
      throw new ManagerReleasesError(rateLimitMessage(until, now, authenticated));
    }
    const hint =
      response.status === 404 && !authenticated
        ? ` A private repository's feed needs a GitHub access token marked for release downloads (in ${GITHUB_ACCESS_PLACE}) or a GITHUB_TOKEN secret.`
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
  const releases = trimReleases(json);
  const text = JSON.stringify(releases);
  if (cached?.raw.value !== text) {
    const validator: CacheValidator = {
      v: RELEASES_CACHE_FORMAT,
      url: url.toString(),
      etag: response.headers.get("etag") ?? "",
    };
    await env.KV.put(MANAGER_RELEASES_KEY, text, { metadata: validator });
  }
  return releases;
}

/** The release `tag` (the repository's latest) with its assets at their public download URLs. */
function webRelease(
  repository: GithubRepository,
  tag: string,
): Omit<ManagerRelease, "checkedAt"> | null {
  const version = releaseVersionOf(tag);
  if (version === null) return null;
  const assets = releaseAssetsSchema.safeParse({
    zip: releaseDownloadUrl(repository, tag, `appflare-${version}.zip`),
    manifest: releaseDownloadUrl(repository, tag, "manifest.json"),
    sig: releaseDownloadUrl(repository, tag, "manifest.sig"),
  });
  if (!assets.success) return null;
  return { version, tag, assets: assets.data, publishedAt: null };
}

/**
 * Finds the newest manager release and stores it, with the release notes.
 * Throws `ManagerReleasesError` when nothing could be read.
 *
 * Without a token, GitHub's API allows 60 requests an hour per address,
 * shared by every Worker behind it (see github-releases.ts), so the newest
 * release comes from github.com's latest-release redirect (the release
 * workflow marks only the current manager version as latest), and the API's
 * list is read only for release notes: once a day, and for a release the
 * cached list lacks. With a token the list is read every time, with its
 * ETag. A rate-limit refusal is remembered until GitHub's reset; the update
 * check still works from the redirect meanwhile.
 *
 * When the redirect answers, its release IS the newest: a cached list may
 * still hold a release pulled since (deleted, or made a pre-release), which
 * must not be offered. The list then only dates the release and gives the
 * notes, none newer than it.
 */
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
  const clock = opts.now ?? (() => new Date());
  const now = clock().getTime();
  const inner: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const tokenOptions = releaseTokenOptions(env, await releaseTokenSecret(env));
  const authenticated = releaseFetchAuthenticated(tokenOptions);
  const userAgent = `Appflare/${runningVersion(env)}`;
  const fetchImpl = releaseFetch(inner, { ...tokenOptions, userAgent });

  // Without a token: the newest release from github.com, not the API.
  const repository = authenticated ? null : repositoryOfReleasesApi(base);
  const latestTag =
    repository === null ? null : await latestReleaseTag(inner, repository, userAgent);
  const fromWeb =
    repository === null || latestTag === null ? null : webRelease(repository, latestTag);

  const cached = await readCachedList(env.KV, url.toString());
  let releases = cached?.releases ?? null;
  const fresh = fromWeb !== null && (await env.KV.get(MANAGER_RELEASES_FRESH_KEY)) !== null;
  const listWanted =
    fromWeb === null || !fresh || !(releases ?? []).some((r) => r.tag_name === fromWeb.tag);
  if (listWanted) {
    try {
      releases = await readReleaseList({ env, fetchImpl, url, authenticated, cached, now });
      if (fromWeb !== null && !fresh) {
        await env.KV.put(MANAGER_RELEASES_FRESH_KEY, "1", { expirationTtl: LIST_FRESH_SECONDS });
      }
    } catch (error) {
      if (!(error instanceof ManagerReleasesError) || fromWeb === null) throw error;
      // The update check stands on the redirect; only the notes wait.
      console.warn("release notes not refreshed", { error: error.message });
    }
  }

  let picked: Omit<ManagerRelease, "checkedAt"> | null;
  if (fromWeb !== null) {
    const listed = releases?.find((r) => r.tag_name === fromWeb.tag && r.draft !== true);
    picked = { ...fromWeb, publishedAt: listed?.published_at ?? null };
  } else {
    picked =
      releases === null ? null : pickLatestManagerRelease(releases, { viaApi: authenticated });
  }
  let release: ManagerRelease | null = null;
  if (picked !== null) {
    release = { ...picked, checkedAt: new Date(now).toISOString() };
    await env.KV.put(MANAGER_LATEST_KEY, JSON.stringify(release));
  }
  // "What's new" reads the same list: written only when the notes changed. Its
  // failure is logged and never stops the update check or the rest of the cron.
  if (releases !== null) {
    try {
      const notes = pickReleaseNotes(releases).filter(
        (note) => fromWeb === null || (compareVersions(note.version, fromWeb.version) ?? 1) <= 0,
      );
      await storeReleaseNotes(env.KV, notes);
    } catch (error) {
      console.error("release notes not stored", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
  /** The running Appflare version (`runningVersion`). */
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
