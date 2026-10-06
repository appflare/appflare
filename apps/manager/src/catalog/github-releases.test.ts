import { describe, expect, it } from "vitest";
import {
  latestReleaseTag,
  MIN_RATE_LIMIT_WAIT_MS,
  rateLimitedUntil,
  rateLimitMessage,
  rateLimitOf,
  releaseDownloadUrl,
  repositoryOfReleasesApi,
  tagOfReleaseLocation,
} from "./github-releases";

const APPFLARE = { owner: "appflare", repo: "appflare" };

describe("GitHub release URLs", () => {
  it("knows the repository of a GitHub releases API URL, and of nothing else", () => {
    expect(
      repositoryOfReleasesApi("https://api.github.com/repos/appflare/appflare/releases"),
    ).toEqual(APPFLARE);
    expect(repositoryOfReleasesApi("https://api.github.com/repos/a/b/releases/")).toEqual({
      owner: "a",
      repo: "b",
    });
    expect(repositoryOfReleasesApi("http://api.github.com/repos/a/b/releases")).toBeNull();
    expect(repositoryOfReleasesApi("https://api.github.com/repos/a/b/releases/tags/x")).toBeNull();
    expect(repositoryOfReleasesApi("http://127.0.0.1:8766/releases")).toBeNull();
    expect(
      repositoryOfReleasesApi("https://api.github.com.evil.test/repos/a/b/releases"),
    ).toBeNull();
    expect(repositoryOfReleasesApi("not a url")).toBeNull();
  });

  it("spells download URLs as GitHub's browser_download_url does", () => {
    expect(releaseDownloadUrl(APPFLARE, "manager@0.3.1", "appflare-0.3.1.zip")).toBe(
      "https://github.com/appflare/appflare/releases/download/manager%400.3.1/appflare-0.3.1.zip",
    );
  });

  it("reads the tag out of the latest-release redirect", () => {
    const at = (location: string | null) => tagOfReleaseLocation(APPFLARE, location);
    expect(at("https://github.com/appflare/appflare/releases/tag/manager@0.3.1")).toBe(
      "manager@0.3.1",
    );
    expect(at("https://github.com/appflare/appflare/releases/tag/manager%400.3.1")).toBe(
      "manager@0.3.1",
    );
    expect(at("/appflare/appflare/releases/tag/manager@0.3.1")).toBe("manager@0.3.1");
    expect(at("https://github.com/appflare/appflare/releases")).toBeNull();
    expect(at("https://github.com/someone/else/releases/tag/manager@9.0.0")).toBeNull();
    expect(at("https://evil.test/appflare/appflare/releases/tag/manager@9.0.0")).toBeNull();
    expect(at(null)).toBeNull();
  });

  it("asks github.com for the latest release without following the redirect", async () => {
    const seen: Array<{ url: string; redirect: string | undefined }> = [];
    const tag = await latestReleaseTag(
      async (input, init) => {
        seen.push({ url: input, redirect: init?.redirect });
        return new Response(null, {
          status: 302,
          headers: { location: "https://github.com/appflare/appflare/releases/tag/manager@0.3.1" },
        });
      },
      APPFLARE,
      "Appflare/test",
    );
    expect(tag).toBe("manager@0.3.1");
    expect(seen).toEqual([
      { url: "https://github.com/appflare/appflare/releases/latest", redirect: "manual" },
    ]);
    expect(await latestReleaseTag(async () => new Response("<html>"), APPFLARE, "UA")).toBeNull();
    expect(
      await latestReleaseTag(
        async () => {
          throw new Error("network down");
        },
        APPFLARE,
        "UA",
      ),
    ).toBeNull();
  });
});

describe("GitHub's rate limit", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const answer = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers });

  it("waits for x-ratelimit-reset when the hourly budget is spent", () => {
    const reset = Date.parse("2026-10-06T12:20:00Z") / 1000;
    const spent = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) };
    expect(rateLimitedUntil(answer(403, spent), now)).toBe(reset * 1000);
    expect(rateLimitedUntil(answer(429, spent), now)).toBe(reset * 1000);
    // A reset already past still waits a minute.
    const past = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 - 5) };
    expect(rateLimitedUntil(answer(403, past), now)).toBe(now + MIN_RATE_LIMIT_WAIT_MS);
  });

  it("waits for retry-after, and a minute for a bare 429", () => {
    expect(rateLimitedUntil(answer(403, { "retry-after": "120" }), now)).toBe(now + 120_000);
    expect(rateLimitedUntil(answer(429, { "retry-after": "5" }), now)).toBe(
      now + MIN_RATE_LIMIT_WAIT_MS,
    );
    expect(rateLimitedUntil(answer(429), now)).toBe(now + MIN_RATE_LIMIT_WAIT_MS);
  });

  it("does not take a plain 403 or another status for a rate limit", () => {
    expect(rateLimitedUntil(answer(403), now)).toBeNull();
    expect(rateLimitedUntil(answer(403, { "x-ratelimit-remaining": "12" }), now)).toBeNull();
    expect(rateLimitedUntil(answer(404, { "retry-after": "60" }), now)).toBeNull();
    expect(rateLimitedUntil(answer(200), now)).toBeNull();
  });

  it("takes a 403 whose body names a rate limit for one, reading the body only then", async () => {
    const secondary = () =>
      new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait." }),
        { status: 403 },
      );
    expect(rateLimitedUntil(secondary(), now)).toBeNull();
    expect(await rateLimitOf(secondary(), now)).toBe(now + MIN_RATE_LIMIT_WAIT_MS);
    expect(
      await rateLimitOf(
        new Response('{"message":"Resource not accessible"}', { status: 403 }),
        now,
      ),
    ).toBeNull();
    const reset = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 600) };
    const withHeaders = new Response("not read", { status: 403, headers: reset });
    expect(await rateLimitOf(withHeaders, now)).toBe(now + 600_000);
    expect(await rateLimitOf(answer(500), now)).toBeNull();
  });

  it("says plainly who is limited and when Appflare asks again", () => {
    const message = rateLimitMessage(Date.parse("2026-10-06T12:11:30Z"), now, false);
    expect(message).toMatch(/^GitHub is limiting requests from Cloudflare's network right now/);
    expect(message).toMatch(/60 requests an hour without a token/);
    expect(message).toMatch(/Appflare asks again after 12:11 UTC \(in about 12 minutes\)\.$/);
    expect(rateLimitMessage(now + 30_000, now, false)).toMatch(/in about 1 minute\)\.$/);
    const withToken = rateLimitMessage(now + 30_000, now, true, "retry");
    expect(withToken).toBe(
      "GitHub is limiting requests made with Appflare's GitHub token right now. Try again after 12:00 UTC (in about 1 minute).",
    );
  });
});
