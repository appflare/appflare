import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { signingKeys } from "@appflare/schema";
import { afterEach, describe, expect, it } from "vitest";
import { safeJoin, unpackArtifact, verifyArtifact } from "./artifact.ts";
import { buildFixtureArtifact, makeTestKey, signBytes } from "./test-fixtures.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
async function fixture(options: Parameters<typeof buildFixtureArtifact>[0]) {
  const built = await buildFixtureArtifact(options);
  dirs.push(built.dir);
  return built;
}

describe("verifyArtifact", () => {
  it("accepts an artifact signed by a trusted key", async () => {
    const key = await makeTestKey();
    const { dir } = await fixture({ sign: key });
    const verified = await verifyArtifact({ dir, keys: [key.key] });
    expect(verified.keyId).toBe(key.key.keyId);
    expect(verified.manifest.app).toBe("appflare");
    expect(verified.zipPath).toBe(path.join(dir, "appflare-0.1.0.zip"));
  });

  it("rejects a key id that is not trusted", async () => {
    const key = await makeTestKey("rogue-2026-09");
    const { dir } = await fixture({ sign: key });
    await expect(verifyArtifact({ dir, keys: signingKeys })).rejects.toThrow(
      'no trusted signing key matches keyId "rogue-2026-09"',
    );
  });

  it('rejects keyId "unsigned" even with a signature file', async () => {
    const key = await makeTestKey();
    const { dir, manifestBytes } = await fixture({ keyId: "unsigned" });
    writeFileSync(path.join(dir, "manifest.sig"), await signBytes(manifestBytes, key.privateKey));
    await expect(verifyArtifact({ dir, keys: [key.key] })).rejects.toThrow("unsigned");
  });

  it("rejects a manifest edited after signing", async () => {
    const key = await makeTestKey();
    const { dir } = await fixture({ sign: key });
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(manifestPath, readFileSync(manifestPath, "utf8").replace('"0.1.0"', '"0.1.1"'));
    await expect(verifyArtifact({ dir, keys: [key.key] })).rejects.toThrow("does not verify");
  });

  it("rejects a signature from another key with the same key id", async () => {
    const trusted = await makeTestKey("k");
    const other = await makeTestKey("k");
    const { dir } = await fixture({ sign: other });
    await expect(verifyArtifact({ dir, keys: [trusted.key] })).rejects.toThrow("does not verify");
  });

  it("requires manifest.sig unless unsigned artifacts are allowed", async () => {
    const { dir } = await fixture({ keyId: "appflare-2026-09" });
    await expect(verifyArtifact({ dir })).rejects.toThrow("manifest.sig not found");
    const verified = await verifyArtifact({ dir, allowUnsigned: true });
    expect(verified.keyId).toBeNull();
  });

  it("still checks a signature that is present when unsigned artifacts are allowed", async () => {
    const key = await makeTestKey();
    const { dir } = await fixture({ sign: key });
    await expect(verifyArtifact({ dir, allowUnsigned: true, keys: [] })).rejects.toThrow(
      "no trusted signing key",
    );
  });

  it("rejects an artifact that is not the manager", async () => {
    const key = await makeTestKey();
    const { dir } = await fixture({
      sign: key,
      mutate: (m) => {
        m.app = "cut";
      },
    });
    await expect(verifyArtifact({ dir, keys: [key.key] })).rejects.toThrow(
      '"cut", not the Appflare manager',
    );
  });

  it("rejects a manifest whose version differs from the release", async () => {
    const key = await makeTestKey();
    const { dir } = await fixture({ sign: key });
    await expect(
      verifyArtifact({ dir, keys: [key.key], expectedVersion: "0.2.0" }),
    ).rejects.toThrow("the release is 0.2.0 but its manifest says 0.1.0");
  });

  it("rejects a manifest that fails the schema", async () => {
    const key = await makeTestKey();
    const { dir } = await fixture({
      sign: key,
      mutate: (m) => {
        (m as { d1?: unknown }).d1 = undefined;
      },
    });
    await expect(verifyArtifact({ dir, keys: [key.key] })).rejects.toThrow(
      "not a valid artifact manifest",
    );
  });

  it("says to run the latest installer for a release of a later format", async () => {
    const key = await makeTestKey();
    const { dir } = await fixture({
      sign: key,
      mutate: (m) => {
        (m as { format: number }).format = 7;
      },
    });
    await expect(verifyArtifact({ dir, keys: [key.key] })).rejects.toThrow(
      "the release is artifact format 7, and this installer reads format 1; run the latest installer (npx create-appflare@latest)",
    );
  });

  it("says a release of format 2 to 6 needs to be packed again, since no installer reads it", async () => {
    const key = await makeTestKey();
    for (const format of [2, 6]) {
      const { dir } = await fixture({
        sign: key,
        mutate: (m) => {
          (m as { format: number }).format = format;
        },
      });
      await expect(verifyArtifact({ dir, keys: [key.key] })).rejects.toThrow(
        `the release is artifact format ${format}: it was built for an earlier version of Appflare and needs to be packed again by its catalog`,
      );
    }
  });
});

