import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetHash } from "@appflare/cf-api";
import {
  type ArtifactD1,
  type ArtifactManifest,
  type AssetFile,
  appWorkers,
  assetsOnlyWorkerProblems,
  boundToWorker,
  buildCommandList,
  type CatalogManifest,
  catalogVarProblems,
  catalogWorkerName,
  type D1MigrationFile,
  type DoMigration,
  installDirList,
  LATEST_ARTIFACT_FORMAT,
  secretTargets,
  strictArtifactManifestSchema,
  type WorkerModule,
  workerManifest,
  workersPaidBindingProblem,
  workerUploadProblem,
} from "@appflare/schema";
import ignore from "ignore";
import { unstable_readConfig } from "wrangler";
import { DEFAULT_BUILD_TIMEOUT_MS, runBuildCommands } from "./build-command.ts";
import { applyConfigPatches, workerSpecs, writeInlineConfigs } from "./config-patch.ts";
import {
  checkoutRelative,
  copyTemplateConfig,
  dryRunInvocation,
  readConfigArgs,
  resolveWranglerConfig,
  type WranglerConfigTarget,
} from "./config-redirect.ts";
import { collectD1Extras, collectD1Migrations, type D1Files } from "./d1-layout.ts";
import { installDependencies } from "./install.ts";
import { issueLines, readCatalogManifest } from "./manifest.ts";
import { scrubEnv } from "./scrub-env.ts";
import { seedOnlyConfigProblems, seedStatementCount } from "./seed.ts";
import { signBytes, UNSIGNED_KEY_ID } from "./signing.ts";
import { deriveVersionWithOrigin, formatBuildDate, type VersionOrigin } from "./version.ts";
import { type WorkerSize, workerSize } from "./worker-size.ts";
import {
  allowedSections,
  checkHyperdriveDeclarations,
  checkPipelineDeclarations,
  checkR2Declarations,
  checkVectorizeDeclarations,
  classifyModuleType,
  collectBindings,
  collectQueueConsumers,
  collectWorkerSettings,
  mainModuleName,
  queueProducerBindings,
  type ResolvedWranglerConfig,
  unsupportedWranglerSections,
  uploadPlacement,
  varPlaceholderProblems,
  withoutSecretVars,
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
  /**
   * Install the checkout's dependencies first: each directory of
   * `install.installDirs` in order, the root when it lists none. Default true.
   */
  install?: boolean;
  /** Name of the env var holding the base64 PKCS#8 Ed25519 private key. */
  signKeyEnv?: string;
  /** Key id recorded in `manifest.keyId`. Required when signing. */
  keyId?: string;
  /** Environment source (for reading the sign key and spawning). Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Optional progress logger. */
  logger?: (message: string) => void;
  /** How long the catalog manifest's `install.buildCommand` may run, all its commands together. Default 15 minutes. */
  buildTimeoutMs?: number;
  /**
   * Wrangler config sections the packer refuses that these configs may
   * declare anyway (`UNSUPPORTED_WRANGLER_SECTIONS` keys, `pipelines` and
   * `unsafe` excepted). The artifact goes without them: this is for
   * Appflare's own release artifacts, whose deployer supplies them (the
   * manager deploys the sandbox Worker's `containers` from its own
   * definition). Catalog entries are never packed with it. Default none.
   */
  allowSections?: readonly string[];
  /**
   * The catalog manifest is the one Appflare works out for an app built from
   * a repository without a catalog entry, whose `license` may be
   * `NOASSERTION` or `SEE LICENSE IN <file>` (from its `package.json`). A
   * catalog entry names an SPDX license. Default false.
   */
  repositoryBuild?: boolean;
}

/** Result of a successful {@link pack}. */
export interface PackResult {
  manifest: ArtifactManifest;
  zipPath: string;
  manifestJsonPath: string;
  signaturePath: string | null;
  slug: string;
  version: string;
  /**
   * Which rule produced `version`: the catalog manifest's `source.version`,
   * the `source.ref` semver tag, or the pinned commit's date and SHA.
   */
  versionOrigin: VersionOrigin;
  moduleCount: number;
  assetCount: number;
  d1MigrationCount: number;
  /** Schema files (`resources.d1[binding].schema`), every binding together. */
  d1SchemaCount: number;
  /** Post-deploy migrations (`resources.d1[binding].postDeployMigrationsDir`), every binding together. */
  d1PostDeployCount: number;
  /** Baselines (`resources.d1[binding].baseline`), one per binding at most. */
  d1BaselineCount: number;
  /**
   * Seed statements (`resources.d1[binding].seed`), every binding together.
   * The artifact carries them in its embedded catalog manifest.
   */
  d1SeedCount: number;
  zipSize: number;
  /** The Worker's size, as wrangler reports it after a dry run; the primary Worker's for an app of several. */
  workerSize: WorkerSize;
  /** Every Worker packed, the primary one first: one for most apps. */
  workers: PackedWorker[];
}

