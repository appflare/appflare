import type { FetchLike } from "@appflare/cf-api";

/**
 * GitHub release reads that avoid GitHub's REST API, and what to do when the
 * API refuses for its rate limit. Client-safe (no bindings).
 *
 * Without a token, `api.github.com` allows 60 requests an hour per IP
 * address, and a Worker's outbound addresses are shared with every other
 * Worker in the location, so the budget is usually spent by someone else:
 * a manager making two requests an hour saw most of its checks refused with
 * HTTP 403. `github.com` itself is not metered that way: its "latest release"
 * page redirects to the release's tag, and a release asset has a fixed
 * download URL, `github.com/<owner>/<repo>/releases/download/<tag>/<name>`.
 * So a release's existence and its assets need no API call; only data the
 * web pages do not carry in a usable form (release notes in Markdown, draft
 * and pre-release flags of older releases) does.
 */

/** A repository on GitHub. */
export interface GithubRepository {
  owner: string;
  repo: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The repository of a releases API URL (`https://api.github.com/repos/<owner>/<repo>/releases`),
 * or null for any other URL (a local stand-in, a test server), whose web pages are unknown.
 */
export function repositoryOfReleasesApi(apiUrl: string): GithubRepository | null {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "api.github.com" || url.port !== "") {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  const match = /^\/repos\/([^/]+)\/([^/]+)\/releases\/?$/.exec(url.pathname);
  const owner = match?.[1];
  const repo = match?.[2];
  if (owner === undefined || repo === undefined || !NAME.test(owner) || !NAME.test(repo)) {
    return null;
  }
  return { owner, repo };
}

/** The public download URL of a release asset, as GitHub's `browser_download_url` spells it. */
export function releaseDownloadUrl(
  repository: GithubRepository,
  tag: string,
  name: string,
): string {
  return `https://github.com/${repository.owner}/${repository.repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** The page that redirects to the repository's latest release. */
export function latestReleaseUrl(repository: GithubRepository): string {
  return `https://github.com/${repository.owner}/${repository.repo}/releases/latest`;
}

/** The tag a `/releases/latest` redirect points at, or null when `location` is not a release tag of `repository`. */
export function tagOfReleaseLocation(
  repository: GithubRepository,
  location: string | null,
): string | null {
  if (location === null) return null;
  let url: URL;
  try {
    url = new URL(location, "https://github.com/");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
  const prefix = `/${repository.owner}/${repository.repo}/releases/tag/`.toLowerCase();
  if (!url.pathname.toLowerCase().startsWith(prefix)) return null;
  const encoded = url.pathname.slice(prefix.length);
  if (encoded === "" || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/**
 * The tag of the repository's latest release, from `github.com`'s redirect
 * (one request, no API rate limit, no body read). Null when GitHub did not
 * redirect to a release tag: no release yet, an outage, a network error.
 * Never throws. `inner` must not follow redirects itself.
 */
export async function latestReleaseTag(
  inner: FetchLike,
  repository: GithubRepository,
  userAgent: string,
): Promise<string | null> {
  let response: Response;
  try {
    response = await inner(latestReleaseUrl(repository), {
      headers: { "user-agent": userAgent },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return null;
  }
  await response.body?.cancel();
  if (response.status < 300 || response.status >= 400) return null;
  return tagOfReleaseLocation(repository, response.headers.get("location"));
}

/** Shortest wait after a refusal that names no time, as GitHub asks ("at least one minute"). */
export const MIN_RATE_LIMIT_WAIT_MS = 60_000;

/**
 * When GitHub's API may be asked again, if `response` is a rate-limit
 * refusal; else null. GitHub answers 403 or 429 and says when: `retry-after`
 * (seconds) for a secondary limit, or `x-ratelimit-remaining: 0` with
 * `x-ratelimit-reset` (epoch seconds) for the hourly one. A 429 without
 * either, or a 403 whose `body` names a rate limit (a secondary limit may
 * come without either header), waits a minute. Any other 403 is not a rate
 * limit (the resource is forbidden), and is left to the caller.
 */
export function rateLimitedUntil(response: Response, now: number, body = ""): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return now + Math.max(retryAfter * 1000, MIN_RATE_LIMIT_WAIT_MS);
  }
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) {
    return Math.max(reset * 1000, now + MIN_RATE_LIMIT_WAIT_MS);
  }
  if (response.status === 429 || /rate limit/i.test(body)) return now + MIN_RATE_LIMIT_WAIT_MS;
  return null;
}

/** GitHub's error bodies are a line of JSON; more than this is not read. */
const MAX_ERROR_BODY_CHARS = 4096;

/**
 * {@link rateLimitedUntil} for a refused `response`, reading the start of a
 * 403's body when its headers do not tell. Always consumes or cancels the
 * body.
 */
export async function rateLimitOf(response: Response, now: number): Promise<number | null> {
  const fromHeaders = rateLimitedUntil(response, now);
  if (fromHeaders !== null || response.status !== 403 || response.body === null) {
    await response.body?.cancel();
    return fromHeaders;
  }
  let body = "";
  try {
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    while (body.length < MAX_ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      body += value;
    }
    await reader.cancel();
  } catch {
    // An unreadable body tells nothing more.
  }
  return rateLimitedUntil(response, now, body.slice(0, MAX_ERROR_BODY_CHARS));
}

/** "01:23 UTC (in about 12 minutes)". */
export function retryTime(until: number, now: number): string {
  const at = new Date(until).toISOString().slice(11, 16);
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return `${at} UTC (in about ${minutes} minute${minutes === 1 ? "" : "s"})`;
}

/**
 * What a person reads when GitHub's API is refusing for its rate limit.
 * `authenticated`: the request carried a GitHub token, whose own limit was
 * reached; else the limit for requests without one, shared by every Worker
 * behind the same address. `next`: whether Appflare asks again by itself
 * (the release check) or the person has to (a job that gave up).
 */
export function rateLimitMessage(
  until: number,
  now: number,
  authenticated: boolean,
  next: "check" | "retry" = "check",
): string {
  const why = authenticated
    ? "GitHub is limiting requests made with Appflare's GitHub token right now."
    : "GitHub is limiting requests from Cloudflare's network right now (Workers share their addresses, and GitHub allows each address 60 requests an hour without a token).";
  const then = next === "check" ? "Appflare asks again after" : "Try again after";
  return `${why} ${then} ${retryTime(until, now)}.`;
}