describe("unpackArtifact", () => {
  async function outDir() {
    const dir = await mkdtemp(path.join(tmpdir(), "appflare-cli-unpack-"));
    dirs.push(dir);
    return dir;
  }

  it("checks every slice and writes modules and assets", async () => {
    const key = await makeTestKey();
    const { dir } = await fixture({ sign: key });
    const { manifest, zipPath } = await verifyArtifact({ dir, keys: [key.key] });
    const out = await outDir();
    const unpacked = await unpackArtifact(manifest, zipPath, out);
    expect(unpacked).toMatchObject({ moduleCount: 2, assetCount: 2 });
    expect(readFileSync(path.join(out, "worker/chunks/a.js"), "utf8")).toBe(
      "export const a = 1;\n",
    );
    expect(readFileSync(path.join(out, "assets/assets/app.js"), "utf8")).toBe(
      "console.log('app');\n",
    );
    expect(existsSync(path.join(out, "d1"))).toBe(false);
  });

  it("writes the recorded _redirects and _headers into the assets directory", async () => {
    const { dir } = await fixture({
      mutate: (m) => {
        m.assets.config = { ...m.assets.config, _redirects: "/old /new 301\n" };
      },
    });
    const { manifest, zipPath } = await verifyArtifact({ dir, allowUnsigned: true });
    const out = await outDir();
    await unpackArtifact(manifest, zipPath, out);
    expect(readFileSync(path.join(out, "assets/_redirects"), "utf8")).toBe("/old /new 301\n");
    expect(existsSync(path.join(out, "assets/_headers"))).toBe(false);
  });

  it("rejects a file whose bytes do not match its sha256, before writing anything", async () => {
    const { dir } = await fixture({ tamper: "d1/DB/0000_init.sql" });
    const { manifest, zipPath } = await verifyArtifact({ dir, allowUnsigned: true });
    const out = await outDir();
    await expect(unpackArtifact(manifest, zipPath, out)).rejects.toThrow(
      "sha256 mismatch for d1/DB/0000_init.sql",
    );
    expect(existsSync(path.join(out, "worker"))).toBe(false);
  });

  it("rejects an offset past the end of the zip", async () => {
    const { dir } = await fixture({
      mutate: (m) => {
        (m.worker.modules[1] as { offset: number }).offset = 10_000_000;
      },
    });
    const { manifest, zipPath } = await verifyArtifact({ dir, allowUnsigned: true });
    await expect(unpackArtifact(manifest, zipPath, await outDir())).rejects.toThrow(
      "outside the zip",
    );
  });

  it("refuses module names that escape the output directory", async () => {
    const { dir } = await fixture({
      mutate: (m) => {
        (m.worker.modules[1] as { name: string }).name = "../evil.js";
      },
    });
    const { manifest, zipPath } = await verifyArtifact({ dir, allowUnsigned: true });
    await expect(unpackArtifact(manifest, zipPath, await outDir())).rejects.toThrow("unsafe path");
  });
});

describe("safeJoin", () => {
  it.each(["", "/etc/passwd", "a/../../b", "a//b", "./a", "a\\b"])("rejects %j", (p) => {
    expect(() => safeJoin("/root", p)).toThrow("unsafe path");
  });
  it("joins a plain relative path", () => {
    expect(safeJoin("/root", "assets/app.js")).toBe(path.join("/root", "assets", "app.js"));
  });
});