/** One Worker of a packed artifact, as the pack summary reports it. */
export interface PackedWorker {
  /** Its name within the catalog entry; null for an app of one Worker. */
  name: string | null;
  primary: boolean;
  moduleCount: number;
  assetCount: number;
  workerSize: WorkerSize;
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

/**
 * Runs `wrangler deploy --dry-run --outdir` with the packer's own wrangler and a
 * scrubbed environment so nothing can reach any account. The wrangler
 * config's own `build.command`, if any, runs as part of this.
 */
function runDryRun(
  target: WranglerConfigTarget,
  checkoutDir: string,
  outdir: string,
  childEnv: NodeJS.ProcessEnv,
  logger: (m: string) => void,
): void {
  const wranglerBin = resolveWranglerBin();
  const { cwd, configArgs } = dryRunInvocation(target, checkoutDir);
  logger("running wrangler deploy --dry-run (scrubbed environment)");
  const res = spawnSync(
    process.execPath,
    [wranglerBin, "deploy", "--dry-run", "--outdir", outdir, ...configArgs],
    {
      cwd,
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

/**
 * Collects the emitted worker modules from the dry-run outdir. None for a
 * config without `main` (a Worker of static assets only): wrangler still
 * writes its no-op placeholder Worker there, which it never uploads for one.
 */
function collectModules(outdir: string, config: ResolvedWranglerConfig): CollectedModule[] {
  if (!config.main) return [];
  const all = walkFiles(outdir);
  // Skip wrangler's own README.md description and every sourcemap.
  const candidates = all.filter(
    (rel) => rel !== "README.md" && !rel.toLowerCase().endsWith(".map"),
  );
  if (candidates.length === 0) {
    throw new Error(`no worker modules were emitted to ${outdir}`);
  }
  const expected = config.main ? mainModuleName(config.main, config.no_bundle === true) : undefined;
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

/**
 * Directories never collected as static assets, at any depth, whatever
 * `.assetsignore` says: git's data, wrangler's state and the installed
 * dependencies. An assets directory of `.` (the project root) would
 * otherwise publish the repository's history and every installed package,
 * as wrangler itself does unless `.assetsignore` lists them.
 */
export const NEVER_ASSET_DIRS = [".git", ".wrangler", "node_modules"] as const;

/**
 * Every entry under `dir` (relative, platform separators, as `readdirSync`'s
 * recursive listing gives them), without descending into a
 * {@link NEVER_ASSET_DIRS} directory, and the relative paths of those it
 * left out.
 */
function walkAssetDirectory(dir: string): { entries: string[]; excluded: string[] } {
  const never = new Set<string>(NEVER_ASSET_DIRS);
  const entries: string[] = [];
  const excluded: string[] = [];
  const queue = [""];
  for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : path.join(rel, entry.name);
      if (never.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) {
        excluded.push(child.split(path.sep).join("/"));
        continue;
      }
      entries.push(child);
      if (entry.isDirectory()) queue.push(child);
    }
  }
  return { entries, excluded };
}

interface CollectedAssets {
  config: Record<string, unknown>;
  binding: string | null;
  files: Array<CollectedFile & { route: string }>;
}

/**
 * Collects static assets from `assets.directory`, honoring `.assetsignore`.
 * Their zip paths are `<prefix>assets/<path>`.
 */
function collectAssets(
  config: ResolvedWranglerConfig,
  configDir: string,
  logger: (m: string) => void,
  prefix = "",
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
  const { entries, excluded } = walkAssetDirectory(dir);
  if (excluded.length > 0) {
    logger(
      `left ${excluded.join(", ")} out of the static assets: a project's own ${NEVER_ASSET_DIRS.join(", ")} directories are never served`,
    );
  }
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
      path: `${prefix}assets/${relPosix}`,
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
  // Wrangler 4.136.2 (`getAssetsOptions`) reads `_redirects` and `_headers`
  // from the root of the assets directory, never uploads them as assets, and
  // sends their text in the upload's `assets.config`, with or without a
  // Worker; the manager sends `assets.config` as recorded.
  for (const name of ASSET_RULE_FILES) {
    const text = readAssetRuleFile(dir, name, logger);
    if (text !== undefined) cfg[name] = text;
  }
  return { config: cfg, binding: assets.binding ?? null, files };
}

/** The files at the root of the assets directory that configure it rather than being served. */
const ASSET_RULE_FILES = ["_redirects", "_headers"] as const;

/**
 * The most bytes `_redirects` or `_headers` may have. Their text goes into
 * the signed manifest, which the manager keeps in a D1 row (at most 2 MB).
 * Cloudflare applies at most 2,000 static and 100 dynamic redirects and 100
 * header rules (its Workers static assets limits); real rules are well under
 * 100 bytes a line, so a full `_redirects` is about 200 KB and a full
 * `_headers` far less. 512 KiB each is more than twice that, and both at
 * their cap still leave half of the row for the rest of the manifest.
 */
const MAX_ASSET_RULE_FILE_BYTES = 512 * 1024;

/**
 * The text of `_redirects` or `_headers` at the root of the assets
 * directory, or undefined when there is none. A symlink is skipped like a
 * symlinked asset, so a pack never reads a file outside the checkout.
 */
function readAssetRuleFile(
  dir: string,
  name: (typeof ASSET_RULE_FILES)[number],
  logger: (m: string) => void,
): string | undefined {
  const file = path.join(dir, name);
  let info: Stats;
  try {
    info = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) {
    logger(`skipping symlinked ${name}`);
    return undefined;
  }
  if (!info.isFile()) throw new Error(`the assets directory's ${name} is not a file`);
  if (info.size > MAX_ASSET_RULE_FILE_BYTES) {
    throw new Error(
      `the assets directory's ${name} is ${Math.ceil(info.size / 1024)} KiB, more than the ${MAX_ASSET_RULE_FILE_BYTES / 1024} KiB Appflare takes (far beyond the rules Cloudflare applies: 2,000 static and 100 dynamic redirects, 100 header rules); shorten it`,
    );
  }
  return readFileSync(file, "utf8");
}

/** A Worker's wrangler config as the packer reads it. */
interface ReadWorkerConfig {
  target: WranglerConfigTarget;
  /** The declared and effective config, relative to the checkout. */
  wranglerConfig: { declared: string; effective: string };
  /** `main` is undefined for a Worker of static assets only (`assets` and no `main`). */
  config: ResolvedWranglerConfig & {
    main: string | undefined;
    name: string;
    compatibility_date: string;
  };
  configDir: string;
}

/**
 * Reads the resolved wrangler config at `declared` (relative to the
 * checkout) with wrangler's own reader, following a redirect the build left,
 * as `wrangler deploy` would, or the config a catalog config patch wrote in
 * its place (`patched`). Throws when it lacks `name` or `compatibility_date`,
 * or has neither `main` nor an assets directory. A config with assets and no
 * `main` is a Worker of static assets only, packed without modules.
 */
function readWorkerConfig(
  checkoutDir: string,
  declared: string,
  logger: (m: string) => void,
  patched?: WranglerConfigTarget,
): ReadWorkerConfig {
  // A template was copied to its real name before the build; that is what wrangler reads.
  const target =
    patched ?? resolveWranglerConfig(checkoutDir, copyTemplateConfig(checkoutDir, declared));
  const wranglerConfig = {
    // The catalog's path, a template included; `effective` is what was read.
    declared: checkoutRelative(checkoutDir, path.resolve(checkoutDir, declared)),
    effective: checkoutRelative(checkoutDir, target.effectivePath),
  };
  if (target.deployConfigPath !== null) {
    logger(
      `the build redirects wrangler from ${wranglerConfig.declared} to ${wranglerConfig.effective} ` +
        `(${checkoutRelative(checkoutDir, target.deployConfigPath)}); packing that config`,
    );
  }
  const read = readConfigArgs(target);
  const config = unstable_readConfig(read.args, read.options) as ResolvedWranglerConfig;
  const readPath = config.configPath ? path.resolve(config.configPath) : target.effectivePath;
  if (readPath !== target.effectivePath) {
    throw new Error(
      `wrangler read ${readPath} instead of ${target.effectivePath}; ` +
        "a wrangler config or redirect in a parent directory of the declared config is in the way",
    );
  }
  const { name, compatibility_date } = config;
  const main = config.main || undefined;
  if (main === undefined && !config.assets?.directory) {
    throw new Error(
      `wrangler config ${wranglerConfig.declared} has no \`main\` entrypoint and no \`assets.directory\``,
    );
  }
  if (main === undefined) {
    logger(
      `wrangler config ${wranglerConfig.declared} has no \`main\`: the Worker serves its static assets only`,
    );
  }
  if (!name) {
    throw new Error(`wrangler config ${wranglerConfig.declared} has no \`name\``);
  }
  if (!compatibility_date) {
    throw new Error(`wrangler config ${wranglerConfig.declared} has no \`compatibility_date\``);
  }
  return {
    target,
    wranglerConfig,
    config: { ...config, main, name, compatibility_date },
    configDir: path.dirname(target.effectivePath),
  };
}

/** Bundles one Worker with a scrubbed dry run into a temp outdir and collects its modules. */
function bundleWorker(
  target: WranglerConfigTarget,
  checkoutDir: string,
  config: ResolvedWranglerConfig,
  childEnv: NodeJS.ProcessEnv,
  logger: (m: string) => void,
): CollectedModule[] {
  const outdir = mkdtempSync(path.join(tmpdir(), "appflare-pack-"));
  try {
    runDryRun(target, checkoutDir, outdir, childEnv, logger);
    return collectModules(outdir, config);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

/**
 * The D1 migrations of every Worker of the app, by binding. Workers that bind
 * one name share one database, so they must bring the same migration files
 * (or none); a Worker that brings none takes the others'.
 */
export function mergeD1Migrations(
  workers: ReadonlyArray<{ worker: string; d1: D1Files }>,
): D1Files {
  const merged: D1Files = {};
  const from: Record<string, string> = {};
  const key = (files: D1Files[string]) =>
    files.map((f) => `${f.name}:${sha256Hex(f.bytes)}`).join("\n");
  for (const { worker, d1 } of workers) {
    for (const [binding, files] of Object.entries(d1)) {
      const seen = Object.hasOwn(merged, binding) ? merged[binding] : undefined;
      if (seen === undefined || (seen.length === 0 && files.length > 0)) {
        merged[binding] = files;
        from[binding] = worker;
      } else if (files.length > 0 && key(seen) !== key(files)) {
        throw new Error(
          `the Workers "${from[binding]}" and "${worker}" bind the D1 database ${binding} with different migrations; ` +
            "Workers that bind one name share one database, so point both configs' migrations_dir at the same files",
        );
      }
    }
  }
  return merged;
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

function packerVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/**
 * Packs a wrangler project checkout into an artifact. Writes
 * `<slug>-<version>.zip`, `manifest.json`, and (when signing) `manifest.sig` into
 * `outDir`. With `keyId` but no `signKeyEnv` it produces an "unsigned
 * intermediate": `manifest.keyId` is set but no signature is written, so a
 * separate job that never runs app code can sign it later with `sign()` (sign.ts).
 */
export async function pack(options: PackOptions): Promise<PackResult> {
  const env = options.env ?? process.env;
  const install = options.install ?? true;
  const logger = options.logger ?? (() => {});
  const checkoutDir = path.resolve(options.checkoutDir);

  if (options.signKeyEnv && !options.keyId) {
    throw new Error("--key-id is required when signing (--sign-key-env)");
  }
  if (options.keyId === UNSIGNED_KEY_ID) {
    throw new Error(
      `--key-id "${UNSIGNED_KEY_ID}" is reserved for artifacts packed without a key id`,
    );
  }
  // Checked before any work, so a misspelt section fails at once.
  const allowSections = allowedSections(options.allowSections ?? []);

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

  // (a) Parse + validate the catalog manifest, strictly: a key the schema
  // does not know (a misspelling) refuses the pack, naming its path.
  const catalog: CatalogManifest = readCatalogManifest(
    readFileSync(path.resolve(options.manifestPath), "utf8"),
    { repositoryBuild: options.repositoryBuild === true },
  );

  // (a2) A config kept as a template (`wrangler.toml.example`) gets its real
  // name first, so the build and wrangler's reader both find it: the
  // entry's config, and each Worker's of an app of several Workers.
  const declaredConfigs = [
    ...new Set([
      catalog.install.wranglerConfig,
      ...(catalog.install.workers ?? []).map((w) => w.wranglerConfig),
    ]),
  ];
  for (const declared of declaredConfigs) {
    const real = copyTemplateConfig(checkoutDir, declared);
    if (real !== declared) {
      logger(`copied the wrangler config template ${declared} to ${real}`);
    }
  }
  // An entry whose repository ships no config carries one inline: written
  // now, so the install and the build see it as they would a config of the
  // repository's, and again after the build (b4).
  const specs = workerSpecs(catalog.install);
  const inlineOptions = { checkoutDir, specs, workerName: catalogWorkerName(catalog), logger };
  writeInlineConfigs(inlineOptions);

  // (b) Install dependencies unless disabled.
  // Each directory of `install.installDirs` in order, the root when it lists none.
  if (install) {
    installDependencies({
      checkoutDir,
      installDirs: installDirList(catalog.install),
      packageManager: catalog.install.packageManager,
      env: childEnv,
      logger,
    });
  }

  // (b2) The catalog's build commands, in order, before the wrangler config is
  // read: the config may be a file the build writes. The build-time
  // constants reach them and wrangler's bundling (a wrangler config's own
  // `build.command` runs there); the artifact carries them in its catalog
  // manifest, so a later pack of the same pin builds with the same ones.
  const buildEnv = catalog.install.buildEnv;
  const buildChildEnv: NodeJS.ProcessEnv =
    buildEnv === undefined ? childEnv : { ...childEnv, ...buildEnv };
  if (buildEnv !== undefined) {
    logger(
      `build-time constants from install.buildEnv: ${Object.keys(buildEnv).join(", ")} ` +
        "(set for the build commands and the bundling; the artifact's catalog manifest records their values)",
    );
  }
  const buildCommands = buildCommandList(catalog.install.buildCommand);
  if (buildCommands.length > 0 && installDirList(catalog.install).length === 0) {
    logger("the build commands run with no dependencies installed (install.installDirs is empty)");
  }
  if (buildCommands.length > 0) {
    await runBuildCommands({
      checkoutDir,
      commands: buildCommands,
      env: childEnv,
      buildEnv,
      timeoutMs: options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      logger,
    });
  }

  // (b3) An app of several Workers: each Worker's own build commands, in the
  // entry's order, after the shared ones and before any config is read.
  const entry = catalog.install.workers;
  for (const spec of entry ?? []) {
    const commands = buildCommandList(spec.buildCommand);
    if (commands.length === 0) continue;
    logger(`building the Worker "${spec.name}"`);
    await runBuildCommands({
      checkoutDir,
      commands,
      env: childEnv,
      buildEnv,
      timeoutMs: options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      logger,
    });
  }

  // (b4) The catalog's config patches, after the build (which may write the
  // config) and before wrangler reads anything: each patched config is
  // written beside its original, and wrangler reads and bundles that one.
  // An inline config is checked again: the build may have left a config or
  // a redirect beside it.
  writeInlineConfigs(inlineOptions);
  const patched = applyConfigPatches({ checkoutDir, specs, logger });

  // (c) Read every resolved wrangler config with wrangler's own reader,
  // following a redirect the build left, as `wrangler deploy` would.
  const read = specs.map((spec) => ({
    name: spec.name,
    primary: spec.primary,
    ...readWorkerConfig(checkoutDir, spec.wranglerConfig, logger, patched.get(spec.wranglerConfig)),
  }));
  // Where a config names another Worker of the entry, by its wrangler name.
  const entryNames = new Map<string, string>();
  for (const r of read) {
    if (r.name === null) continue;
    const other = entryNames.get(r.config.name);
    if (other !== undefined) {
      throw new Error(
        `the wrangler configs of the Workers "${other}" and "${r.name}" both name their Worker "${r.config.name}"`,
      );
    }
    entryNames.set(r.config.name, r.name);
  }
  // Queue names are the account's: a queue one Worker sends to and another
  // consumes is one queue, known by the producer binding.
  const producers = queueProducerBindings(read.map((r) => r.config));
  // A name is a var or a secret, never both. The schema refuses it already;
  // this holds if that check ever moves.
  const secretNames = new Set(catalog.secrets.map((s) => s.name));
  const clashing = catalog.vars.filter((v) => secretNames.has(v.name)).map((v) => v.name);
  if (clashing.length > 0) {
    throw new Error(
      `the catalog manifest declares ${clashing.join(", ")} both as a secret and as a var; ` +
        "a Worker cannot have a secret and a var of one name, so keep one of them",
    );
  }
  // Before bundling, so a missing Vectorize declaration fails fast.
  const collected = read.map((r) => {
    const all = collectBindings(r.config, catalog.resources, {
      entryWorkers: r.name === null ? undefined : entryNames,
      checkUnboundVectorize: entry === undefined,
      allowSections,
    });
    for (const key of unsupportedWranglerSections(r.config)) {
      if (allowSections.includes(key)) {
        logger(
          `left ${key} out of the artifact${r.name === null ? "" : ` of the Worker "${r.name}"`}, as allowed`,
        );
      }
    }
    // A var of the name of a secret this Worker gets is left out. A
    // seed-only secret is never set on a Worker, so it takes no var's place.
    const secrets = boundToWorker(catalog.secrets)
      .filter((s) => r.name === null || secretTargets(s, catalog).includes(r.name))
      .map((s) => s.name);
    const of = r.name === null ? "" : ` of the Worker "${r.name}"`;
    const seedOnly = seedOnlyConfigProblems(
      catalog,
      { bindings: all, requiredSecrets: r.config.secrets?.required ?? [] },
      of,
    );
    if (seedOnly.length > 0) throw new Error(seedOnly.join("; "));
    const { bindings, dropped } = withoutSecretVars(all, secrets);
    for (const name of dropped) {
      logger(
        `var ${name} is provided as a secret: the catalog manifest declares ${name} as a secret, ` +
          `so the wrangler config's var of that name${of} is left out`,
      );
    }
    for (const name of r.config.secrets?.required ?? []) {
      if (!secrets.includes(name)) {
        logger(
          `the wrangler config${of} requires the secret ${name} (secrets.required), which the catalog manifest does not declare`,
        );
      }
    }
    const placeholders = varPlaceholderProblems(bindings, { workers: entry });
    if (placeholders.length > 0) {
      throw new Error(
        `${r.name === null ? "" : `The Worker "${r.name}": `}${placeholders.join(" ")}`,
      );
    }
    return { ...r, bindings, queueConsumers: collectQueueConsumers(r.config, producers) };
  });
  if (entry !== undefined) {
    checkVectorizeDeclarations(
      collected.flatMap((c) => c.bindings),
      catalog.resources,
    );
    checkHyperdriveDeclarations(
      collected.flatMap((c) => c.bindings),
      catalog.resources,
    );
    checkPipelineDeclarations(
      collected.flatMap((c) => c.bindings),
      catalog.resources,
    );
    checkR2Declarations(
      collected.flatMap((c) => c.bindings),
      catalog.resources,
    );
  } else {
    const varProblems = catalogVarProblems(collected[0]?.bindings ?? [], catalog.vars);
    if (varProblems.length > 0) {
      throw new Error(varProblems.join(" "));
    }
  }
  // A Worker of static assets only has no code to use bindings, secrets,
  // vars, crons or Durable Objects: refused before anything is built.
  for (const c of collected) {
    if (c.config.main !== undefined) continue;
    const secrets = boundToWorker(catalog.secrets).filter(
      (s) => c.name === null || secretTargets(s, catalog).includes(c.name),
    );
    // Vars of an entry of several Workers go where `varTargets` sends them,
    // which the artifact's own check holds once the manifest is assembled.
    const vars = boundToWorker(catalog.vars).filter(
      (v) => c.name === null || v.workers?.includes(c.name) === true,
    );
    const { exports } = collectWorkerSettings(c.config);
    const problems = assetsOnlyWorkerProblems(
      {
        modules: [],
        bindings: c.bindings,
        migrations: c.config.migrations ?? [],
        crons: c.config.triggers?.crons ?? [],
        queueConsumers: c.queueConsumers,
        exports,
      },
      {
        binding: c.config.assets?.binding ?? null,
        config: { run_worker_first: c.config.assets?.run_worker_first },
      },
      { secrets, vars },
      c.name === null ? "The Worker" : `The Worker "${c.name}"`,
    );
    if (problems.length > 0) throw new Error(problems.join(" "));
  }

  // A Worker Loader makes the app a Workers Paid app; the catalog must say so.
  const planProblem = workersPaidBindingProblem(
    collected.flatMap((c) => c.bindings),
    catalog.plan,
  );
  if (planProblem !== null) throw new Error(planProblem);

  // (c2) The D1 SQL, before bundling so a refused schema file fails fast:
  // each Worker's migrations (Workers that bind one name share one
  // database, so they must bring the same files), then the schema files and
  // post-deploy migrations the catalog manifest declares.
  const declaredD1 = catalog.resources?.d1;
  const d1 = mergeD1Migrations(
    read.map((r) => ({
      worker: r.name ?? r.config.name,
      // `migrations_dir` is relative to the declared config, as `wrangler d1
      // migrations apply` reads it, else to the config the build redirected to.
      d1: collectD1Migrations(
        r.config,
        [...new Set([path.dirname(r.target.declaredPath), r.configDir])],
        checkoutDir,
        declaredD1,
      ),
    })),
  );
  const boundD1 = new Set(read.flatMap((r) => (r.config.d1_databases ?? []).map((d) => d.binding)));
  const d1Extras = collectD1Extras(checkoutDir, declaredD1, boundD1, d1);

  // (d) Bundle each Worker via a scrubbed dry-run, then collect (e) its
  // modules and (f) its static assets. The primary Worker's files keep the
  // paths of a one-Worker artifact; every other Worker's go under
  // `workers/<name>/`.
  const built = collected.map((c) => {
    if (c.name !== null) logger(`bundling the Worker "${c.name}"`);
    const prefix = c.primary || c.name === null ? "" : `workers/${c.name}/`;
    const modules = bundleWorker(c.target, checkoutDir, c.config, buildChildEnv, logger).map(
      (m) => ({
        ...m,
        path: `${prefix}${m.path}`,
      }),
    );
    return {
      ...c,
      modules,
      assets: collectAssets(c.config, c.configDir, logger, prefix),
    };
  });

  // Lay the zip out so byte offsets are recorded as each file is added. Order:
  // worker/, assets/, each other Worker's workers/<name>/, the D1
  // migrations (d1/), schema files (d1-schema/), post-deploy migrations
  // (d1-post-deploy/) and baselines (d1-baseline/), then manifest.json LAST.
  const zip = new ZipStore();
  const ordered = [...built.filter((b) => b.primary), ...built.filter((b) => !b.primary)];
  const sections = ordered.map((b) => {
    const moduleManifest: WorkerModule[] = b.modules.map((m) => {
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
    const assetManifest: AssetFile[] = b.assets.files.map((a) => {
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
    // (h) Record the stripped worker config.
    const mainModule = b.modules.find((m) => m.isMain)?.name;
    const assetsOnly = b.config.main === undefined;
    if (!mainModule && !assetsOnly) {
      throw new Error("internal error: no main module identified");
    }
    // Wrangler uploads a Worker of static assets only with its assets and
    // compatibility settings alone; what it leaves out is not recorded.
    const settings = assetsOnly ? {} : collectWorkerSettings(b.config);
    const unsent = assetsOnly
      ? (["observability", "placement", "limits", "cache"] as const).filter(
          (key) => b.config[key] != null,
        )
      : [];
    if (unsent.length > 0) {
      logger(
        `the wrangler config sets ${unsent.join(", ")}, which a Worker of static assets only is uploaded without; left out`,
      );
    }
    return {
      name: b.name,
      primary: b.primary,
      size: workerSize(
        b.modules.map((m) => m.bytes),
        moduleManifest,
      ),
      worker: {
        name: b.config.name,
        wranglerConfig: b.wranglerConfig,
        ...(mainModule === undefined ? {} : { mainModule }),
        compatibilityDate: b.config.compatibility_date,
        compatibilityFlags: b.config.compatibility_flags ?? [],
        modules: moduleManifest,
        bindings: b.bindings,
        migrations: (b.config.migrations ?? []) as DoMigration[],
        crons: b.config.triggers?.crons ?? [],
        ...(b.queueConsumers.length > 0 ? { queueConsumers: b.queueConsumers } : {}),
        observability: assetsOnly ? null : (b.config.observability ?? null),
        placement: assetsOnly ? null : uploadPlacement(b.config.placement),
        limits: assetsOnly ? null : (b.config.limits ?? null),
        ...settings,
      },
      assets: { config: b.assets.config, binding: b.assets.binding, files: assetManifest },
    };
  });
  const placeD1 = (files: D1Files): Record<string, D1MigrationFile[]> =>
    Object.fromEntries(
      Object.entries(files).map(([binding, list]) => [
        binding,
        list.map((f) => {
          const { dataOffset } = zip.addFile(f.path, f.bytes);
          return {
            name: f.name,
            path: f.path,
            size: f.bytes.length,
            sha256: sha256Hex(f.bytes),
            offset: dataOffset,
          };
        }),
      ]),
    );
  const d1Migrations = placeD1(d1);
  const d1Schema = placeD1(d1Extras.schema);
  const d1PostDeploy = placeD1(d1Extras.postDeploy);
  const d1Baseline = placeD1(d1Extras.baseline);

  const { version, origin: versionOrigin } = deriveVersionWithOrigin({
    sourceVersion: catalog.source.version,
    ref: catalog.source.ref,
    sha: catalog.source.sha,
    commitDate: gitCommitDate(checkoutDir, childEnv),
    buildDate: formatBuildDate(new Date()),
  });

  // (i) Assemble + validate the manifest: the primary Worker as `worker`
  // and, for an app of several, the others in `workers`. Checked strictly,
  // so a field the schema does not know never reaches a signed artifact.
  const primarySection = sections[0];
  if (primarySection === undefined) {
    throw new Error("internal error: no Worker was packed");
  }
  const others =
    entry === undefined
      ? undefined
      : sections
          .filter((s) => !s.primary)
          .map((s) => ({ name: s.name, worker: s.worker, assets: s.assets }));
  const assembled = strictArtifactManifestSchema.safeParse({
    format: LATEST_ARTIFACT_FORMAT,
    app: catalog.slug,
    version,
    builtAt: new Date().toISOString(),
    builder: `@appflare/pack@${packerVersion()}`,
    keyId: options.keyId ?? UNSIGNED_KEY_ID,
    worker: primarySection.worker,
    assets: primarySection.assets,
    ...(others === undefined ? {} : { workers: others }),
    d1: artifactD1({
      migrations: d1Migrations,
      schema: d1Schema,
      postDeploy: d1PostDeploy,
      baseline: d1Baseline,
    }),
    catalog,
  });
  if (!assembled.success) {
    throw new Error(`the artifact manifest is not valid:\n${issueLines(assembled.error.issues)}`);
  }
  const manifest = assembled.data;
  if (entry !== undefined) {
    // Each Worker against the catalog vars it gets.
    const varProblems = appWorkers(manifest).flatMap((w) =>
      catalogVarProblems(w.worker.bindings, workerManifest(manifest, w).catalog.vars),
    );
    if (varProblems.length > 0) {
      throw new Error(varProblems.join(" "));
    }
  }
  // An artifact the manager could never upload is refused here, before
  // anything is written, rather than at install.
  const uploadProblems = sections.flatMap(
    (s) =>
      workerUploadProblem(
        s.worker.modules,
        s.primary
          ? `${catalog.slug}@${version}`
          : `The Worker "${s.name}" of ${catalog.slug}@${version}`,
      ) ?? [],
  );
  if (uploadProblems.length > 0) {
    throw new Error(
      `${uploadProblems.join(" ")} Appflare could not install or update it, so nothing was written.`,
    );
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  // (j) manifest.json is the LAST zip entry: its bytes carry every other file's
  // offset, so it cannot record its own, and appending it last keeps all other
  // offsets stable.
  zip.addFile("manifest.json", manifestBytes);
  const zipBytes = zip.finish();

  // (k) Sign the exact manifest.json bytes (key already resolved above).
  const signature =
    signKeyBase64 !== undefined ? await signBytes(manifestBytes, signKeyBase64) : null;

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

  const count = (files: Record<string, D1MigrationFile[]>) =>
    Object.values(files).reduce((n, f) => n + f.length, 0);
  const d1MigrationCount = count(d1Migrations);
  const d1SchemaCount = count(d1Schema);
  const d1PostDeployCount = count(d1PostDeploy);
  const d1BaselineCount = count(d1Baseline);
  const d1SeedCount = seedStatementCount(catalog);
  const size = primarySection.size;
  const workers: PackedWorker[] = sections.map((s) => ({
    name: s.name,
    primary: s.primary,
    moduleCount: s.worker.modules.length,
    assetCount: s.assets.files.length,
    workerSize: s.size,
  }));
  const moduleCount = workers.reduce((n, w) => n + w.moduleCount, 0);
  const assetCount = workers.reduce((n, w) => n + w.assetCount, 0);
  logger(
    `packed ${catalog.slug}@${version} (${describeVersionOrigin(versionOrigin)}): ` +
      `${workers.length > 1 ? `${workers.length} Workers, ` : ""}${moduleCount} modules, ` +
      `${assetCount} assets, ${d1MigrationCount} migrations, ` +
      (d1SchemaCount > 0 ? `${d1SchemaCount} schema files, ` : "") +
      (d1PostDeployCount > 0 ? `${d1PostDeployCount} post-deploy migrations, ` : "") +
      (d1BaselineCount > 0 ? `${d1BaselineCount} baselines (run once at install), ` : "") +
      (d1SeedCount > 0 ? `${d1SeedCount} seed statements (run once at install), ` : "") +
      `${zipBytes.length} bytes`,
  );

  return {
    manifest,
    zipPath,
    manifestJsonPath,
    signaturePath,
    slug: catalog.slug,
    version,
    versionOrigin,
    moduleCount: primarySection.worker.modules.length,
    assetCount: primarySection.assets.files.length,
    d1MigrationCount,
    d1SchemaCount,
    d1PostDeployCount,
    d1BaselineCount,
    d1SeedCount,
    zipSize: zipBytes.length,
    workerSize: size,
    workers,
  };
}

/**
 * The artifact's `d1`: for every binding with SQL, its migrations, schema
 * files, post-deploy migrations and baseline. A binding the wrangler config
 * binds without migrations keeps its empty list.
 */
export function artifactD1(files: {
  migrations: Record<string, D1MigrationFile[]>;
  schema: Record<string, D1MigrationFile[]>;
  postDeploy: Record<string, D1MigrationFile[]>;
  baseline: Record<string, D1MigrationFile[]>;
}): ArtifactD1 {
  const of = (record: Record<string, D1MigrationFile[]>, binding: string) =>
    (Object.hasOwn(record, binding) ? record[binding] : undefined) ?? [];
  const bindings = new Set(
    [files.migrations, files.schema, files.postDeploy, files.baseline].flatMap(Object.keys),
  );
  const d1: ArtifactD1 = {};
  for (const binding of bindings) {
    const baseline = of(files.baseline, binding)[0];
    d1[binding] = {
      migrations: of(files.migrations, binding),
      schema: of(files.schema, binding),
      postDeploy: of(files.postDeploy, binding),
      ...(baseline === undefined ? {} : { baseline }),
    };
  }
  return d1;
}

/** How the pack summary names where the version came from. */
export function describeVersionOrigin(origin: VersionOrigin): string {
  switch (origin) {
    case "source.version":
      return "version from source.version in the catalog manifest";
    case "tag":
      return "version from the source.ref tag";
    case "commit":
      return "version from the pinned commit's date and SHA";
  }
}
