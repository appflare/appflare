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
import { type ArtifactManifest, MAX_WORKER_MODULES } from "@appflare/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main, parseMaxModules } from "./cli-main.ts";
import { parseJsonc } from "./jsonc.ts";
import { type PackResult, pack, packWarnings } from "./pack.ts";
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
    expect(result.versionOrigin).toBe("tag");
    expect(result.moduleCount).toBe(1);
    expect(result.assetCount).toBe(3); // robots.txt + .assetsignore are ignored
    expect(result.d1MigrationCount).toBe(2);
    expect(result.manifest.keyId).toBe("test-key");
    expect(result.signaturePath).not.toBeNull();
    expect(result.warnings).toEqual([]);
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

  it("fails --max-modules only when the Worker has more modules than allowed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "appflare-pack-modules-"));
    try {
      // The same artifact listing its one module under many names: every range
      // still verifies, so only the module count can fail it.
      const manifest = JSON.parse(
        readFileSync(result.manifestJsonPath, "utf8"),
      ) as ArtifactManifest;
      const first = manifest.worker.modules[0] as ArtifactManifest["worker"]["modules"][number];
      for (let i = 1; i <= MAX_WORKER_MODULES; i++) {
        manifest.worker.modules.push({ ...first, name: `chunk-${i}.js` });
      }
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(path.join(dir, path.basename(result.zipPath)), readFileSync(result.zipPath));
      const count = MAX_WORKER_MODULES + 1;

      // Opt-in: without the flag the artifact verifies.
      await expect(verify({ dir, hashesOnly: true })).resolves.toMatchObject({ ok: true });
      await expect(verify({ dir, hashesOnly: true, maxModules: count })).resolves.toMatchObject({
        ok: true,
      });
      await expect(
        verify({ dir, hashesOnly: true, maxModules: MAX_WORKER_MODULES }),
      ).rejects.toThrow(
        `hello@1.2.3 has ${count} Worker modules, but one upload can fetch at most ${MAX_WORKER_MODULES}`,
      );
      await expect(verify({ dir, hashesOnly: true, maxModules: 0 })).rejects.toThrow(
        /--max-modules must be a positive integer/,
      );
      // The CLI flag reaches verify.
      await expect(
        main(["verify", dir, "--hashes-only", "--max-modules", String(MAX_WORKER_MODULES)]),
      ).rejects.toThrow(`has ${count} Worker modules`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

/** Writes the fixture's catalog manifest with `install.version` set into `dir`. */
function manifestWithInstallVersion(dir: string, version: unknown): string {
  const catalog = parseJsonc(readFileSync(FIXTURE_MANIFEST, "utf8")) as {
    install: Record<string, unknown>;
  };
  catalog.install.version = version;
  const file = path.join(dir, "appflare.jsonc");
  writeFileSync(file, JSON.stringify(catalog));
  return file;
}

describe("pack with install.version", () => {
  it("takes the version from the catalog manifest over the source.ref tag", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-installversion-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const res = await pack({
        checkoutDir: FIXTURE,
        manifestPath: manifestWithInstallVersion(parent, "4.5.6"),
        outDir,
        install: false,
        logger: (m) => logs.push(m),
      });
      expect(res.version).toBe("4.5.6");
      expect(res.versionOrigin).toBe("install.version");
      expect(res.manifest.version).toBe("4.5.6");
      expect(res.manifest.source.ref).toBe("v1.2.3");
      expect(res.manifest.catalog.install.version).toBe("4.5.6");
      expect(path.basename(res.zipPath)).toBe("hello-4.5.6.zip");
      expect(logs.find((l) => l.startsWith("packed hello@4.5.6"))).toMatch(
        /\(version from install\.version in the catalog manifest\)/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails before writing anything when install.version is not semver", async () => {
    for (const bad of ["v4.5.6", "4.5", "latest"]) {
      const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-badversion-"));
      const manifestPath = manifestWithInstallVersion(parent, bad);
      const outDir = path.join(parent, "out");
      try {
        await expect(
          pack({ checkoutDir: FIXTURE, manifestPath, outDir, install: false }),
        ).rejects.toThrow(/must be a semver version such as 1\.2\.3, without a leading v/);
        expect(existsSync(outDir)).toBe(false);
        expect(readdirSync(parent)).toEqual(["appflare.jsonc"]);
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    }
  }, 120_000);
});

describe("packWarnings", () => {
  const withModules = (count: number) => ({
    app: "demo",
    version: "1.0.0",
    worker: {
      modules: Array.from({ length: count }, (_, i) => ({ name: `m${i}.js` })),
    } as unknown as ArtifactManifest["worker"],
  });

  it("is empty while the modules fit one upload", () => {
    expect(packWarnings(withModules(1))).toEqual([]);
    expect(packWarnings(withModules(MAX_WORKER_MODULES))).toEqual([]);
  });

  it("warns when Appflare could not upload that many modules", () => {
    const [warning, ...rest] = packWarnings(withModules(84));
    expect(rest).toEqual([]);
    expect(warning).toMatch(
      /^demo@1\.0\.0 has 84 Worker modules, but one upload can fetch at most /,
    );
    expect(warning).toMatch(/Appflare cannot install or update it as packed\.$/);
  });
});

describe("parseMaxModules", () => {
  it("accepts a positive integer and nothing", () => {
    expect(parseMaxModules(undefined)).toBeUndefined();
    expect(parseMaxModules("21")).toBe(21);
  });

  it("rejects anything else", () => {
    for (const bad of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => parseMaxModules(bad)).toThrow(/--max-modules must be a positive integer/);
    }
  });
});
