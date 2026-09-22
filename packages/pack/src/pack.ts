import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetHash } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  type AssetFile,
  artifactManifestSchema,
  type CatalogManifest,
  catalogManifestSchema,
  type D1MigrationFile,
  type DoMigration,
  type WorkerModule,
} from "@appflare/schema";
import ignore from "ignore";
import { unstable_readConfig } from "wrangler";
import { parseJsonc } from "./jsonc.ts";
import { scrubEnv } from "./scrub-env.ts";
import { deriveVersion, formatBuildDate } from "./version.ts";
import {
  classifyModuleType,
  collectBindings,
  mainModuleName,
  type ResolvedWranglerConfig,
} from "./wrangler-config.ts";
import { ZipStore } from "./zip.ts";

/** Options for {@link pack}. */
export interface PackOptions {
  /** Directory of the wrangler project checkout. */
  checkoutDir: string;
  /** Path to the catalog manifest (`appflare.jsonc`). */
  manifestPath: string;
  /** Output directory for the artifact (zip + manifest.json + manifest.sig). */
  outDir: string;
  /** Install the checkout's dependencies first. Default true. */
  install?: boolean;
  /** Name of the env var holding the base64 PKCS#8 Ed25519 private key. */
  signKeyEnv?: string;
  /** Key id recorded in `manifest.keyId`. Required when signing. */
  keyId?: string;
  /** Environment source (for reading the sign key and spawning). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional progress logger. */
  logger?: (message: string) => void;
}

/** Result of a successful {@link pack}. */
export interface PackResult {
  manifest: ArtifactManifest;
  zipPath: string;
  manifestJsonPath: string;
  signaturePath: string | null;
  slug: string;
  version: string;
  moduleCount: number;
  assetCount: number;
  d1MigrationCount: number;
  zipSize: number;
}

interface CollectedFile {
  name: string;
  path: string;
  bytes: Buffer;
}
interface CollectedModule extends CollectedFile {
  isMain: boolean;
}

const require = createRequire(import.meta.url);

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Absolute path to the packer's own wrangler bin (bin/wrangler.js). */
function resolveWranglerBin(): string {
  const pkgPath = require.resolve("wrangler/package.json");
  const pkg = require(pkgPath) as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.wrangler;
  if (!rel) {
    throw new Error("could not resolve the wrangler bin from the packer's dependencies");
  }
  return path.join(path.dirname(pkgPath), rel);
}

