import type { FetchLike } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import sandboxPackage from "../../../sandbox/package.json";
import { ArtifactError } from "../jobs/install/artifact";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { sandboxRelease } from "../test/fake-sandbox-account";
import {
  findSandboxRelease,
  PINNED_SANDBOX_VERSION,
  sandboxReleaseAssets,
  sandboxReleaseProblem,
  sandboxReleaseUrl,
  sandboxUpdateAvailable,
  verifySandboxManifest,
} from "./release";

describe("the pinned sandbox Worker release", () => {
  it("is the sandbox Worker version of this commit", () => {
    expect(PINNED_SANDBOX_VERSION).toBe(sandboxPackage.version);
  });

  it("offers an update only when the deployed sandbox Worker is older", () => {
    expect(sandboxUpdateAvailable("0.1.1", "0.1.2")).toBe(true);
    expect(sandboxUpdateAvailable("0.1.2", "0.1.2")).toBe(false);
    expect(sandboxUpdateAvailable("0.2.0", "0.1.2")).toBe(false);
    expect(sandboxUpdateAvailable(null, "0.1.2")).toBe(false);
    expect(sandboxUpdateAvailable("not-semver", "0.1.2")).toBe(false);
  });

  it("is looked up by its tag next to the manager's own release feed", () => {
    expect(sandboxReleaseUrl({}, "0.1.2")).toBe(
      "https://api.github.com/repos/appflare/appflare/releases/tags/sandbox%400.1.2",
    );
    expect(sandboxReleaseUrl({ MANAGER_RELEASES_URL: "http://localhost:9/r" }, "1.0.0")).toBe(
      "http://localhost:9/r/tags/sandbox%401.0.0",
    );
  });
});

describe("sandboxReleaseAssets", () => {
  const release = {
    tag_name: "sandbox@0.1.2",
    draft: false,
    assets: ["appflare-sandbox-0.1.2.zip", "manifest.json", "manifest.sig"].map((name, i) => ({
      name,
      url: `https://api.github.com/repos/appflare/appflare/releases/assets/${i + 1}`,
      browser_download_url: `https://github.com/appflare/appflare/releases/download/sandbox@0.1.2/${name}`,
    })),
  };

  it("uses the API asset URLs with a GitHub token and the public ones without", () => {
    expect(sandboxReleaseAssets(release, "0.1.2", { viaApi: true }).zip).toBe(
      "https://api.github.com/repos/appflare/appflare/releases/assets/1",
    );
    expect(sandboxReleaseAssets(release, "0.1.2", { viaApi: false }).sig).toMatch(
      /download\/sandbox@0\.1\.2\/manifest\.sig$/,
    );
  });

  it("refuses another tag, a draft, and a release without its zip", () => {
    expect(() => sandboxReleaseAssets(release, "0.1.3", { viaApi: true })).toThrow(/sandbox@0.1.3/);
    expect(() =>
      sandboxReleaseAssets({ ...release, draft: true }, "0.1.2", { viaApi: true }),
    ).toThrow(/not published/);
    expect(() =>
      sandboxReleaseAssets({ ...release, assets: release.assets.slice(1) }, "0.1.2", {
        viaApi: true,
      }),
    ).toThrow(/has no appflare-sandbox-0.1.2.zip/);
  });
});

