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
  appWorkers,
  artifactManifestSchema,
  buildCommandList,
  type CatalogManifest,
  catalogManifestSchema,
  catalogVarProblems,
  type D1MigrationFile,
  type DoMigration,
  installDirList,
  type WorkerModule,
  workerManifest,
  workerUploadProblem,
} from "@appflare/schema";
import ignore from "ignore";
import { unstable_readConfig } from "wrangler";
import { DEFAULT_BUILD_TIMEOUT_MS, runBuildCommands } from "./build-command.ts";
import {
  checkoutRelative,
  copyTemplateConfig,
  dryRunInvocation,
  readConfigArgs,
  resolveWranglerConfig,
  type WranglerConfigTarget,
} from "./config-redirect.ts";
import { installDependencies } from "./install.ts";
import { parseJsonc } from "./jsonc.ts";
import { scrubEnv } from "./scrub-env.ts";
import { signBytes, UNSIGNED_KEY_ID } from "./signing.ts";
import { deriveVersionWithOrigin, formatBuildDate, type VersionOrigin } from "./version.ts";
import { type WorkerSize, workerSize } from "./worker-size.ts";
import {
  checkHyperdriveDeclarations,
  checkVectorizeDeclarations,
  classifyModuleType,
  collectBindings,
  collectQueueConsumers,
  mainModuleName,
  queueProducerBindings,
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
   * Which rule produced `version`: the catalog manifest's `install.version`,
   * the `source.ref` semver tag, or the pinned commit's date and SHA.
   */
  versionOrigin: VersionOrigin;
  moduleCount: number;
  assetCount: number;
  d1MigrationCount: number;
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
  return { config: cfg, binding: assets.binding ?? null, files };
}

/** A Worker's wrangler config as the packer reads it. */
interface ReadWorkerConfig {
  target: WranglerConfigTarget;
  /** The declared and effective config, relative to the checkout. */
  wranglerConfig: { declared: string; effective: string };
  config: ResolvedWranglerConfig & { main: string; name: string; compatibility_date: string };
  configDir: string;
}

/**
 * Reads the resolved wrangler config at `declared` (relative to the
 * checkout) with wrangler's own reader, following a redirect the build left,
 * as `wrangler deploy` would. Throws when it lacks `main`, `name` or
 * `compatibility_date`.
 */
