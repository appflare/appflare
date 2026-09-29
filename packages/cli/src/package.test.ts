import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The installer is published to npm as `create-appflare`, so `npx create-appflare`
// runs it. These checks keep the manifest publishable and the published files
// limited to what the installer needs at run time.

const root = new URL("../../../", import.meta.url);
const pkgDir = new URL("../", import.meta.url);

type Manifest = {
  name?: string;
  private?: boolean;
  license?: string;
  engines?: { node?: string };
  bin?: Record<string, string>;
  files?: string[];
  homepage?: string;
  repository?: { type?: string; url?: string; directory?: string };
  keywords?: string[];
  publishConfig?: { access?: string; provenance?: boolean };
};

function readJson<T>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

const pkg = readJson<Manifest>(new URL("package.json", pkgDir));

describe("the published package", () => {
  it("is create-appflare, public, with provenance", () => {
    expect(pkg.name).toBe("create-appflare");
    expect(pkg.private).toBe(false);
    expect(pkg.publishConfig).toMatchObject({ access: "public", provenance: true });
  });

  it("has a single create-appflare bin that exists in the package", () => {
    expect(pkg.bin).toEqual({ "create-appflare": "./bin/appflare.js" });
    expect(readFileSync(new URL("bin/appflare.js", pkgDir), "utf8")).toMatch(
      /^#!\/usr\/bin\/env node\n/,
    );
  });

  it("ships only the built output, the README and the license", () => {
    expect(pkg.files).toEqual(["bin", "dist", "README.md", "LICENSE"]);
  });

  it("needs Node.js 22, as the launcher checks", () => {
    expect(pkg.engines?.node).toBe(">=22");
  });

  it("points at this repository and the docs site, under the repository's license", () => {
    expect(pkg.homepage).toBe("https://appflare.dev");
    // npm checks a provenance statement against this URL and directory.
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/appflare/appflare.git",
      directory: "packages/cli",
    });
    expect(pkg.license).toBe("Apache-2.0");
    expect(readFileSync(new URL("LICENSE", pkgDir), "utf8")).toBe(
      readFileSync(new URL("LICENSE", root), "utf8"),
    );
    expect(pkg.keywords).toEqual(expect.arrayContaining(["appflare", "cloudflare"]));
  });

  it("uses absolute image URLs in its README, which npm shows as it is", () => {
    const readme = readFileSync(new URL("README.md", pkgDir), "utf8");
    for (const [, src] of readme.matchAll(/(?:src|srcset)="([^"]+)"/g)) {
      expect(src).toMatch(/^https:\/\//);
    }
  });
});

describe("the other workspace packages", () => {
  it("stay private, so the installer is the only package on npm", () => {
    const publishable: string[] = [];
    for (const group of ["apps", "packages"]) {
      for (const dir of readdirSync(new URL(`${group}/`, root))) {
        let manifest: Manifest;
        try {
          manifest = readJson<Manifest>(new URL(`${group}/${dir}/package.json`, root));
        } catch {
          continue;
        }
        if (manifest.private !== true) publishable.push(manifest.name ?? dir);
      }
    }
    expect(publishable).toEqual(["create-appflare"]);
  });

  it("changesets version the installer and publish it as public", () => {
    const config = readJson<{ access?: string; ignore?: string[] }>(
      new URL(".changeset/config.json", root),
    );
    expect(config.access).toBe("public");
    expect(config.ignore).not.toContain("create-appflare");
  });
});
