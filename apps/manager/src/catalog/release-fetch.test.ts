import { describe, expect, it } from "vitest";
import {
  isAppflareRepositoryUrl,
  isGithubAssetApiUrl,
  mayCarryGithubToken,
  releaseFetch,
  releaseFetchAuthenticated,
} from "./release-fetch";

describe("releaseFetch", () => {
  it("sends the token only to api.github.com and github.com over https", () => {
    expect(mayCarryGithubToken("https://api.github.com/repos/appflare/appflare/releases")).toBe(
      true,
    );
    expect(mayCarryGithubToken("https://github.com/appflare/appflare/releases/download/x/y")).toBe(
      true,
    );
    expect(mayCarryGithubToken("http://api.github.com/repos")).toBe(false);
    expect(mayCarryGithubToken("https://release-assets.githubusercontent.com/x")).toBe(false);
    expect(mayCarryGithubToken("https://api.github.com.evil.test/x")).toBe(false);
    expect(mayCarryGithubToken("not a url")).toBe(false);
    expect(isGithubAssetApiUrl("https://api.github.com/repos/a/b/releases/assets/12")).toBe(true);
    expect(isGithubAssetApiUrl("https://api.github.com/repos/a/b/releases")).toBe(false);
  });

  it("follows redirects itself, keeping Range and dropping the token off GitHub", async () => {
    const seen: Array<{
      url: string;
      auth: string | null;
      range: string | null;
      accept: string | null;
    }> = [];
    const fetch = releaseFetch(
      async (input, init) => {
        const headers = new Headers(init?.headers);
        seen.push({
          url: input,
          auth: headers.get("authorization"),
          range: headers.get("range"),
          accept: headers.get("accept"),
        });
        expect(init?.redirect).toBe("manual");
        if (input.startsWith("https://api.github.com/")) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://release-assets.githubusercontent.com/blob?sig=1" },
          });
        }
        return new Response("abcd", { status: 206 });
      },
      { token: "gh-secret", userAgent: "Appflare/test" },
    );
    const res = await fetch("https://api.github.com/repos/a/b/releases/assets/7", {
      headers: { Range: "bytes=0-3" },
    });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("abcd");
    expect(seen).toEqual([
      {
        url: "https://api.github.com/repos/a/b/releases/assets/7",
        auth: "Bearer gh-secret",
        range: "bytes=0-3",
        accept: "application/octet-stream",
      },
      {
        url: "https://release-assets.githubusercontent.com/blob?sig=1",
        auth: null,
        range: "bytes=0-3",
        accept: null,
      },
    ]);
  });

  it("sends no token when none is configured, and gives up on redirect loops", async () => {
    const auths: Array<string | null> = [];
    const fetch = releaseFetch(
      async (input, init) => {
        auths.push(new Headers(init?.headers).get("authorization"));
        return new Response(null, { status: 302, headers: { location: input } });
      },
      { token: undefined, userAgent: "Appflare/test" },
    );
    await expect(fetch("https://github.com/a/b/releases/download/t/f")).rejects.toThrow(
      /redirects/,
    );
    expect(auths.every((a) => a === null)).toBe(true);
  });

  it("sends GitHub hops through the token holder, without a token of its own", async () => {
    const viaHolder: Array<{ url: string; auth: string | null; accept: string | null }> = [];
    const direct: Array<{ url: string; auth: string | null }> = [];
    const opts = {
      token: "env-token-not-used",
      github: async (input: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        viaHolder.push({
          url: input,
          auth: headers.get("authorization"),
          accept: headers.get("accept"),
        });
        return new Response(null, {
          status: 302,
          headers: { location: "https://release-assets.githubusercontent.com/blob?sig=1" },
        });
      },
      userAgent: "Appflare/test",
    };
    expect(releaseFetchAuthenticated(opts)).toBe(true);
    const fetch = releaseFetch(async (input, init) => {
      direct.push({ url: input, auth: new Headers(init?.headers).get("authorization") });
      return new Response("zip");
    }, opts);
    const response = await fetch(
      "https://api.github.com/repos/appflare/appflare/releases/assets/7",
    );
    expect(await response.text()).toBe("zip");
    expect(viaHolder).toEqual([
      {
        url: "https://api.github.com/repos/appflare/appflare/releases/assets/7",
        auth: null,
        accept: "application/octet-stream",
      },
    ]);
    expect(direct).toEqual([
      { url: "https://release-assets.githubusercontent.com/blob?sig=1", auth: null },
    ]);
    // Any other repository is read without a token at all.
    await fetch("https://api.github.com/repos/someone/else/releases");
    expect(viaHolder).toHaveLength(1);
    expect(direct.at(-1)).toEqual({
      url: "https://api.github.com/repos/someone/else/releases",
      auth: null,
    });
    expect(releaseFetchAuthenticated({ token: "  " })).toBe(false);
  });

  it("recognises Appflare's own repository only", () => {
    expect(isAppflareRepositoryUrl("https://api.github.com/repos/appflare/appflare/releases")).toBe(
      true,
    );
    expect(
      isAppflareRepositoryUrl("https://github.com/Appflare/Appflare/releases/download/t/f"),
    ).toBe(true);
    expect(
      isAppflareRepositoryUrl("https://api.github.com/repos/appflare/appflare-x/releases"),
    ).toBe(false);
    expect(isAppflareRepositoryUrl("https://api.github.com/repos/appflare/appflare")).toBe(false);
    expect(isAppflareRepositoryUrl("https://github.com/appflare/catalog/releases")).toBe(false);
    expect(isAppflareRepositoryUrl("https://evil.test/repos/appflare/appflare/x")).toBe(false);
    expect(
      isAppflareRepositoryUrl("https://api.github.com/repos/appflare/appflare/../../other/x"),
    ).toBe(false);
  });
});
