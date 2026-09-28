import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readCatalogManifest } from "./manifest.ts";

const HELLO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "hello",
  "appflare.jsonc",
);

function helloWith(edit: (manifest: Record<string, unknown>) => void): string {
  const manifest = readCatalogManifest(readFileSync(HELLO, "utf8")) as unknown as Record<
    string,
    unknown
  >;
  edit(manifest);
  return JSON.stringify(manifest);
}

describe("readCatalogManifest", () => {
  it("reads a manifest with its defaults filled in", () => {
    const manifest = readCatalogManifest(readFileSync(HELLO, "utf8"));
    expect(manifest.install).toMatchObject({
      tier: "artifact",
      fixedWorkerName: false,
      health: { path: "/", mode: "default" },
    });
    expect(manifest.tokenPermissions).toEqual([]);
    expect(manifest.revision).toBe(1);
  });

  it("names every problem with its path, unknown keys included", () => {
    const text = helloWith((m) => {
      m.categorys = ["utilities"];
      m.tagline = "Ends with a period.";
    });
    expect(() => readCatalogManifest(text)).toThrow(
      /^the catalog manifest is not valid:\n(- .+\n)*- categorys: categorys is not a field here; check its spelling/,
    );
    expect(() => readCatalogManifest(text)).toThrow(/- tagline: must not end with a period/);
  });

  it("allows NOASSERTION and SEE LICENSE IN only for a repository build", () => {
    for (const license of ["NOASSERTION", "SEE LICENSE IN LICENSE.md"]) {
      const text = helloWith((m) => {
        m.license = license;
      });
      expect(() => readCatalogManifest(text)).toThrow(/- license: license is "/);
      expect(readCatalogManifest(text, { repositoryBuild: true }).license).toBe(license);
    }
    // Every other license is still held to the SPDX list.
    const deprecated = helloWith((m) => {
      m.license = "AGPL-3.0";
    });
    expect(() => readCatalogManifest(deprecated, { repositoryBuild: true })).toThrow(
      /a deprecated SPDX id/,
    );
  });

  it("says when the text is not JSONC", () => {
    expect(() => readCatalogManifest("{ nope")).toThrow(/^the catalog manifest is not valid JSONC/);
  });
});