function runInstall(
  checkoutDir: string,
  packageManager: CatalogManifest["install"]["packageManager"],
  childEnv: NodeJS.ProcessEnv,
  logger: (m: string) => void,
): void {
  let cmd: string;
  let args: string[];
  const extraEnv: NodeJS.ProcessEnv = {};
  switch (packageManager) {
    case "pnpm":
      cmd = "pnpm";
      // package-manager-strict=false + COREPACK_ENABLE_STRICT=0 let the machine's
      // pnpm build a checkout that pins a different pnpm major, without fetching a
      // new pnpm.
      args = [
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.package-manager-strict=false",
      ];
      extraEnv.COREPACK_ENABLE_STRICT = "0";
      break;
    case "npm":
      cmd = "npm";
      args = ["ci", "--ignore-scripts"];
      break;
    case "yarn":
      // Best-effort; classic-yarn flags. Berry projects are rare in v1.
      cmd = "yarn";
      args = ["install", "--frozen-lockfile", "--ignore-scripts"];
      extraEnv.YARN_ENABLE_SCRIPTS = "false";
      break;
    case "bun":
      cmd = "bun";
      args = ["install", "--frozen-lockfile", "--ignore-scripts"];
      break;
  }
  logger(`installing dependencies with ${cmd} (${packageManager})`);
  const res = spawnSync(cmd, args, {
    cwd: checkoutDir,
    env: { ...childEnv, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`failed to run ${cmd}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${res.status}):\n${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    );
  }
}

/**
 * Runs `wrangler deploy --dry-run --outdir` with the packer's own wrangler and a
 * scrubbed environment so nothing can reach any account. The checkout's
 * `build.command`, if any, runs as part of this.
 */
function runDryRun(
  wranglerConfigPath: string,
  checkoutDir: string,
  outdir: string,
  childEnv: NodeJS.ProcessEnv,
  logger: (m: string) => void,
): void {
  const wranglerBin = resolveWranglerBin();
  logger("running wrangler deploy --dry-run (scrubbed environment)");
  const res = spawnSync(
    process.execPath,
    [wranglerBin, "deploy", "--dry-run", "--outdir", outdir, "--config", wranglerConfigPath],
    {
      cwd: checkoutDir,
      env: childEnv,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  if (res.error) {
    throw new Error(`failed to spawn wrangler: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `wrangler deploy --dry-run failed (exit ${res.status}):\n${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    );
  }
}

/** Relative (posix) paths of every regular file under `dir`, recursively. */
function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir, { recursive: true }) as string[];
  const files: string[] = [];
  for (const rel of entries) {
    if (statSync(path.join(dir, rel)).isFile()) {
      files.push(rel.split(path.sep).join("/"));
    }
  }
  return files;
}

/** Collects the emitted worker modules from the dry-run outdir. */
function collectModules(outdir: string, config: ResolvedWranglerConfig): CollectedModule[] {
  const all = walkFiles(outdir);
  // Skip wrangler's own README.md description and every sourcemap.
  const candidates = all.filter(
    (rel) => rel !== "README.md" && !rel.toLowerCase().endsWith(".map"),
  );
  if (candidates.length === 0) {
    throw new Error(`no worker modules were emitted to ${outdir}`);
  }
  const expected = config.main ? mainModuleName(config.main) : undefined;
  let mainRel: string | undefined;
  if (expected && candidates.includes(expected)) {
    mainRel = expected;
  } else if (candidates.length === 1) {
    mainRel = candidates[0];
  } else if (expected) {
    mainRel = candidates.find((c) => (c.split("/").pop() ?? c) === expected);
  }
  if (!mainRel) {
    throw new Error(
      `could not identify the main worker module in ${outdir}; candidates: ${candidates.join(", ")}`,
    );
  }
  const additional = candidates.filter((c) => c !== mainRel).sort((a, b) => (a < b ? -1 : 1));
  const ordered = [mainRel, ...additional];
  return ordered.map((rel) => ({
    name: rel,
    path: `worker/${rel}`,
    bytes: readFileSync(path.join(outdir, rel)),
    isMain: rel === mainRel,
  }));
}

/** Builds the wrangler-compatible `.assetsignore` matcher for `dir`. */
function buildAssetIgnore(dir: string): ReturnType<typeof ignore> {
  // Mirrors wrangler's createAssetsIgnoreFunction: three default metafile
  // patterns plus the lines of `.assetsignore`, matched with the same `ignore`
  // library and semantics.
  const patterns = ["/.assetsignore", "/_redirects", "/_headers"];
  const ignoreFile = path.join(dir, ".assetsignore");
  if (existsSync(ignoreFile)) {
    patterns.push(...readFileSync(ignoreFile, "utf8").split("\n"));
  }
  return ignore().add(patterns);
}

interface CollectedAssets {
  config: Record<string, unknown>;
  binding: string | null;
  files: Array<CollectedFile & { route: string }>;
}

/** Collects static assets from `assets.directory`, honoring `.assetsignore`. */
function collectAssets(
  config: ResolvedWranglerConfig,
  configDir: string,
  logger: (m: string) => void,
): CollectedAssets {
  const assets = config.assets;
  if (!assets?.directory) {
    return { config: {}, binding: null, files: [] };
  }
  const dir = path.resolve(configDir, assets.directory);
  if (!existsSync(dir)) {
    throw new Error(`assets.directory does not exist: ${dir}`);
  }
  const matcher = buildAssetIgnore(dir);
  const entries = readdirSync(dir, { recursive: true }) as string[];
  const files: CollectedAssets["files"] = [];
  for (const rel of entries) {
    const relPosix = rel.split(path.sep).join("/");
    if (matcher.ignores(relPosix)) {
      continue;
    }
    const abs = path.join(dir, rel);
    // lstat (not stat) so the symlink decision is real: stat() follows links, so
    // its isSymbolicLink() is always false and a broken link throws. wrangler's
    // asset walker intends to skip symlinks; do so explicitly, and skip dirs.
    const info = lstatSync(abs);
    if (info.isSymbolicLink()) {
      logger(`skipping symlinked asset: ${relPosix}`);
      continue;
    }
    if (info.isDirectory()) {
      continue;
    }
    files.push({
      route: `/${relPosix}`,
      name: relPosix,
      path: `assets/${relPosix}`,
      bytes: readFileSync(abs),
    });
  }
  files.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));

  const cfg: Record<string, unknown> = {};
  if (assets.html_handling !== undefined) {
    cfg.html_handling = assets.html_handling;
  }
  if (assets.not_found_handling !== undefined) {
    cfg.not_found_handling = assets.not_found_handling;
  }
  if (assets.run_worker_first !== undefined) {
    cfg.run_worker_first = assets.run_worker_first;
  }
  return { config: cfg, binding: assets.binding ?? null, files };
}

/** Collects D1 migration `.sql` files per D1 binding, sorted by filename. */
function collectD1Migrations(
  config: ResolvedWranglerConfig,
  configDir: string,
): Record<string, CollectedFile[]> {
  const result: Record<string, CollectedFile[]> = {};
  for (const d1 of config.d1_databases ?? []) {
    const dirName = d1.migrations_dir ?? "migrations";
    const dir = path.resolve(configDir, dirName);
    const files: CollectedFile[] = [];
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      const names = readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".sql"))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const name of names) {
        const abs = path.join(dir, name);
        if (statSync(abs).isFile()) {
          files.push({ name, path: `d1/${d1.binding}/${name}`, bytes: readFileSync(abs) });
        }
      }
    }
    result[d1.binding] = files;
  }
  return result;
}

/** Reads the commit date (YYYYMMDD) of HEAD, or null when `dir` is not a git repo. */
function gitCommitDate(dir: string, childEnv: NodeJS.ProcessEnv): string | null {
  const res = spawnSync(
    "git",
    ["-C", dir, "show", "-s", "--format=%cd", "--date=format:%Y%m%d", "HEAD"],
    { encoding: "utf8", env: childEnv },
  );
  if (res.status === 0) {
    const out = res.stdout.trim();
    if (/^\d{8}$/.test(out)) {
      return out;
    }
  }
  return null;
}

/** Signs the exact manifest bytes with the base64 PKCS#8 Ed25519 key. */
async function signManifest(manifestBytes: Uint8Array, keyBase64: string): Promise<string> {
  const pkcs8 = Buffer.from(keyBase64, "base64");
  const key = await webcrypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, [
    "sign",
  ]);
  const sig = await webcrypto.subtle.sign({ name: "Ed25519" }, key, manifestBytes);
  return Buffer.from(new Uint8Array(sig)).toString("base64");
}

function packerVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/**
 * Packs a wrangler project checkout into a signed artifact.
 * Writes `<slug>-<version>.zip`, `manifest.json`, and (when signing)
 * `manifest.sig` into `outDir`.
 */
export async function pack(options: PackOptions): Promise<PackResult> {
  const env = options.env ?? process.env;
  const install = options.install ?? true;
  const logger = options.logger ?? (() => {});
  const checkoutDir = path.resolve(options.checkoutDir);

  if (options.signKeyEnv && !options.keyId) {
    throw new Error("--key-id is required when signing (--sign-key-env)");
  }

  // Resolve the signing key up front so a bad/empty key fails before any work or
  // any file is written (a failed pack must leave nothing behind).
  let signKeyBase64: string | undefined;
  if (options.signKeyEnv) {
    signKeyBase64 = env[options.signKeyEnv];
    if (!signKeyBase64) {
      throw new Error(`sign key env var ${options.signKeyEnv} is not set`);
    }
  }
  // The key has been read; no child process (install, dry-run, the checkout's
  // build.command, git) may see it or any other credential.
  const childEnv = scrubEnv(env, options.signKeyEnv ? [options.signKeyEnv] : []);

  // (a) Parse + validate the catalog manifest.
  const catalog: CatalogManifest = catalogManifestSchema.parse(
    parseJsonc(readFileSync(path.resolve(options.manifestPath), "utf8")),
  );

  // (b) Install dependencies unless disabled.
  if (install) {
    runInstall(checkoutDir, catalog.install.packageManager, childEnv, logger);
  }

  // (c) Read the resolved wrangler config with wrangler's own reader.
  const wranglerConfigPath = path.resolve(checkoutDir, catalog.install.wranglerConfig);
  const config = unstable_readConfig({ config: wranglerConfigPath }) as ResolvedWranglerConfig;
  const configDir = path.dirname(config.configPath ?? wranglerConfigPath);

  if (!config.main) {
    throw new Error("wrangler config has no `main` entrypoint");
  }
  if (!config.name) {
    throw new Error("wrangler config has no `name`");
  }
  if (!config.compatibility_date) {
    throw new Error("wrangler config has no `compatibility_date`");
  }

  // (d) Bundle the worker via a scrubbed dry-run into a temp outdir.
  const outdir = mkdtempSync(path.join(tmpdir(), "appflare-pack-"));
  let modules: CollectedModule[];
  try {
    runDryRun(wranglerConfigPath, checkoutDir, outdir, childEnv, logger);
    // (e) Collect emitted modules.
    modules = collectModules(outdir, config);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }

  // (f) Static assets and (g) D1 migrations.
  const assets = collectAssets(config, configDir, logger);
  const d1 = collectD1Migrations(config, configDir);

  // Lay the zip out so byte offsets are recorded as each file is added. Order:
  // worker/, assets/, d1/, then manifest.json LAST.
  const zip = new ZipStore();
  const moduleManifest: WorkerModule[] = modules.map((m) => {
    const { dataOffset } = zip.addFile(m.path, m.bytes);
    return {
      name: m.name,
      type: classifyModuleType(m.name, m.isMain),
      path: m.path,
      size: m.bytes.length,
      sha256: sha256Hex(m.bytes),
      offset: dataOffset,
    };
  });
  const assetManifest: AssetFile[] = assets.files.map((a) => {
    const { dataOffset } = zip.addFile(a.path, a.bytes);
    return {
      route: a.route,
      // BLAKE3 asset id for the upload session; sha256 for Range-slice integrity.
      hash: assetHash(a.bytes, a.name),
      path: a.path,
      size: a.bytes.length,
      sha256: sha256Hex(a.bytes),
      offset: dataOffset,
    };
  });
  const d1Manifest: Record<string, D1MigrationFile[]> = {};
  for (const [binding, files] of Object.entries(d1)) {
    d1Manifest[binding] = files.map((f) => {
      const { dataOffset } = zip.addFile(f.path, f.bytes);
      return {
        name: f.name,
        path: f.path,
        size: f.bytes.length,
        sha256: sha256Hex(f.bytes),
        offset: dataOffset,
      };
    });
  }

  // (h) Record the stripped worker config.
  const mainModule = modules.find((m) => m.isMain)?.name;
  if (!mainModule) {
    throw new Error("internal error: no main module identified");
  }
  const version = deriveVersion({
    ref: catalog.source.ref,
    sha: catalog.source.sha,
    commitDate: gitCommitDate(checkoutDir, childEnv),
    buildDate: formatBuildDate(new Date()),
  });

  // (i) Assemble + validate the manifest.
  const manifestInput = {
    format: 1 as const,
    app: catalog.slug,
    version,
    source: { repo: catalog.repo, sha: catalog.source.sha, ref: catalog.source.ref },
    builtAt: new Date().toISOString(),
    builder: `@appflare/pack@${packerVersion()}`,
    keyId: options.keyId ?? "unsigned",
    worker: {
      name: config.name,
      mainModule,
      compatibilityDate: config.compatibility_date,
      compatibilityFlags: config.compatibility_flags ?? [],
      modules: moduleManifest,
      bindings: collectBindings(config),
      migrations: (config.migrations ?? []) as DoMigration[],
      crons: config.triggers?.crons ?? [],
      observability: config.observability ?? null,
      placement: config.placement ?? null,
      limits: config.limits ?? null,
    },
    assets: { config: assets.config, binding: assets.binding, files: assetManifest },
    d1Migrations: d1Manifest,
    catalog,
  };
  const manifest = artifactManifestSchema.parse(manifestInput);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // (j) manifest.json is the LAST zip entry: its bytes carry every other file's
  // offset, so it cannot record its own, and appending it last keeps all other
  // offsets stable.
  zip.addFile("manifest.json", manifestBytes);
  const zipBytes = zip.finish();

  // (k) Sign the exact manifest.json bytes (key already resolved above).
  const signature =
    signKeyBase64 !== undefined ? await signManifest(manifestBytes, signKeyBase64) : null;

  // Write everything into a staging dir beside `outDir`, then rename into place at
  // the very end. A failure anywhere above leaves `outDir` untouched, and the
  // rename is atomic on the same filesystem.
  const outDir = path.resolve(options.outDir);
  const zipName = `${catalog.slug}-${version}.zip`;
  mkdirSync(path.dirname(outDir), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(outDir), ".appflare-pack-out-"));
  let signaturePath: string | null = null;
  const zipPath = path.join(outDir, zipName);
  const manifestJsonPath = path.join(outDir, "manifest.json");
  try {
    writeFileSync(path.join(staging, zipName), zipBytes);
    writeFileSync(path.join(staging, "manifest.json"), manifestBytes);
    if (signature !== null) {
      writeFileSync(path.join(staging, "manifest.sig"), `${signature}\n`);
    }
    mkdirSync(outDir, { recursive: true });
    renameSync(path.join(staging, zipName), zipPath);
    renameSync(path.join(staging, "manifest.json"), manifestJsonPath);
    if (signature !== null) {
      signaturePath = path.join(outDir, "manifest.sig");
      renameSync(path.join(staging, "manifest.sig"), signaturePath);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  const d1MigrationCount = Object.values(d1Manifest).reduce((n, f) => n + f.length, 0);
  logger(
    `packed ${catalog.slug}@${version}: ${moduleManifest.length} modules, ` +
      `${assetManifest.length} assets, ${d1MigrationCount} migrations, ${zipBytes.length} bytes`,
  );

  return {
    manifest,
    zipPath,
    manifestJsonPath,
    signaturePath,
    slug: catalog.slug,
    version,
    moduleCount: moduleManifest.length,
    assetCount: assetManifest.length,
    d1MigrationCount,
    zipSize: zipBytes.length,
  };
}