describe("finding the sandbox Worker release", () => {
  const DOWNLOAD = "https://github.com/appflare/appflare/releases/download/sandbox%400.1.2";
  /** Answers every request with `response`, recording the URLs and Range headers asked for. */
  function github(response: () => Response) {
    const seen: Array<{ url: string; range: string | null }> = [];
    const fetch: FetchLike = async (input, init) => {
      seen.push({ url: input, range: new Headers(init?.headers).get("range") });
      return response();
    };
    return { fetch, seen };
  }
  const limited = () =>
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800" },
    });

  it("without a token, uses the download URLs and asks only for the manifest's first byte", async () => {
    const gh = github(() => new Response("{", { status: 206 }));
    const assets = await findSandboxRelease(gh.fetch, {}, "0.1.2", { viaApi: false });
    expect(assets).toEqual({
      zip: `${DOWNLOAD}/appflare-sandbox-0.1.2.zip`,
      manifest: `${DOWNLOAD}/manifest.json`,
      sig: `${DOWNLOAD}/manifest.sig`,
    });
    expect(gh.seen).toEqual([{ url: `${DOWNLOAD}/manifest.json`, range: "bytes=0-0" }]);
    expect(await sandboxReleaseProblem(gh.fetch, {}, "0.1.2", { viaApi: false })).toBeNull();
    expect(gh.seen.every((s) => !s.url.startsWith("https://api.github.com/"))).toBe(true);
  });

  it("without a token, a missing release is final and anything else is retried", async () => {
    const missing = github(() => new Response("Not Found", { status: 404 }));
    const error = await findSandboxRelease(missing.fetch, {}, "0.1.2", { viaApi: false }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ArtifactError);
    expect((error as Error).message).toBe(
      "GitHub has no sandbox Worker release sandbox@0.1.2 (HTTP 404).",
    );
    expect(await sandboxReleaseProblem(missing.fetch, {}, "0.1.2", { viaApi: false })).toBe(
      "GitHub has no sandbox Worker release sandbox@0.1.2.",
    );
    const outage = github(() => new Response(null, { status: 503 }));
    const retried = await findSandboxRelease(outage.fetch, {}, "0.1.2", { viaApi: false }).catch(
      (e: unknown) => e,
    );
    expect(retried).toBeInstanceOf(Error);
    expect(retried).not.toBeInstanceOf(ArtifactError);
    expect(await sandboxReleaseProblem(outage.fetch, {}, "0.1.2", { viaApi: false })).toBeNull();
  });

  it("with a token, a rate-limit refusal from the API is retried and says so", async () => {
    const gh = github(limited);
    const error = await findSandboxRelease(gh.fetch, {}, "0.1.2", { viaApi: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ArtifactError);
    expect((error as Error).message).toMatch(/^GitHub is limiting requests/);
    expect(gh.seen.map((s) => s.url)).toEqual([sandboxReleaseUrl({}, "0.1.2")]);
    expect(await sandboxReleaseProblem(gh.fetch, {}, "0.1.2", { viaApi: true })).toBeNull();
  });

  it("asks the API for a feed that is not GitHub's, token or not", async () => {
    const env = { MANAGER_RELEASES_URL: "http://localhost:9/r" };
    const gh = github(() => Response.json({ message: "Not Found" }, { status: 404 }));
    await expect(findSandboxRelease(gh.fetch, env, "0.1.2", { viaApi: false })).rejects.toThrow(
      "GitHub has no sandbox Worker release sandbox@0.1.2 (HTTP 404).",
    );
    expect(gh.seen.map((s) => s.url)).toEqual(["http://localhost:9/r/tags/sandbox%400.1.2"]);
  });
});

describe("verifySandboxManifest", () => {
  it("accepts a signed sandbox Worker release of the requested version", async () => {
    const r = await sandboxRelease("0.1.2");
    const manifest = await verifySandboxManifest(r.manifestBytes, r.signature, "0.1.2", r.keys);
    expect(manifest.app).toBe("appflare-sandbox");
  });

  it("refuses a catalog key, another app, another version, and unknown bindings", async () => {
    const catalog = await sandboxRelease("0.1.2", { keyId: "catalog-test" });
    await expect(
      verifySandboxManifest(catalog.manifestBytes, catalog.signature, "0.1.2", catalog.keys),
    ).rejects.toThrow(/does not sign Appflare releases/);

    const manager = await sandboxRelease("0.1.2", { tweak: (m) => (m.app = "appflare") });
    await expect(
      verifySandboxManifest(manager.manifestBytes, manager.signature, "0.1.2", manager.keys),
    ).rejects.toThrow(/not a sandbox Worker release/);

    const r = await sandboxRelease("0.1.2");
    await expect(
      verifySandboxManifest(r.manifestBytes, r.signature, "0.1.3", r.keys),
    ).rejects.toThrow(/version 0.1.2, the release is 0.1.3/);

    const extra = await sandboxRelease("0.1.2", {
      tweak: (m) => m.worker.bindings.push({ type: "kv_namespace", name: "CACHE" }),
    });
    await expect(
      verifySandboxManifest(extra.manifestBytes, extra.signature, "0.1.2", extra.keys),
    ).rejects.toThrow(/kv_namespace binding \(CACHE\) this version of Appflare does not know/);

    const other = await sandboxRelease("0.1.2");
    await expect(
      verifySandboxManifest(other.manifestBytes, r.signature, "0.1.2", other.keys),
    ).rejects.toThrow();
  });

  it("refuses a release of static assets only, which has no code to run builds", async () => {
    const r = await buildArtifactFixture({
      version: "0.1.2",
      keyId: "appflare-test",
      assetsOnly: true,
      assets: [{ route: "/index.html", content: "<h1>hi</h1>" }],
      tweak: (m) => {
        m.app = "appflare-sandbox";
      },
    });
    await expect(
      verifySandboxManifest(r.manifestBytes, r.signature, "0.1.2", r.keys),
    ).rejects.toThrow("the release has no Worker code (it serves static assets only)");
  });
});
