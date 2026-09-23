import { type ArtifactFixture, MANIFEST_URL, SIG_URL, ZIP_URL } from "./artifact-fixture";

/**
 * Test-only stand-in for GitHub's releases API of a private appflare/appflare:
 * the releases list and the release-asset API answer only with the right
 * token; an asset request redirects (302) to a signed storage URL that
 * refuses any Authorization header, like GitHub's asset host. Asset bytes
 * come from an artifact fixture, Range requests included.
 */

export const RELEASES_URL = "https://api.github.com/repos/appflare/appflare/releases";
export const GITHUB_TOKEN = "gh-test-token-DO-NOT-LEAK";
const ASSET_API = "https://api.github.com/repos/appflare/appflare/releases/assets";
const STORAGE_HOST = "release-assets.test";

/** Fixture file behind each asset id. */
const ASSET_FILES: Record<string, string> = { "1": ZIP_URL, "2": MANIFEST_URL, "3": SIG_URL };

export interface GithubReleaseOptions {
  tag?: string;
  draft?: boolean;
  prerelease?: boolean;
  publishedAt?: string | null;
  /** Leave out assets by name. */
  without?: string[];
}

/** One entry of the releases list, shaped like GitHub's. */
export function githubRelease(version: string, opts: GithubReleaseOptions = {}) {
  const tag = opts.tag ?? `manager@${version}`;
  const download = `https://github.com/appflare/appflare/releases/download/${tag}`;
  const assets = [
    { id: 1, name: `appflare-${version}.zip` },
    { id: 2, name: "manifest.json" },
    { id: 3, name: "manifest.sig" },
  ]
    .filter((a) => !(opts.without ?? []).includes(a.name))
    .map((a) => ({
      ...a,
      url: `${ASSET_API}/${a.id}`,
      browser_download_url: `${download}/${a.name}`,
    }));
  return {
    tag_name: tag,
    name: tag,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    published_at: opts.publishedAt === undefined ? "2026-09-20T10:00:00Z" : opts.publishedAt,
    assets,
  };
}

export interface GithubRequest {
  url: string;
  authorized: boolean;
}

export function fakeGithub(fixture: ArtifactFixture | null, releases: unknown[]) {
  const requests: GithubRequest[] = [];
  const reply = (status: number, body: string) => new Response(body, { status });
  /** The response for `input`, or null when the URL is not GitHub's. */
  function serve(input: string, init?: RequestInit): Response | null {
    const url = new URL(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.hostname !== "api.github.com" && url.hostname !== STORAGE_HOST) return null;
    requests.push({ url: `${url.origin}${url.pathname}`, authorized: auth !== null });
    if (url.hostname === STORAGE_HOST) {
      if (auth !== null) return reply(400, "Only one auth mechanism allowed");
      const file = ASSET_FILES[url.pathname.slice(1)];
      return (file === undefined ? null : fixture?.serve(file, init)) ?? reply(404, "Not Found");
    }
    if (auth !== `Bearer ${GITHUB_TOKEN}`) return reply(404, '{"message":"Not Found"}');
    if (`${url.origin}${url.pathname}` === RELEASES_URL) return Response.json(releases);
    const asset = /^\/repos\/appflare\/appflare\/releases\/assets\/(\d+)$/.exec(url.pathname);
    if (asset?.[1] !== undefined) {
      if (new Headers(init?.headers).get("accept") !== "application/octet-stream") {
        return Response.json({ id: Number(asset[1]) });
      }
      return new Response(null, {
        status: 302,
        headers: { location: `https://${STORAGE_HOST}/${asset[1]}?X-Amz-Signature=test` },
      });
    }
    return reply(404, '{"message":"Not Found"}');
  }
  return { serve, requests };
}
