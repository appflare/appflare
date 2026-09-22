import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetHash } from "@appflare/cf-api";
import type { ArtifactManifest } from "@appflare/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PackResult, pack } from "./pack.ts";
import { verify } from "./verify.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.resolve(HERE, "..", "fixtures", "hello");
const FIXTURE_MANIFEST = path.join(FIXTURE, "appflare.jsonc");
const SIGN_ENV = "APPFLARE_PACK_TEST_KEY";
const hasUnzip = spawnSync("unzip", ["-v"]).error === undefined;

async function generateKeypair(): Promise<{ privateBase64: string; publicBase64: string }> {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) {
    throw new Error("expected an Ed25519 key pair");
  }
  return {
    privateBase64: Buffer.from(await webcrypto.subtle.exportKey("pkcs8", pair.privateKey)).toString(
      "base64",
    ),
    publicBase64: Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString(
      "base64",
    ),
  };
}

/** Reads exactly bytes[offset, offset+size) from a file, as the manager would. */
function readRange(filePath: string, offset: number, size: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size);
    if (size > 0) {
      const read = readSync(fd, buf, 0, size, offset);
      expect(read).toBe(size);
    }
    return buf;
  } finally {
    closeSync(fd);
  }
}

describe("pack + verify (integration)", () => {
  let outDir: string;
  let keys: { privateBase64: string; publicBase64: string };
  let result: PackResult;

  beforeAll(async () => {
    outDir = mkdtempSync(path.join(tmpdir(), "appflare-pack-it-"));
    keys = await generateKeypair();
    result = await pack({
      checkoutDir: FIXTURE,
      manifestPath: FIXTURE_MANIFEST,
      outDir,
      install: false,
      signKeyEnv: SIGN_ENV,
      keyId: "test-key",
      env: { ...process.env, [SIGN_ENV]: keys.privateBase64 },
    });
  }, 120_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("packs the fixture with the expected shape", () => {
    expect(result.slug).toBe("hello");
    expect(result.version).toBe("1.2.3"); // from source.ref v1.2.3
    expect(result.moduleCount).toBe(1);
    expect(result.assetCount).toBe(3); // robots.txt + .assetsignore are ignored
    expect(result.d1MigrationCount).toBe(2);
    expect(result.manifest.keyId).toBe("test-key");
    expect(result.signaturePath).not.toBeNull();
  });

  it("strips account ids and records vars as plain_text bindings", () => {
    const bindings = result.manifest.worker.bindings;
    expect(bindings).toContainEqual({ type: "kv_namespace", name: "CACHE" });
    expect(bindings).toContainEqual({ type: "d1", name: "DB" });
    expect(bindings).toContainEqual({ type: "plain_text", name: "GREETING", text: "Hello" });
    // The fixture's KV id and D1 database_id must not appear anywhere.
    const dump = JSON.stringify(result.manifest);
    expect(dump).not.toContain("cafebabecafebabecafebabecafebabe");
    expect(dump).not.toContain("11111111-2222-3333-4444-555555555555");
  });

  it("verifies against the generated public key", async () => {
    const res = await verify({ dir: outDir, publicKey: keys.publicBase64 });
    expect(res.ok).toBe(true);
    expect(res.signed).toBe(true);
    expect(res.checkedFiles).toBe(6); // 1 module + 3 assets + 2 migrations
  });

  it("rejects a wrong public key", async () => {
    const other = await generateKeypair();
    await expect(verify({ dir: outDir, publicKey: other.publicBase64 })).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it("records the same BLAKE3 asset hash cf-api computes for the same bytes", () => {
    const entry = result.manifest.assets.files.find((f) => f.route === "/index.html");
    expect(entry).toBeDefined();
    const bytes = readFileSync(path.join(FIXTURE, "public", "index.html"));
    expect(entry?.hash).toBe(assetHash(bytes, "index.html"));
    expect(entry?.hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("passes --require-signed for a signed artifact", async () => {
    const res = await verify({ dir: outDir, publicKey: keys.publicBase64, requireSigned: true });
    expect(res.signed).toBe(true);
  });

  it("every manifest offset+size returns exactly the file's bytes", () => {
    const manifest = result.manifest;
    const entries = [
      ...manifest.worker.modules,
      ...manifest.assets.files,
      ...Object.values(manifest.d1Migrations).flat(),
    ];
    for (const entry of entries) {
      const bytes = readRange(result.zipPath, entry.offset, entry.size);
      expect(bytes.length).toBe(entry.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    }
  });

  it.skipIf(!hasUnzip)("unzips to files whose sha256 and bytes match the manifest ranges", () => {
    const extractDir = mkdtempSync(path.join(tmpdir(), "appflare-pack-unzip-"));
    try {
      const res = spawnSync("unzip", ["-o", result.zipPath, "-d", extractDir], {
        encoding: "utf8",
      });
      expect(res.status, res.stdout + res.stderr).toBe(0);

      const manifest = result.manifest;
      const entries = [
        ...manifest.worker.modules,
        ...manifest.assets.files,
        ...Object.values(manifest.d1Migrations).flat(),
      ];
      for (const entry of entries) {
        const extracted = readFileSync(path.join(extractDir, entry.path));
        expect(extracted.length).toBe(entry.size);
        expect(createHash("sha256").update(extracted).digest("hex")).toBe(entry.sha256);
        const range = readRange(result.zipPath, entry.offset, entry.size);
        expect(range.equals(extracted)).toBe(true);
      }
    } finally {
      rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it("detects a tampered file body", async () => {
    const tamperedDir = mkdtempSync(path.join(tmpdir(), "appflare-pack-tamper-"));
    try {
      // Copy the signed artifact, then flip one byte of the first module's data.
      const zipName = path.basename(result.zipPath);
      const zip = readFileSync(result.zipPath);
      writeFileSync(path.join(tamperedDir, "manifest.json"), readFileSync(result.manifestJsonPath));
      if (result.signaturePath) {
        writeFileSync(path.join(tamperedDir, "manifest.sig"), readFileSync(result.signaturePath));
      }
      const firstModule = result.manifest.worker
        .modules[0] as ArtifactManifest["worker"]["modules"][number];
      const tampered = Buffer.from(zip);
      tampered[firstModule.offset] = (tampered[firstModule.offset] ?? 0) ^ 0xff;
      writeFileSync(path.join(tamperedDir, zipName), tampered);

      await expect(verify({ dir: tamperedDir, publicKey: keys.publicBase64 })).rejects.toThrow(
        /sha256 mismatch/,
      );
    } finally {
      rmSync(tamperedDir, { recursive: true, force: true });
    }
  });
});

describe("pack + verify unsigned", () => {
  it("marks the artifact unsigned and verifies hashes only", async () => {
    const outDir = mkdtempSync(path.join(tmpdir(), "appflare-pack-unsigned-"));
    try {
      const res = await pack({
        checkoutDir: FIXTURE,
        manifestPath: FIXTURE_MANIFEST,
        outDir,
        install: false,
      });
      expect(res.manifest.keyId).toBe("unsigned");
      expect(res.signaturePath).toBeNull();

      const verified = await verify({ dir: outDir });
      expect(verified.signed).toBe(false);
      expect(verified.keyId).toBe("unsigned");
      expect(verified.checkedFiles).toBe(6);

      // --require-signed turns an unsigned artifact into a failure.
      await expect(verify({ dir: outDir, requireSigned: true })).rejects.toThrow(/unsigned/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("pack leaves nothing behind on failure", () => {
  it("does not create --out when the signing key env var is empty", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-fail-"));
    const outDir = path.join(parent, "artifact-out");
    try {
      await expect(
        pack({
          checkoutDir: FIXTURE,
          manifestPath: FIXTURE_MANIFEST,
          outDir,
          install: false,
          signKeyEnv: "APPFLARE_EMPTY_KEY",
          keyId: "test-key",
          env: { ...process.env, APPFLARE_EMPTY_KEY: "" },
        }),
      ).rejects.toThrow(/is not set/);
      // Nothing was written into --out, and no staging dir was left in its parent.
      expect(existsSync(outDir)).toBe(false);
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