function readWorkerConfig(
  checkoutDir: string,
  declared: string,
  logger: (m: string) => void,
): ReadWorkerConfig {
  // A template was copied to its real name before the build; that is what wrangler reads.
  const target = resolveWranglerConfig(checkoutDir, copyTemplateConfig(checkoutDir, declared));
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
  const { main, name, compatibility_date } = config;
  if (!main) {
    throw new Error(`wrangler config ${wranglerConfig.declared} has no \`main\` entrypoint`);
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
  workers: ReadonlyArray<{ worker: string; d1: Record<string, CollectedFile[]> }>,
): Record<string, CollectedFile[]> {
  const merged: Record<string, CollectedFile[]> = {};
  const from: Record<string, string> = {};
  const key = (files: readonly CollectedFile[]) =>
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
  // read: the config may be a file the build writes.
  const buildCommands = buildCommandList(catalog.install.buildCommand);
  if (buildCommands.length > 0) {
    await runBuildCommands({
      checkoutDir,
      commands: buildCommands,
      env: childEnv,
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
      timeoutMs: options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
      logger,
    });
  }

  // (c) Read every resolved wrangler config with wrangler's own reader,
  // following a redirect the build left, as `wrangler deploy` would.
  const specs: ReadonlyArray<{ name: string | null; wranglerConfig: string; primary?: true }> =
    entry ?? [{ name: null, wranglerConfig: catalog.install.wranglerConfig, primary: true }];
  const read = specs.map((spec) => ({
    name: spec.name,
    primary: spec.primary === true,
    ...readWorkerConfig(checkoutDir, spec.wranglerConfig, logger),
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
  // Before bundling, so a missing Vectorize declaration fails fast.
  const collected = read.map((r) => ({
    ...r,
    bindings: collectBindings(r.config, catalog.resources, {
      entryWorkers: r.name === null ? undefined : entryNames,
      checkUnboundVectorize: entry === undefined,
    }),
    queueConsumers: collectQueueConsumers(r.config, producers),
  }));
  if (entry !== undefined) {
    checkVectorizeDeclarations(
      collected.flatMap((c) => c.bindings),
      catalog.resources,
    );
    checkHyperdriveDeclarations(
      collected.flatMap((c) => c.bindings),
      catalog.resources,
    );
  } else {
    const varProblems = catalogVarProblems(collected[0]?.bindings ?? [], catalog.vars);
    if (varProblems.length > 0) {
      throw new Error(varProblems.join(" "));
    }
  }

  // (d) Bundle each Worker via a scrubbed dry-run, then collect (e) its
  // modules, (f) its static assets and (g) its D1 migrations. The primary
  // Worker's files keep the paths of a one-Worker artifact; every other
  // Worker's go under `workers/<name>/`.
  const built = collected.map((c) => {
    if (c.name !== null) logger(`bundling the Worker "${c.name}"`);
    const prefix = c.primary || c.name === null ? "" : `workers/${c.name}/`;
    const modules = bundleWorker(c.target, checkoutDir, c.config, childEnv, logger).map((m) => ({
      ...m,
      path: `${prefix}${m.path}`,
    }));
    return {
      ...c,
      modules,
      assets: collectAssets(c.config, c.configDir, logger, prefix),
      d1: collectD1Migrations(c.config, c.configDir),
    };
  });
  const d1 = mergeD1Migrations(built.map((b) => ({ worker: b.name ?? b.config.name, d1: b.d1 })));

  // Lay the zip out so byte offsets are recorded as each file is added. Order:
  // worker/, assets/, each other Worker's workers/<name>/, d1/, then
  // manifest.json LAST.
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
    if (!mainModule) {
      throw new Error("internal error: no main module identified");
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
        mainModule,
        compatibilityDate: b.config.compatibility_date,
        compatibilityFlags: b.config.compatibility_flags ?? [],
        modules: moduleManifest,
        bindings: b.bindings,
        migrations: (b.config.migrations ?? []) as DoMigration[],
        crons: b.config.triggers?.crons ?? [],
        ...(b.queueConsumers.length > 0 ? { queueConsumers: b.queueConsumers } : {}),
        observability: b.config.observability ?? null,
        placement: b.config.placement ?? null,
        limits: b.config.limits ?? null,
      },
      assets: { config: b.assets.config, binding: b.assets.binding, files: assetManifest },
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

  const { version, origin: versionOrigin } = deriveVersionWithOrigin({
    installVersion: catalog.install.version,
    ref: catalog.source.ref,
    sha: catalog.source.sha,
    commitDate: gitCommitDate(checkoutDir, childEnv),
    buildDate: formatBuildDate(new Date()),
  });

  // (i) Assemble + validate the manifest: format 1 for one Worker, format 2
  // (the primary Worker as `worker`, the others in `workers`) for several.
  const primarySection = sections[0];
  if (primarySection === undefined) {
    throw new Error("internal error: no Worker was packed");
  }
  const common = {
    app: catalog.slug,
    version,
    source: { repo: catalog.repo, sha: catalog.source.sha, ref: catalog.source.ref },
    builtAt: new Date().toISOString(),
    builder: `@appflare/pack@${packerVersion()}`,
    keyId: options.keyId ?? UNSIGNED_KEY_ID,
    worker: primarySection.worker,
    assets: primarySection.assets,
    d1Migrations: d1Manifest,
    catalog,
  };
  const manifestInput =
    entry === undefined
      ? { format: 1 as const, ...common }
      : {
          format: 2 as const,
          ...common,
          workers: sections
            .filter((s) => !s.primary)
            .map((s) => ({ name: s.name, worker: s.worker, assets: s.assets })),
        };
  const manifest = artifactManifestSchema.parse(manifestInput);
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

  const d1MigrationCount = Object.values(d1Manifest).reduce((n, f) => n + f.length, 0);
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
      `${assetCount} assets, ${d1MigrationCount} migrations, ${zipBytes.length} bytes`,
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
    zipSize: zipBytes.length,
    workerSize: size,
    workers,
  };
}

/** How the pack summary names where the version came from. */
export function describeVersionOrigin(origin: VersionOrigin): string {
  switch (origin) {
    case "install.version":
      return "version from install.version in the catalog manifest";
    case "tag":
      return "version from the source.ref tag";
    case "commit":
      return "version from the pinned commit's date and SHA";
  }
}
