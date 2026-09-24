import type { FetchLike } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { fakeKv } from "../test/fake-kv";
import {
  avatarRedirectTarget,
  avatarSrc,
  avatarUpstreamUrl,
  isGithubLogin,
  MAX_AVATAR_BYTES,
} from "./avatar";
import { authorAvatarRoute, serveAuthorAvatar } from "./avatar.server";
import { CATALOG_INDEX_KEY } from "./index.server";

const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const RELEASE = "https://example.test/releases/download/cut@1.0.0";
const AVATAR = "https://avatars.githubusercontent.com/u/42?s=64&v=4";

function index(authors: unknown) {
  return {
    generatedAt: "2026-09-24T12:00:00.000Z",
    apps: [
      {
        slug: "cut",
        name: "Cut",
        summary: "Links.",
        version: "1.0.0",
        artifacts: {
          zip: `${RELEASE}/cut-1.0.0.zip`,
          manifest: `${RELEASE}/manifest.json`,
          sig: `${RELEASE}/manifest.sig`,
        },
        digest: "a".repeat(64),
        tier: "artifact",
        plan: "free",
        requires: [],
        lastVerified: null,
        authors,
        maintainers: ["Packager"],
      },
    ],
  };
}

const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });
const png = () => new Response(PNG, { headers: { "content-type": "image/png" } });

/** GitHub as the manager sees it: the profile URL redirects, the avatar URL answers `image`. */
function setup(image: () => Response, profile: () => Response = () => redirectTo(AVATAR)) {
  const { kv, store } = fakeKv();
  store.set(
    CATALOG_INDEX_KEY,
    JSON.stringify(index([{ name: "Mendy Landa", github: "MendyLanda" }])),
  );
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return url.startsWith("https://github.com/") ? profile() : image();
  };
  return { env: { KV: kv }, fetch, calls };
}

describe("avatar rules", () => {
  it("accepts GitHub logins only", () => {
    expect(isGithubLogin("MendyLanda")).toBe(true);
    expect(isGithubLogin("every-app")).toBe(true);
    expect(isGithubLogin("a-")).toBe(false);
    expect(isGithubLogin("a--b")).toBe(false);
    expect(isGithubLogin("../x")).toBe(false);
    expect(isGithubLogin("a".repeat(40))).toBe(false);
  });

  it("gives the page a manager path and starts from one fixed URL", () => {
    expect(avatarSrc("MendyLanda")).toBe("/api/catalog/avatar/MendyLanda");
    expect(avatarSrc(undefined)).toBeNull();
    expect(avatarSrc("not a login")).toBeNull();
    expect(avatarUpstreamUrl("MendyLanda")).toBe("https://github.com/MendyLanda.png?size=64");
  });

  it("follows GitHub's redirect only to an avatar by numeric id", () => {
    expect(avatarRedirectTarget(AVATAR)).toBe(AVATAR);
    expect(avatarRedirectTarget("https://avatars.githubusercontent.com/cloudflare")).toBeNull();
    expect(avatarRedirectTarget("http://avatars.githubusercontent.com/u/1")).toBeNull();
    expect(avatarRedirectTarget("https://avatars.githubusercontent.com.evil.test/u/1")).toBeNull();
    expect(avatarRedirectTarget("/u/1")).toBeNull();
    expect(avatarRedirectTarget(null)).toBeNull();
  });
});

describe("serveAuthorAvatar", () => {
  it("serves a listed author's avatar through the one redirect, cached a day by URL", async () => {
    const { env, fetch, calls } = setup(png);
    const response = await serveAuthorAvatar(env, "mendylanda", { fetch });
    expect(response.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual(["https://github.com/mendylanda.png?size=64", AVATAR]);
    for (const call of calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(call.init?.cf).toMatchObject({ cacheTtl: 86400 });
    }
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("never fetches for a handle the index does not list as an author", async () => {
    const { env, fetch, calls } = setup(png);
    expect((await serveAuthorAvatar(env, "Packager", { fetch })).status).toBe(404);
    expect((await serveAuthorAvatar(env, "someone-else", { fetch })).status).toBe(404);
    expect((await serveAuthorAvatar(env, "../etc", { fetch })).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("refuses a redirect anywhere else, or none", async () => {
    const elsewhere = setup(png, () => redirectTo("https://tracker.test/u/1"));
    expect((await serveAuthorAvatar(elsewhere.env, "MendyLanda", elsewhere)).status).toBe(502);
    expect(elsewhere.calls).toHaveLength(1);
    const missing = setup(png, () => new Response("Not Found", { status: 404 }));
    expect((await serveAuthorAvatar(missing.env, "MendyLanda", missing)).status).toBe(502);
    const again = setup(() => redirectTo(AVATAR));
    expect((await serveAuthorAvatar(again.env, "MendyLanda", again)).status).toBe(502);
    expect(again.calls).toHaveLength(2);
  });

  it("refuses non-images and oversized bodies", async () => {
    const svg = setup(
      () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
    );
    expect((await serveAuthorAvatar(svg.env, "MendyLanda", svg)).status).toBe(502);
    const big = setup(
      () =>
        new Response(new Uint8Array(MAX_AVATAR_BYTES + 1), {
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const response = await serveAuthorAvatar(big.env, "MendyLanda", big);
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 401 without a session and never fetches", async () => {
    const { env, fetch, calls } = setup(png);
    const refused = await authorAvatarRoute(env, "MendyLanda", async () => false, { fetch });
    expect(refused.status).toBe(401);
    expect(calls).toEqual([]);
    const served = await authorAvatarRoute(env, "MendyLanda", async () => true, { fetch });
    expect(served.status).toBe(200);
  });
});
