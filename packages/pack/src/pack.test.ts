import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
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
import { type ArtifactManifest, MAX_WORKER_UPLOAD_BYTES } from "@appflare/schema";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_MODULES_DEPRECATION, main } from "./cli-main.ts";
import { parseJsonc } from "./jsonc.ts";
import { type PackResult, pack } from "./pack.ts";
import { verify } from "./verify.ts";
import { artifactWorkerSize } from "./worker-size.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.resolve(HERE, "..", "fixtures", "hello");
const FIXTURE_MANIFEST = path.join(FIXTURE, "appflare.jsonc");
const SIGN_ENV = "APPFLARE_PACK_TEST_KEY";
const hasUnzip = spawnSync("unzip", ["-v"]).error === undefined;
const MIB = 1024 * 1024;

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
  });

  it("strips account ids and records string vars as plain_text bindings", () => {
    const bindings = result.manifest.worker.bindings;
    expect(bindings).toContainEqual({ type: "kv_namespace", name: "CACHE" });
    expect(bindings).toContainEqual({ type: "d1", name: "DB" });
    expect(bindings).toContainEqual({ type: "plain_text", name: "GREETING", text: "Hello" });
    // No redirect: the declared config is the one built.
    expect(result.manifest.worker.wranglerConfig).toEqual({
      declared: "wrangler.jsonc",
      effective: "wrangler.jsonc",
    });
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

  it("passes --check-upload for any module count that fits one upload", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "appflare-pack-modules-"));
    try {
      // The same artifact listing its one module under 600 names: every range
      // still verifies, and they all lie in one span of the zip.
      const manifest = JSON.parse(
        readFileSync(result.manifestJsonPath, "utf8"),
      ) as ArtifactManifest;
      const first = manifest.worker.modules[0] as ArtifactManifest["worker"]["modules"][number];
      for (let i = 1; i < 600; i++) {
        manifest.worker.modules.push({ ...first, name: `chunk-${i}.js` });
      }
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(path.join(dir, path.basename(result.zipPath)), readFileSync(result.zipPath));

      await expect(verify({ dir, hashesOnly: true, checkUpload: true })).resolves.toMatchObject({
        ok: true,
      });
      const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await expect(main(["verify", dir, "--hashes-only", "--check-upload"])).resolves.toBe(0);
        expect(out).toHaveBeenCalledWith("OK: 605 files verified (unsigned)\n");
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails --check-upload, and the deprecated --max-modules, for a Worker too large to upload", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "appflare-pack-too-big-"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const manifest = JSON.parse(
        readFileSync(result.manifestJsonPath, "utf8"),
      ) as ArtifactManifest;
      const first = manifest.worker.modules[0] as ArtifactManifest["worker"]["modules"][number];
      // The check reads the manifest before any range, so the zip need not hold these bytes.
      first.size = 40 * 1024 * 1024;
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      writeFileSync(path.join(dir, path.basename(result.zipPath)), readFileSync(result.zipPath));
      const tooBig =
        "hello@1.2.3 has 40.00 MiB of Worker modules, but Appflare uploads at most 32.00 MiB";

      await expect(verify({ dir, hashesOnly: true, checkUpload: true })).rejects.toThrow(tooBig);
      // The CLI flag reaches verify.
      await expect(main(["verify", dir, "--hashes-only", "--check-upload"])).rejects.toThrow(
        tooBig,
      );
      // Existing catalog workflows still pass --max-modules <n>: it runs the same check.
      await expect(main(["verify", dir, "--hashes-only", "--max-modules", "21"])).rejects.toThrow(
        tooBig,
      );
      expect(stderr).toHaveBeenCalledWith(`- ${MAX_MODULES_DEPRECATION}\n`);
    } finally {
      stderr.mockRestore();
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

/**
 * A copy of the hello fixture whose wrangler config also binds a Vectorize
 * index and Workers AI, with a catalog manifest carrying `resources`.
 */
function vectorizeCheckout(parent: string, resources: unknown): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  const configPath = path.join(dir, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.vectorize = [{ binding: "VECTORIZE", index_name: "hello-vectors" }];
  config.ai = { binding: "AI" };
  writeFileSync(configPath, JSON.stringify(config));
  const catalog = parseJsonc(readFileSync(path.join(dir, "appflare.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  if (resources !== undefined) catalog.resources = resources;
  const manifest = path.join(parent, "appflare.jsonc");
  writeFileSync(manifest, JSON.stringify(catalog));
  return { dir, manifest };
}

describe("pack with a Vectorize binding", () => {
  it("records the declared dimensions and metric, and verify holds them to the catalog", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-vectorize-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = vectorizeCheckout(parent, {
        vectorize: { VECTORIZE: { dimensions: 384, metric: "cosine" } },
      });
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
      });
      const bindings = res.manifest.worker.bindings;
      expect(bindings).toContainEqual({
        type: "vectorize",
        name: "VECTORIZE",
        dimensions: 384,
        metric: "cosine",
      });
      expect(bindings).toContainEqual({ type: "ai", name: "AI" });
      expect(JSON.stringify(res.manifest.worker)).not.toContain("hello-vectors");
      expect(res.manifest.catalog.resources?.vectorize?.VECTORIZE).toEqual({
        dimensions: 384,
        metric: "cosine",
      });
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });

      // An artifact whose binding disagrees with its own catalog manifest fails.
      const manifestPath = path.join(outDir, "manifest.json");
      const edited = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
      edited.catalog.resources = {
        vectorize: { VECTORIZE: { dimensions: 768, metric: "cosine" } },
      };
      writeFileSync(manifestPath, JSON.stringify(edited));
      await expect(verify({ dir: outDir })).rejects.toThrow(
        /Vectorize binding VECTORIZE records 384 cosine, but the embedded catalog manifest declares 768 cosine/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails before building or writing anything when resources.vectorize is missing", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-novectorize-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = vectorizeCheckout(parent, undefined);
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
          logger: (m) => logs.push(m),
        }),
      ).rejects.toThrow(
        /binds a Vectorize index as VECTORIZE, .*add resources\.vectorize\.VECTORIZE/,
      );
      expect(existsSync(outDir)).toBe(false);
      expect(logs.some((l) => l.includes("dry-run"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A copy of the hello fixture whose wrangler config binds Hyperdrive and is
 * kept only as a template, `wrangler.jsonc.example`, as some repositories
 * ship it.
 */
function hyperdriveTemplateCheckout(
  parent: string,
  resources: unknown,
): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  const configPath = path.join(dir, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.hyperdrive = [
    {
      binding: "HYPERDRIVE",
      id: "0123456789abcdef0123456789abcdef",
      localConnectionString: "postgres://dev:dev-password@localhost:5432/hello",
    },
  ];
  writeFileSync(path.join(dir, "wrangler.jsonc.example"), JSON.stringify(config));
  rmSync(configPath);
  const catalog = parseJsonc(readFileSync(path.join(dir, "appflare.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  catalog.install = {
    ...(catalog.install as Record<string, unknown>),
    wranglerConfig: "wrangler.jsonc.example",
  };
  if (resources !== undefined) catalog.resources = resources;
  const manifest = path.join(parent, "appflare.jsonc");
  writeFileSync(manifest, JSON.stringify(catalog));
  return { dir, manifest };
}

describe("pack with a Hyperdrive binding and a template config", () => {
  it("copies the template to its real name and records the declared binding by name", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-hyperdrive-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = hyperdriveTemplateCheckout(parent, {
        hyperdrive: [{ binding: "HYPERDRIVE", protocol: "postgres" }],
      });
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
        logger: (m) => logs.push(m),
      });
      expect(existsSync(path.join(checkout.dir, "wrangler.jsonc"))).toBe(true);
      expect(logs).toContain(
        "copied the wrangler config template wrangler.jsonc.example to wrangler.jsonc",
      );
      expect(res.manifest.worker.wranglerConfig).toEqual({
        declared: "wrangler.jsonc.example",
        effective: "wrangler.jsonc",
      });
      expect(res.manifest.worker.bindings).toContainEqual({
        type: "hyperdrive",
        name: "HYPERDRIVE",
      });
      const recorded = JSON.stringify(res.manifest.worker);
      expect(recorded).not.toContain("0123456789abcdef0123456789abcdef");
      expect(recorded).not.toContain("dev-password");
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });

      // An artifact whose catalog manifest no longer declares the binding fails.
      const manifestPath = path.join(outDir, "manifest.json");
      const edited = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
      edited.catalog.resources = {};
      writeFileSync(manifestPath, JSON.stringify(edited));
      await expect(verify({ dir: outDir })).rejects.toThrow(
        /Hyperdrive binding HYPERDRIVE is not declared/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails before building or writing anything when resources.hyperdrive is missing", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-nohyperdrive-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = hyperdriveTemplateCheckout(parent, undefined);
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
          logger: (m) => logs.push(m),
        }),
      ).rejects.toThrow(/binds Hyperdrive as HYPERDRIVE, .*resources\.hyperdrive/);
      expect(existsSync(outDir)).toBe(false);
      expect(logs.some((l) => l.includes("dry-run"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A copy of the hello fixture whose D1 SQL is laid out the way wrangler's
 * migrations folder cannot describe: Prisma's folder per migration, an
 * idempotent schema file, and migrations for after the deploy.
 */
function d1LayoutCheckout(parent: string, schemaSql: string): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  };
  write("prisma/migrations/20240201000000_clicks/migration.sql", "CREATE TABLE clicks (id TEXT);");
  write("prisma/migrations/20240101000000_init/migration.sql", "CREATE TABLE links (id TEXT);");
  write("prisma/migrations/migration_lock.toml", 'provider = "sqlite"\n');
  write("src/db/schema.sql", schemaSql);
  write("after-deploy/0001_drop_legacy.sql", "DROP TABLE IF EXISTS legacy;");
  const catalog = parseJsonc(readFileSync(path.join(dir, "appflare.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  catalog.resources = {
    d1: {
      DB: {
        migrations: "prisma/migrations/*/migration.sql",
        schema: ["src/db/schema.sql"],
        postDeployMigrationsDir: "after-deploy",
      },
    },
  };
  const manifest = path.join(parent, "appflare.jsonc");
  writeFileSync(manifest, JSON.stringify(catalog));
  return { dir, manifest };
}

describe("pack with resources.d1", () => {
  const SCHEMA =
    "-- run on every deploy\nCREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY);\n";

  it("records the glob's migrations by folder, the schema file and the post-deploy migrations", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-d1-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = d1LayoutCheckout(parent, SCHEMA);
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
        logger: (m) => logs.push(m),
      });
      // The glob replaces the config's migrations folder; files keep wrangler's names.
      expect(res.manifest.d1Migrations.DB?.map((f) => [f.name, f.path])).toEqual([
        ["20240101000000_init/migration.sql", "d1/DB/20240101000000_init/migration.sql"],
        ["20240201000000_clicks/migration.sql", "d1/DB/20240201000000_clicks/migration.sql"],
      ]);
      expect(res.manifest.d1Schema?.DB?.map((f) => [f.name, f.path])).toEqual([
        ["src/db/schema.sql", "d1-schema/DB/src/db/schema.sql"],
      ]);
      expect(res.manifest.d1PostDeploy?.DB?.map((f) => [f.name, f.path])).toEqual([
        ["0001_drop_legacy.sql", "d1-post-deploy/DB/0001_drop_legacy.sql"],
      ]);
      expect([res.d1MigrationCount, res.d1SchemaCount, res.d1PostDeployCount]).toEqual([2, 1, 1]);
      // Managers that know only formats 1 and 2 must refuse it, not skip the new files.
      expect(res.manifest.format).toBe(3);
      expect(logs.at(-1)).toMatch(/2 migrations, 1 schema files, 1 post-deploy migrations/);
      const schemaFile = res.manifest.d1Schema?.DB?.[0];
      expect(
        readRange(res.zipPath, schemaFile?.offset ?? 0, schemaFile?.size ?? 0).toString(),
      ).toBe(SCHEMA);
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true, checkedFiles: 8 });

      // verify holds the schema file to the packer's rule even when its hashes match.
      const manifestPath = path.join(outDir, "manifest.json");
      const edited = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
      const entry = edited.d1Schema?.DB?.[0];
      if (entry === undefined) throw new Error("no schema file recorded");
      const unsafe = Buffer.from(SCHEMA.replace("IF NOT EXISTS", " ".repeat(13)));
      expect(unsafe.length).toBe(entry.size);
      const zip = readFileSync(res.zipPath);
      unsafe.copy(zip, entry.offset);
      writeFileSync(res.zipPath, zip);
      entry.sha256 = createHash("sha256").update(unsafe).digest("hex");
      writeFileSync(manifestPath, JSON.stringify(edited));
      await expect(verify({ dir: outDir })).rejects.toThrow(
        /the D1 schema file d1-schema\/DB\/src\/db\/schema\.sql cannot run on every install and update: line 2: CREATE TABLE settings has no IF NOT EXISTS/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses an unguarded schema file before building or writing anything", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-d1-refused-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = d1LayoutCheckout(parent, "CREATE TABLE settings (k TEXT);\nDROP TABLE old;");
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
          logger: (m) => logs.push(m),
        }),
      ).rejects.toThrow(
        /schema file src\/db\/schema\.sql of resources\.d1\.DB cannot run on every install and update: line 1: CREATE TABLE settings has no IF NOT EXISTS.*; line 2: DROP TABLE old drops/,
      );
      expect(existsSync(outDir)).toBe(false);
      expect(logs.some((l) => l.includes("dry-run"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A copy of the hello fixture whose wrangler config adds `services`, each
 * pointing at the config's own name unless it says otherwise.
 */
function serviceCheckout(
  parent: string,
  services: (name: string) => unknown[],
): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  const configPath = path.join(dir, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.services = services(String(config.name));
  writeFileSync(configPath, JSON.stringify(config));
  return { dir, manifest: path.join(dir, "appflare.jsonc") };
}

describe("pack with a service binding", () => {
  it("records a binding to the app's own Worker as service self, which verify accepts", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-self-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = serviceCheckout(parent, (name) => [
        { binding: "WORKER_SELF_REFERENCE", service: name },
      ]);
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
      });
      expect(res.manifest.worker.bindings).toContainEqual({
        type: "service",
        name: "WORKER_SELF_REFERENCE",
        service: "self",
      });
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });

      // An artifact edited to point the binding at another Worker fails.
      const manifestPath = path.join(outDir, "manifest.json");
      const edited = JSON.parse(readFileSync(manifestPath, "utf8")) as ArtifactManifest;
      edited.worker.bindings = edited.worker.bindings.map((b) =>
        b.type === "service" ? { ...b, service: "appflare", entrypoint: "JobUnits" } : b,
      );
      writeFileSync(manifestPath, JSON.stringify(edited));
      await expect(verify({ dir: outDir })).rejects.toThrow(
        /Service binding WORKER_SELF_REFERENCE points at the Worker "appflare"/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails before building or writing anything when one points at another Worker", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-foreign-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = serviceCheckout(parent, () => [
        { binding: "SELF", service: "appflare", entrypoint: "JobUnits" },
      ]);
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
          logger: (m) => logs.push(m),
        }),
      ).rejects.toThrow(/service binding SELF points at the Worker "appflare"/);
      expect(existsSync(outDir)).toBe(false);
      expect(logs.some((l) => l.includes("dry-run"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A copy of the fixture whose catalog manifest has a build command: the build
 * writes the wrangler config the packer then reads (as the Cloudflare Vite
 * plugin does) plus a static asset. The config adds queue consumers, a rate
 * limit, Images, and a restricted send_email binding.
 */
function buildCheckout(
  parent: string,
  buildCommand: string | string[],
): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  const config = parseJsonc(readFileSync(path.join(dir, "wrangler.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  const generated = {
    ...config,
    main: "../src/index.ts",
    assets: { ...(config.assets as object), directory: "../public" },
    d1_databases: [{ binding: "DB", database_name: "hello-db", migrations_dir: "../migrations" }],
    queues: {
      producers: [{ binding: "JOBS", queue: "hello-jobs" }],
      consumers: [
        { queue: "hello-jobs", max_batch_size: 5, max_retries: 3, dead_letter_queue: "hello-dlq" },
      ],
    },
    ratelimits: [{ name: "LIMITER", namespace_id: "1001", simple: { limit: 20, period: 60 } }],
    images: { binding: "IMAGES" },
    send_email: [{ name: "EMAIL", allowed_destination_addresses: ["owner@example.com"] }],
  };
  writeFileSync(path.join(dir, "wrangler.template.json"), JSON.stringify(generated));
  writeFileSync(
    path.join(dir, "build.mjs"),
    `import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
copyFileSync("wrangler.template.json", "dist/wrangler.json");
writeFileSync("public/built.txt", "built by " + process.argv[2]);
if (process.env.CLOUDFLARE_API_TOKEN) process.exit(9);`,
  );
  const catalog = parseJsonc(readFileSync(path.join(dir, "appflare.jsonc"), "utf8")) as {
    install: Record<string, unknown>;
  };
  catalog.install.buildCommand = buildCommand;
  catalog.install.wranglerConfig = "dist/wrangler.json";
  const manifest = path.join(parent, "appflare.jsonc");
  writeFileSync(manifest, JSON.stringify(catalog));
  return { dir, manifest };
}

describe("pack with install.buildCommand", () => {
  it("builds before reading the config, and records consumers and passthrough bindings", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-build-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = buildCheckout(parent, "node build.mjs appflare");
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
        env: { ...process.env, CLOUDFLARE_API_TOKEN: "cf-DO-NOT-LEAK" },
        logger: (m) => logs.push(m),
      });
      const buildAt = logs.findIndex((l) => l.startsWith("running install.buildCommand"));
      const dryRunAt = logs.findIndex((l) => l.includes("dry-run"));
      expect(buildAt).toBeGreaterThanOrEqual(0);
      expect(dryRunAt).toBeGreaterThan(buildAt);
      expect(res.manifest.catalog.install.buildCommand).toBe("node build.mjs appflare");
      const built = res.manifest.assets.files.find((f) => f.route === "/built.txt");
      expect(built).toBeDefined();
      const zip = readdirSync(outDir).find((f) => f.endsWith(".zip")) as string;
      expect(
        readRange(path.join(outDir, zip), built?.offset ?? 0, built?.size ?? 0).toString(),
      ).toBe("built by appflare");

      expect(res.manifest.worker.queueConsumers).toEqual([
        {
          queue: { binding: "JOBS" },
          max_batch_size: 5,
          max_retries: 3,
          dead_letter_queue: { name: "hello-dlq" },
        },
      ]);
      const bindings = res.manifest.worker.bindings;
      expect(bindings).toContainEqual({ type: "queue", name: "JOBS" });
      expect(bindings).toContainEqual({
        type: "ratelimit",
        name: "LIMITER",
        namespace_id: "1001",
        simple: { limit: 20, period: 60 },
      });
      expect(bindings).toContainEqual({ type: "images", name: "IMAGES" });
      expect(bindings).toContainEqual({
        type: "send_email",
        name: "EMAIL",
        allowed_destination_addresses: ["owner@example.com"],
      });
      expect(JSON.stringify(res.manifest.worker.bindings)).not.toContain("hello-jobs");
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails with the build's exit code and output, leaving nothing behind", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-build-fail-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = buildCheckout(parent, "node build.mjs appflare");
      writeFileSync(
        path.join(checkout.dir, "build.mjs"),
        'console.error("Could not resolve entry module index.html"); process.exit(1);',
      );
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
        }),
      ).rejects.toThrow(/failed \(exit 1\); last lines of its output:\nCould not resolve entry/);
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("runs a list of build commands in order and reports the Worker's size", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-build-steps-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = buildCheckout(parent, ["node step.mjs", "node build.mjs steps"]);
      // The second command reads what the first wrote.
      writeFileSync(
        path.join(checkout.dir, "step.mjs"),
        'import { writeFileSync } from "node:fs"; writeFileSync("public/step.txt", "first");',
      );
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
        logger: (m) => logs.push(m),
      });
      const ran = logs.filter((l) => l.startsWith("running install.buildCommand"));
      expect(ran).toEqual([
        "running install.buildCommand (1 of 2): node step.mjs (scrubbed environment)",
        "running install.buildCommand (2 of 2): node build.mjs steps (scrubbed environment)",
      ]);
      expect(res.manifest.catalog.install.buildCommand).toEqual([
        "node step.mjs",
        "node build.mjs steps",
      ]);
      const routes = res.manifest.assets.files.map((f) => f.route);
      expect(routes).toContain("/step.txt");
      expect(routes).toContain("/built.txt");
      expect(res.workerSize.size).toBe(res.manifest.worker.modules.reduce((n, m) => n + m.size, 0));
      const zip = readdirSync(outDir).find((f) => f.endsWith(".zip")) as string;
      expect(artifactWorkerSize(path.join(outDir, zip), res.manifest.worker.modules)).toEqual(
        res.workerSize,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A checkout shaped like a React Router app on the Cloudflare Vite plugin:
 * the declared `wrangler.jsonc` names an entry that only the build can
 * resolve, and the build writes the deployable config under `dist/` plus a
 * `.wrangler/deploy/config.json` redirect to it. The generated config holds
 * `legacy_env`, which wrangler accepts only in a redirected config, and a
 * var that is an array.
 */
function redirectedCheckout(
  parent: string,
  /** `migrations_dir` as the generated config states it. */
  generatedMigrationsDir = "../../migrations",
): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  const config = parseJsonc(readFileSync(path.join(dir, "wrangler.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    path.join(dir, "src", "server.ts"),
    'import build from "virtual:react-router/server-build";\nexport default build;\n',
  );
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({ ...config, main: "src/server.ts" }),
  );
  const generated = {
    ...config,
    main: "../../src/index.ts",
    legacy_env: true,
    topLevelName: "hello",
    assets: { ...(config.assets as object), directory: "../../public" },
    d1_databases: [
      { binding: "DB", database_name: "hello-db", migrations_dir: generatedMigrationsDir },
    ],
    vars: { GREETING: "Hello", PUBLIC_URL: "{{workerUrl}}", EMAIL_ADDRESSES: [] },
  };
  writeFileSync(path.join(dir, "generated.json"), JSON.stringify(generated));
  writeFileSync(
    path.join(dir, "build.mjs"),
    `import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist/hello", { recursive: true });
copyFileSync("generated.json", "dist/hello/wrangler.json");
mkdirSync(".wrangler/deploy", { recursive: true });
writeFileSync(".wrangler/deploy/config.json", JSON.stringify({ configPath: "../../dist/hello/wrangler.json", auxiliaryWorkers: [] }));`,
  );
  const catalog = parseJsonc(readFileSync(path.join(dir, "appflare.jsonc"), "utf8")) as {
    install: Record<string, unknown>;
    vars: Array<Record<string, unknown>>;
  };
  catalog.install.buildCommand = "node build.mjs";
  catalog.vars.push({
    name: "EMAIL_ADDRESSES",
    label: "Addresses",
    default: '["{{workerName}}@example.com"]',
  });
  const manifest = path.join(parent, "appflare.jsonc");
  writeFileSync(manifest, JSON.stringify(catalog));
  return { dir, manifest };
}

describe("pack with a redirected wrangler config", () => {
  it("builds from the config the build redirects to and records both paths", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-redirect-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = redirectedCheckout(parent);
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
        logger: (m) => logs.push(m),
      });
      expect(res.manifest.worker.wranglerConfig).toEqual({
        declared: "wrangler.jsonc",
        effective: "dist/hello/wrangler.json",
      });
      expect(logs.some((l) => l.includes("redirects wrangler from wrangler.jsonc"))).toBe(true);
      // Bundled from the generated config's entry, not the declared one.
      expect(res.moduleCount).toBe(1);
      expect(res.manifest.worker.mainModule).toBe("index.js");
      // Paths in the generated config resolve from its own directory.
      expect(res.assetCount).toBe(3);
      expect(res.d1MigrationCount).toBe(2);
      const bindings = res.manifest.worker.bindings;
      expect(bindings).toContainEqual({ type: "json", name: "EMAIL_ADDRESSES", json: [] });
      expect(bindings).toContainEqual({
        type: "plain_text",
        name: "PUBLIC_URL",
        text: "{{workerUrl}}",
      });
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("finds migrations_dir beside the declared config when the generated one copies it as is", async () => {
    // As the Cloudflare Vite plugin writes it: `migrations` beside
    // dist/hello/wrangler.json does not exist, but wrangler's own
    // `d1 migrations apply` reads it from beside wrangler.jsonc.
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-redirect-d1-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = redirectedCheckout(parent, "migrations");
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
      });
      expect(res.manifest.worker.wranglerConfig?.effective).toBe("dist/hello/wrangler.json");
      expect(res.manifest.d1Migrations.DB?.map((f) => f.name)).toEqual([
        "0001_init.sql",
        "0002_add_clicks.sql",
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails before bundling when a JSON var's catalog default is not JSON", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-json-var-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = redirectedCheckout(parent);
      const catalog = JSON.parse(readFileSync(checkout.manifest, "utf8")) as {
        vars: Array<Record<string, unknown>>;
      };
      const addresses = catalog.vars.find((v) => v.name === "EMAIL_ADDRESSES");
      if (addresses === undefined) throw new Error("fixture lost its var");
      addresses.default = "inbox@example.com";
      writeFileSync(checkout.manifest, JSON.stringify(catalog));
      const logs: string[] = [];
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
          logger: (m) => logs.push(m),
        }),
      ).rejects.toThrow(/default of the var EMAIL_ADDRESSES is not valid JSON/);
      expect(logs.some((l) => l.includes("dry-run"))).toBe(false);
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("pack of a Worker too large for one upload", () => {
  it("refuses it and writes nothing", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-too-big-"));
    const outDir = path.join(parent, "out");
    try {
      const dir = path.join(parent, "checkout");
      cpSync(FIXTURE, dir, { recursive: true });
      // A 33 MiB data module (wrangler's default rules make a .bin import one):
      // well under Cloudflare's 64 MiB, over what one upload holds.
      writeFileSync(path.join(dir, "src", "big.bin"), Buffer.alloc(MAX_WORKER_UPLOAD_BYTES + MIB));
      const entry = path.join(dir, "src", "index.ts");
      writeFileSync(
        entry,
        `// @ts-nocheck\nimport big from "./big.bin";\nexport const bigSize = big.byteLength;\n${readFileSync(entry, "utf8")}`,
      );
      await expect(
        pack({ checkoutDir: dir, manifestPath: FIXTURE_MANIFEST, outDir, install: false }),
      ).rejects.toThrow(
        /^hello@1\.2\.3 has 33\.\d\d MiB of Worker modules, but Appflare uploads at most 32\.00 MiB: .* Appflare could not install or update it, so nothing was written\.$/,
      );
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A copy of the fixture whose wrangler config sets `extra` on top of its
 * own, with its catalog manifest edited by `catalog`.
 */
function editedCheckout(
  parent: string,
  extra: Record<string, unknown>,
  catalog: (manifest: Record<string, unknown>) => void = () => {},
): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  const configPath = path.join(dir, "wrangler.jsonc");
  const config = parseJsonc(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...config, ...extra }));
  const manifestPath = path.join(dir, "appflare.jsonc");
  const manifest = parseJsonc(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  catalog(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { dir, manifest: manifestPath };
}

describe("pack with a var the catalog declares as a secret", () => {
  it("leaves the var out and says so, and records an unsafe rate limit", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-secret-var-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = editedCheckout(parent, {
        vars: { GREETING: "Hello", ADMIN_PASSWORD: "change-me" },
        unsafe: {
          bindings: [
            {
              name: "LIMITER",
              type: "ratelimit",
              namespace_id: "1001",
              simple: { limit: 10, period: 60 },
            },
          ],
        },
      });
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
        logger: (m) => logs.push(m),
      });
      const bindings = res.manifest.worker.bindings;
      expect(bindings.filter((b) => b.name === "ADMIN_PASSWORD")).toEqual([]);
      expect(bindings).toContainEqual({ type: "plain_text", name: "GREETING", text: "Hello" });
      expect(bindings).toContainEqual({
        type: "ratelimit",
        name: "LIMITER",
        namespace_id: "1001",
        simple: { limit: 10, period: 60 },
      });
      expect(logs).toContain(
        "var ADMIN_PASSWORD is provided as a secret: the catalog manifest declares ADMIN_PASSWORD as a secret, so the wrangler config's var of that name is left out",
      );
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails before building when the catalog declares one name as a secret and a var", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-secret-and-var-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = editedCheckout(parent, {}, (manifest) => {
        manifest.vars = [
          ...(manifest.vars as unknown[]),
          { name: "ADMIN_PASSWORD", label: "Admin password", required: false },
        ];
      });
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
          logger: (m) => logs.push(m),
        }),
      ).rejects.toThrow(
        /ADMIN_PASSWORD is declared both as a secret and as a var; a Worker cannot have a secret and a var of one name/,
      );
      expect(existsSync(outDir)).toBe(false);
      expect(logs.some((l) => l.includes("dry-run"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("fails before building on an unsafe binding other than a rate limit", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-unsafe-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = editedCheckout(parent, {
        unsafe: { bindings: [{ name: "GATEWAY", type: "ai_gateway" }] },
      });
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
        }),
      ).rejects.toThrow(/unsafe binding GATEWAY has the type "ai_gateway"/);
      expect(existsSync(outDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("names a secret the wrangler config requires that the catalog does not declare", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-required-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = editedCheckout(parent, {
        secrets: { required: ["ADMIN_PASSWORD", "API_KEY"] },
      });
      await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
        logger: (m) => logs.push(m),
      });
      expect(logs.filter((l) => l.includes("secrets.required"))).toEqual([
        "the wrangler config requires the secret API_KEY (secrets.required), which the catalog manifest does not declare",
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("pack of a Worker wrangler does not bundle", () => {
  it("finds an .mjs main module under its own name among the others", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-no-bundle-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = editedCheckout(parent, {
        main: "dist/server/entry.mjs",
        no_bundle: true,
        rules: [{ type: "ESModule", globs: ["**/*.mjs"] }],
      });
      const server = path.join(checkout.dir, "dist", "server");
      mkdirSync(path.join(server, "chunks"), { recursive: true });
      writeFileSync(
        path.join(server, "entry.mjs"),
        'import { greet } from "./chunks/greet.mjs";\nexport default { fetch: () => new Response(greet()) };\n',
      );
      writeFileSync(
        path.join(server, "chunks", "greet.mjs"),
        'export const greet = () => "hello";\n',
      );
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
      });
      expect(res.manifest.worker.mainModule).toBe("entry.mjs");
      expect(res.manifest.worker.modules.map((m) => [m.name, m.type])).toEqual([
        ["entry.mjs", "esm"],
        ["chunks/greet.mjs", "esm"],
      ]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
