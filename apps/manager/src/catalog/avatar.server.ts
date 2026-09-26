import type { FetchLike } from "@appflare/cf-api";
import {
  AVATAR_CONTENT_TYPES,
  avatarRedirectTarget,
  avatarUpstreamUrl,
  indexListsAuthor,
  isGithubLogin,
  MAX_AVATAR_BYTES,
} from "./avatar";
import { type CatalogEnv, readCachedCatalogIndex } from "./index.server";
import { readLimited } from "./read-limited";

/**
 * `GET /api/catalog/avatar/<handle>`: an app author's GitHub avatar (see
 * `avatar.ts`). Unlike catalog media there is no digest to check (avatars
 * change and the index pins none), so the rules are about where the bytes
 * come from and what they are: one fixed GitHub URL, whose single redirect is
 * followed only to `avatars.githubusercontent.com/u/<id>`, an image type
 * GitHub uses, at most 256 KiB. Cloudflare's cache keeps both responses for
 * a day by URL, and browsers keep the image for a day.
 */

/** How long the edge and browsers keep an avatar. */
export const AVATAR_CACHE_SECONDS = 60 * 60 * 24;

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "cache-control": "no-store" } });
}

export async function serveAuthorAvatar(
  env: CatalogEnv,
  handle: string,
  opts: { fetch?: FetchLike } = {},
): Promise<Response> {
  if (!isGithubLogin(handle)) return refuse(404, "Not found");
  const index = await readCachedCatalogIndex(env.KV);
  if (index === null || !indexListsAuthor(index, handle)) return refuse(404, "Not found");
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => fetch(input, init));
  const get = (url: string) =>
    fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      cf: { cacheTtl: AVATAR_CACHE_SECONDS, cacheEverything: true },
    });
  let response: Response;
  try {
    // GitHub redirects a profile's avatar to its numeric id; only that one hop is followed.
    const profile = await get(avatarUpstreamUrl(handle));
    await profile.body?.cancel();
    const target =
      profile.status === 302 ? avatarRedirectTarget(profile.headers.get("location")) : null;
    if (target === null) return refuse(502, `GitHub answered HTTP ${profile.status}.`);
    response = await get(target);
  } catch {
    return refuse(502, "GitHub could not be reached.");
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return refuse(502, `GitHub answered HTTP ${response.status}.`);
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!AVATAR_CONTENT_TYPES.has(contentType)) {
    await response.body?.cancel();
    return refuse(502, "GitHub did not answer with an image.");
  }
  if (Number(response.headers.get("content-length") ?? "0") > MAX_AVATAR_BYTES) {
    await response.body?.cancel();
    return refuse(502, "The avatar is larger than Appflare serves.");
  }
  const bytes = await readLimited(response.body, MAX_AVATAR_BYTES);
  if (bytes === null) return refuse(502, "The avatar is larger than Appflare serves.");
  return new Response(bytes, {
    headers: {
      "content-type": contentType,
      "cache-control": `private, max-age=${AVATAR_CACHE_SECONDS}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}

/** The avatar route: signed-in users only, like the pages that show avatars. */
export async function authorAvatarRoute(
  env: CatalogEnv,
  handle: string,
  signedIn: () => Promise<boolean>,
  opts: { fetch?: FetchLike } = {},
): Promise<Response> {
  if (!(await signedIn())) return refuse(401, "Sign in first.");
  return serveAuthorAvatar(env, handle, opts);
}
