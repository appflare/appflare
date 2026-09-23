import type { FetchLike } from "@appflare/cf-api";

/**
 * Fetching from the manager's release feed and its release assets.
 *
 * While the appflare/appflare repository is private, its releases are only
 * readable with a GitHub token, so the manager may carry an optional
 * `GITHUB_TOKEN` secret. The token is sent ONLY to `https://api.github.com`
 * and `https://github.com`; redirects are followed here, one hop at a time,
 * so it never reaches the host a release asset redirects to (GitHub's
 * signed asset URLs also refuse a second credential). Other request headers,
 * such as `Range`, are kept on every hop. The token is never logged.
 */

/** Hosts the GitHub token may be sent to. */
const TOKEN_HOSTS: ReadonlySet<string> = new Set(["api.github.com", "github.com"]);

/** Redirect hops followed before giving up. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Whether `GITHUB_TOKEN` may accompany a request to `url`. */
export function mayCarryGithubToken(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && TOKEN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

/** `https://api.github.com/repos/<owner>/<repo>/releases/assets/<id>`: answers JSON unless asked for the bytes. */
export function isGithubAssetApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "api.github.com" &&
      /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export interface ReleaseFetchOptions {
  /** `GITHUB_TOKEN`, when configured. */
  token?: string | undefined;
  /** GitHub's API refuses requests without a User-Agent. */
  userAgent: string;
}

/**
 * Wraps `inner` so every request follows redirects itself and carries the
 * token only where {@link mayCarryGithubToken} allows. Each hop is one call
 * of `inner`, so a counting fetch counts every hop.
 */
export function releaseFetch(inner: FetchLike, opts: ReleaseFetchOptions): FetchLike {
  const token = opts.token?.trim() || undefined;
  return async (input, init = {}) => {
    let url = input;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers = new Headers(init.headers);
      if (!headers.has("user-agent")) headers.set("user-agent", opts.userAgent);
      headers.delete("authorization");
      if (token !== undefined && mayCarryGithubToken(url)) {
        headers.set("authorization", `Bearer ${token}`);
      }
      if (isGithubAssetApiUrl(url)) headers.set("accept", "application/octet-stream");
      const response = await inner(url, { ...init, headers, redirect: "manual" });
      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
      await response.body?.cancel();
      url = new URL(location, url).toString();
    }
    throw new Error(`GET ${new URL(input).host}: more than ${MAX_REDIRECTS} redirects`);
  };
}
