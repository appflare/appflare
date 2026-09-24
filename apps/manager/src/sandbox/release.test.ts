import { describe, expect, it } from "vitest";
import sandboxPackage from "../../../sandbox/package.json";
import { sandboxRelease } from "../test/fake-sandbox-account";
import {
  PINNED_SANDBOX_VERSION,
  sandboxReleaseAssets,
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
});
