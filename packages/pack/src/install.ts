import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  type CatalogInstallDir,
  type InstallLockfile,
  installDirPackageManager,
  installDirProblem,
  LOCKFILES,
  lockfilesOf,
  type PackageManager,
} from "@appflare/schema";

/**
 * The dependency install: once per directory of the catalog manifest's
 * `install.installDirs` (the root when it lists none), in order, always with
 * install scripts disabled, before the build commands run.
 *
 * A directory is installed from its lockfile (the package manager's frozen
 * install), unless it sets `lockfile: "none"`: upstream ships none for it, so
 * the install resolves the dependencies itself and the log records the sha256
 * of the lockfile it wrote, which a later pack of the same pin can be compared
 * against.
 *
 * The checkout picks the package manager's version where the flags differ:
 * yarn 2 and later (Berry) runs through corepack with its own flags; npm
 * runs as the major the checkout asks for, as npm 11 when it asks for a
 * Node.js that ships npm 11 (`.nvmrc`, `engines.node`), or as npm 11 when
 * Node 22's npm 10 refuses a lockfile npm 11 wrote; and pnpm runs as pnpm 9
 * for a `lockfileVersion` 6 lockfile, which pnpm 10 refuses
 * ({@link packageManagerFlavor}). Each later version is pinned exactly.
 *
 * A directory with `devDependencies: false` installs its production
 * dependencies alone.
 */

/** A listed directory cannot be installed, or its install failed. */
export class InstallError extends Error {
  override name = "InstallError";
}

/** One package manager run: the program, its arguments, and what it adds to the environment. */
export interface InstallInvocation {
  /** The package manager, or what runs the version the checkout asks for (`corepack`, `npx`). */
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * The npm major Node 22 ships (npm 10). A checkout that asks for a later one
 * installs with that npm, run through `npx`.
 */
export const BUNDLED_NPM_MAJOR = 10;

/**
 * The npm an install falls back to when Node 22's npm refuses a
 * `lockfileVersion` 3 lockfile as out of sync: npm 11 writes lockfiles npm
 * 10 reads as missing packages ("Missing: esbuild@0.28.2 from lock file").
 */
export const FALLBACK_NPM_MAJOR = 11;

/**
 * The exact npm 11 the packer installs with, as `npx` takes it. The sandbox
 * image warms npx's cache with this same spec (its Dockerfile runs
 * `npx --yes npm@11.20.0 --version`), so a build there needs no download.
 */
export const NPM_11_SPEC = "npm@11.20.0";

/** The `npx` spec for an npm major: {@link NPM_11_SPEC} for 11, else the latest of the major. */
export function npmSpec(major: number): string {
  return major === FALLBACK_NPM_MAJOR ? NPM_11_SPEC : `npm@${major}`;
}

/**
 * The first Node.js major that ships npm 11. A checkout that asks for it or
 * a later one (`.nvmrc`, `engines.node`) installs with {@link NPM_11_SPEC},
 * the npm its lockfile was most likely written with.
 */
export const FIRST_NODE_WITH_NPM_11 = 24;

/**
 * The pnpm a `lockfileVersion` 6 lockfile (pnpm 8's) installs with: pnpm 10
 * refuses it (ERR_PNPM_LOCKFILE_BREAKING_CHANGE), and pnpm 9 is the last
 * major that reads it, frozen, without rewriting it.
 */
export const PNPM_9_SPEC = "pnpm@9.15.9";

/** What the checkout says about its package manager beyond the name. */
export interface PackageManagerFlavor {
  /**
   * yarn 2 or later (Berry): `packageManager: "yarn@2..."` or later in the
   * nearest `package.json` at or above the directory that names yarn.
   */
  yarnBerry?: boolean;
  /**
   * The npm major to install with, when the checkout asks for one later
   * than {@link BUNDLED_NPM_MAJOR} (`packageManager: "npm@11..."`, else the
   * lowest major `engines.npm` allows).
   */
  npmMajor?: number;
  /**
   * The Node.js major the checkout asks for (`.nvmrc`, else the lowest
   * major `engines.node` allows) when that is what picked `npmMajor`.
   */
  nodeMajor?: number;
  /** pnpm 9 ({@link PNPM_9_SPEC}), for a `lockfileVersion` 6 lockfile. */
  pnpm9?: boolean;
}

/** Options of one install beyond its package manager and lockfile. */
export interface InstallInvocationOptions {
  /** Install production dependencies alone (`devDependencies: false`). */
  production?: boolean;
}

/**
 * The install command for `packageManager`, with install scripts disabled.
 *
 * - `required`: the frozen install, which fails when the lockfile is missing
 *   or out of date (`pnpm install --frozen-lockfile`, `npm ci`, `yarn install
 *   --frozen-lockfile`, `bun install --frozen-lockfile`).
 * - `none`: an install that resolves the dependencies and writes a lockfile,
 *   so its hash can be logged. pnpm takes `--no-frozen-lockfile`, since it
 *   freezes by default in CI once a lockfile exists; npm runs `install`
 *   instead of `ci`; classic yarn and bun run a plain `install`, which writes
 *   `yarn.lock` and `bun.lock` (yarn's `--no-lockfile` and `--pure-lockfile`,
 *   and bun's `--no-save`, would write no lockfile to hash, and neither
 *   freezes by default in CI).
 *
 * pnpm also gets `package-manager-strict=false` and `COREPACK_ENABLE_STRICT=0`
 * so the machine's pnpm installs a checkout that pins another pnpm major
 * without fetching a new pnpm; classic yarn gets `YARN_ENABLE_SCRIPTS=false`
 * as well as `--ignore-scripts`.
 *
 * `flavor` picks the version. yarn 2 and later refuse classic yarn's flags,
 * so a Berry checkout runs `corepack yarn install --immutable
 * --mode=skip-build` with `YARN_ENABLE_SCRIPTS=false`; without a lockfile it
 * drops `--immutable` and sets `YARN_ENABLE_IMMUTABLE_INSTALLS=false`, since
 * Berry freezes by default in CI. Corepack, which ships with Node 22, runs
 * the yarn the checkout pins, where the machine's own `yarn` may be classic
 * yarn, which refuses such a checkout. An `npmMajor` runs npm through
 * `npx --yes <spec>` ({@link npmSpec}), and `pnpm9` runs
 * `npx --yes pnpm@9.x.y`.
 *
 * `production` leaves devDependencies out, with each manager's own flag,
 * which keeps the install frozen: pnpm `--prod`, npm `--omit=dev`, classic
 * yarn and bun `--production`. yarn 2 and later have no such flag on
 * `install` (their `workspaces focus --production` resolves anew), so the
 * packer refuses the combination before it gets here.
 */
export function installInvocation(
  packageManager: PackageManager,
  lockfile: InstallLockfile,
  flavor: PackageManagerFlavor = {},
  options: InstallInvocationOptions = {},
): InstallInvocation {
  const frozen = lockfile === "required";
  const production = options.production === true;
  switch (packageManager) {
    case "pnpm": {
      const args = [
        "install",
        frozen ? "--frozen-lockfile" : "--no-frozen-lockfile",
        ...(production ? ["--prod"] : []),
        "--ignore-scripts",
        "--config.package-manager-strict=false",
      ];
      const env = { COREPACK_ENABLE_STRICT: "0" };
      return flavor.pnpm9 === true
        ? { command: "npx", args: ["--yes", PNPM_9_SPEC, ...args], env }
        : { command: "pnpm", args, env };
    }
    case "npm": {
      const args = [
        ...(frozen
          ? ["ci", "--ignore-scripts"]
          : ["install", "--ignore-scripts", "--no-audit", "--no-fund"]),
        ...(production ? ["--omit=dev"] : []),
      ];
      return flavor.npmMajor === undefined
        ? { command: "npm", args, env: {} }
        : { command: "npx", args: ["--yes", npmSpec(flavor.npmMajor), ...args], env: {} };
    }
    case "yarn":
      if (flavor.yarnBerry === true) {
        return {
          command: "corepack",
          args: ["yarn", "install", ...(frozen ? ["--immutable"] : []), "--mode=skip-build"],
          env: {
            YARN_ENABLE_SCRIPTS: "false",
            COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
            ...(frozen ? {} : { YARN_ENABLE_IMMUTABLE_INSTALLS: "false" }),
          },
        };
      }
      // Classic yarn's flags; yarn 2 and later refuse them.
      return {
        command: "yarn",
        args: [
          ...(frozen
            ? ["install", "--frozen-lockfile", "--ignore-scripts"]
            : ["install", "--ignore-scripts"]),
          ...(production ? ["--production"] : []),
        ],
        env: { YARN_ENABLE_SCRIPTS: "false" },
      };
    case "bun":
      return {
        command: "bun",
        args: [
          ...(frozen
            ? ["install", "--frozen-lockfile", "--ignore-scripts"]
            : ["install", "--ignore-scripts"]),
          ...(production ? ["--production"] : []),
        ],
        env: {},
      };
  }
}

/** The directories from `abs` up to the checkout root, nearest first. */
function dirsUpToRoot(checkoutDir: string, abs: string): string[] {
  const root = path.resolve(checkoutDir);
  const dirs: string[] = [];
  let dir = path.resolve(abs);
  for (;;) {
    dirs.push(dir);
    if (dir === root) return dirs;
    const parent = path.dirname(dir);
    if (parent === dir || path.relative(root, parent).startsWith("..")) return dirs;
    dir = parent;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A directory's `package.json` as an object, or null when it has none it can read. */
function readPackageJson(dir: string): Record<string, unknown> | null {
  const file = path.join(dir, "package.json");
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  try {
    const pkg: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isRecord(pkg) ? pkg : null;
  } catch {
    // The package manager itself says what is wrong with it, and better.
    return null;
  }
}

/** The major of a `packageManager` field (`"yarn@4.5.0+sha512.…"`) naming `name`, or null. */
export function packageManagerMajor(field: unknown, name: PackageManager): number | null {
  if (typeof field !== "string") return null;
  const match = /^([a-z]+)@(\d+)(?:\.|$)/.exec(field.trim());
  return match?.[1] === name && match[2] !== undefined ? Number(match[2]) : null;
}

/**
 * The lowest major a semver range allows (`">=11"` and `"^11.3.0"` give 11,
 * `"10.x || 11.x"` gives 10), or null when it names none (`"*"`).
 */
export function lowestRangeMajor(range: unknown): number | null {
  if (typeof range !== "string") return null;
  const majors = range
    .split("||")
    .map((alternative) => /(\d+)/.exec(alternative)?.[1])
    .filter((m): m is string => m !== undefined)
    .map(Number);
  return majors.length === 0 ? null : Math.min(...majors);
}

/**
 * Which version of `packageManager` the directory `abs` asks for, from the
 * nearest `package.json` at or above it (up to the checkout root) that
 * says. yarn: `packageManager: "yarn@<major>..."`, 2 or later making it
 * Berry. npm: `packageManager: "npm@<major>..."`, else the lowest major
 * `engines.npm` allows, when it is later than {@link BUNDLED_NPM_MAJOR};
 * when no `package.json` names an npm, the Node.js the checkout asks for
 * ({@link nodeMajorOf}): {@link FIRST_NODE_WITH_NPM_11} or later ships npm
 * 11, so the install runs with {@link NPM_11_SPEC}. pnpm: pnpm 9 when the
 * lockfile the install reads is `lockfileVersion` 6.
 *
 * Throws {@link InstallError} for a yarn checkout with a `.yarnrc.yml` (a
 * yarn 2 or later project) but no `packageManager` pin: corepack would run
 * its default classic yarn, which ignores Berry's flags and its
 * `enableScripts: false`, and would run the dependencies' install scripts.
 */
export function packageManagerFlavor(
  checkoutDir: string,
  abs: string,
  packageManager: PackageManager,
): PackageManagerFlavor {
  const dirs = dirsUpToRoot(checkoutDir, abs);
  if (packageManager === "yarn") {
    for (const dir of dirs) {
      const major = packageManagerMajor(readPackageJson(dir)?.packageManager, "yarn");
      if (major !== null) return major >= 2 ? { yarnBerry: true } : {};
    }
    const yarnrc = dirs.find((dir) => existsSync(path.join(dir, ".yarnrc.yml")));
    if (yarnrc !== undefined) {
      const where = path.relative(path.resolve(checkoutDir), yarnrc).split(path.sep).join("/");
      throw new InstallError(
        `${where === "" ? "" : `${where}/`}.yarnrc.yml marks a yarn 2 or later project, but no package.json ` +
          'at or above the directory pins its yarn ("packageManager": "yarn@4.x.y"); without the pin ' +
          "corepack would run classic yarn, which would run install scripts, so the packer refuses to install it",
      );
    }
    return {};
  }
  if (packageManager === "npm") {
    for (const dir of dirs) {
      const pkg = readPackageJson(dir);
      const engines = isRecord(pkg?.engines) ? pkg.engines : {};
      const major =
        packageManagerMajor(pkg?.packageManager, "npm") ?? lowestRangeMajor(engines.npm);
      if (major !== null) return major > BUNDLED_NPM_MAJOR ? { npmMajor: major } : {};
    }
    const nodeMajor = nodeMajorOf(dirs);
    if (nodeMajor !== null && nodeMajor >= FIRST_NODE_WITH_NPM_11) {
      return { npmMajor: FALLBACK_NPM_MAJOR, nodeMajor };
    }
  }
  if (packageManager === "pnpm") {
    const lockfile = findLockfile(checkoutDir, abs, "pnpm");
    if (lockfile !== null && pnpmLockfileMajor(lockfile) === 6) return { pnpm9: true };
  }
  return {};
}

/**
 * The Node.js major the directories ask for, nearest first: a `.nvmrc`
 * naming a version (`24`, `v24.1.0`; an alias such as `lts/*` names none),
 * else the lowest major `engines.node` allows. Null when none says.
 */
export function nodeMajorOf(dirs: readonly string[]): number | null {
  for (const dir of dirs) {
    const nvmrc = path.join(dir, ".nvmrc");
    if (existsSync(nvmrc) && statSync(nvmrc).isFile()) {
      const match = /^v?(\d+)(?:\.|\s|$)/.exec(readFileSync(nvmrc, "utf8").trim());
      if (match?.[1] !== undefined) return Number(match[1]);
    }
    const pkg = readPackageJson(dir);
    const major = lowestRangeMajor(isRecord(pkg?.engines) ? pkg.engines.node : undefined);
    if (major !== null) return major;
  }
  return null;
}

/**
 * The major of a `pnpm-lock.yaml`'s `lockfileVersion` (`'6.0'` gives 6,
 * `'9.0'` gives 9), read from its first lines, or null when it has none.
 */
export function pnpmLockfileMajor(lockfilePath: string): number | null {
  if (path.basename(lockfilePath) !== "pnpm-lock.yaml") return null;
  const head = readFileSync(lockfilePath, "utf8").slice(0, 512);
  const match = /^lockfileVersion:\s*['"]?(\d+)/m.exec(head);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * How a failed `npm ci` shows Node 22's npm refusing a lockfile a later npm
 * wrote, or null when it does not: the lockfile is a `package-lock.json` of
 * `lockfileVersion` 3, and npm says it is out of sync with `package.json`
 * (`out-of-sync`), or cannot resolve its peer dependencies (`eresolve`),
 * which npm 10 reports for trees npm 11 resolves and installs (a devDependency
 * range that no longer meets a peer range of the version the lockfile holds).
 */
export function newerNpmLockfileFailure(
  lockfilePath: string | null,
  output: string,
): "out-of-sync" | "eresolve" | null {
  if (lockfilePath === null || path.basename(lockfilePath) !== "package-lock.json") return null;
  const outOfSync =
    /Missing: \S+ from lock file/.test(output) ||
    /can only install packages when your package\.json and package-lock\.json/.test(output);
  const eresolve = /\bERESOLVE\b/.test(output);
  if (!outOfSync && !eresolve) return null;
  try {
    const lock: unknown = JSON.parse(readFileSync(lockfilePath, "utf8"));
    if (!isRecord(lock) || lock.lockfileVersion !== 3) return null;
  } catch {
    return null;
  }
  return outOfSync ? "out-of-sync" : "eresolve";
}

/** Whether {@link newerNpmLockfileFailure} recognises the failure. */
export function isNewerNpmLockfileFailure(lockfilePath: string | null, output: string): boolean {
  return newerNpmLockfileFailure(lockfilePath, output) !== null;
}

/** What one package manager run ended with. */
export interface InstallRunResult {
  /** Set when the process could not be started. */
  error?: Error | undefined;
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs one install in `cwd`. */
export type InstallRunner = (
  invocation: InstallInvocation,
  cwd: string,
  env: NodeJS.ProcessEnv,
) => InstallRunResult;

const spawnInstall: InstallRunner = (invocation, cwd, env) => {
  const res = spawnSync(invocation.command, invocation.args, {
    cwd,
    env: { ...env, ...invocation.env },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return {
    error: res.error,
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
};

export interface InstallOptions {
  checkoutDir: string;
  /** The directories, in order (`installDirList(catalog.install)`). */
  installDirs: readonly CatalogInstallDir[];
  /** The entry's `install.packageManager`, for directories that name none. */
  packageManager: PackageManager;
  /** The scrubbed environment every child of the packer gets. */
  env: NodeJS.ProcessEnv;
  logger: (message: string) => void;
  /** Runs one install; spawns the package manager unless replaced (tests). */
  run?: InstallRunner;
}

/**
 * The absolute directory `dir` names inside `checkoutDir`. Refuses a path
 * the schema refuses, a directory that does not exist, and one a symlink
 * leads out of the checkout.
 */
export function resolveInstallDir(checkoutDir: string, dir: string): string {
  const problem = installDirProblem(dir);
  if (problem !== null) throw new InstallError(`install.installDirs path ${problem}`);
  const root = path.resolve(checkoutDir);
  const abs = path.resolve(root, dir);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) {
    throw new InstallError(
      `install.installDirs names ${dir}, which is not a directory of the checkout`,
    );
  }
  const rel = path.relative(realpathSync(root), realpathSync(abs));
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new InstallError(
      `install.installDirs names ${dir}, which a symlink leads out of the checkout`,
    );
  }
  return abs;
}

/**
 * The lockfile `packageManager` left for the directory `abs`: in it, or in
 * the nearest directory above it up to the checkout root (a workspace keeps
 * one lockfile at its root). Null when there is none.
 */
export function findLockfile(
  checkoutDir: string,
  abs: string,
  packageManager: PackageManager,
): string | null {
  const root = path.resolve(checkoutDir);
  let dir = path.resolve(abs);
  for (;;) {
    for (const name of lockfilesOf(packageManager)) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir || path.relative(root, parent).startsWith("..")) return null;
    dir = parent;
  }
}

function checkoutPath(checkoutDir: string, abs: string): string {
  return path.relative(path.resolve(checkoutDir), abs).split(path.sep).join("/") || ".";
}

/** One listed directory, checked and ready to install. */
interface PlannedInstall {
  path: string;
  abs: string;
  packageManager: PackageManager;
  lockfile: InstallLockfile;
  flavor: PackageManagerFlavor;
  /** Without devDependencies (`devDependencies: false`). */
  production: boolean;
}

function planInstall(
  checkoutDir: string,
  entry: CatalogInstallDir,
  entryPackageManager: PackageManager,
): PlannedInstall {
  const abs = resolveInstallDir(checkoutDir, entry.path);
  const files = new Set(readdirSync(abs));
  const lockfile = entry.lockfile;
  const packageManager =
    entry.packageManager ?? installDirPackageManager(files, entryPackageManager);
  if (lockfile === "none") {
    const shipped = LOCKFILES.find(([file]) => files.has(file))?.[0];
    if (shipped !== undefined) {
      throw new InstallError(
        `install.installDirs sets lockfile "none" for ${entry.path}, but it holds ${shipped}; ` +
          '"none" is only for a directory upstream ships without a lockfile, so install from the lockfile instead',
      );
    }
  } else if (findLockfile(checkoutDir, abs, packageManager) === null) {
    // Classic yarn and bun exit 0 without a lockfile, even when frozen, and
    // would install whatever resolves today.
    throw new InstallError(
      `installing dependencies in ${entry.path} needs a lockfile, and there is no ` +
        `${lockfilesOf(packageManager).join(" or ")} in it or above it in the checkout; ` +
        'set lockfile "none" for it only when upstream ships no lockfile',
    );
  }
  const flavor = packageManagerFlavor(checkoutDir, abs, packageManager);
  const production = entry.devDependencies === false;
  if (production && flavor.yarnBerry === true) {
    throw new InstallError(
      `install.installDirs sets devDependencies false for ${entry.path}, but it is a yarn 2 or later project, ` +
        "whose install has no flag to leave devDependencies out while keeping to the lockfile; install them, or ask upstream to make them installable",
    );
  }
  return { path: entry.path, abs, packageManager, lockfile, flavor, production };
}

/** The runner of each version-picking command, for the message when it is missing. */
const RUNNER_HINT: Readonly<Record<string, string>> = {
  corepack:
    "yarn 2 and later install through corepack, which ships with Node.js 22 and 24 (install it with `npm install -g corepack` on a later Node.js)",
  npx: "a checkout that asks for a later npm, or has a pnpm 8 lockfile, installs through npx, which ships with npm",
};

/** A lockfile's path in the checkout and its sha256. */
interface LockfileState {
  path: string;
  sha256: string;
}

function lockfileState(
  checkoutDir: string,
  abs: string,
  packageManager: PackageManager,
): LockfileState | null {
  const found = findLockfile(checkoutDir, abs, packageManager);
  if (found === null) return null;
  return {
    path: checkoutPath(checkoutDir, found),
    sha256: createHash("sha256").update(readFileSync(found)).digest("hex"),
  };
}

/**
 * The log line after a lockfile-less install: the lockfile it wrote or
 * changed, with its hash. A lockfile the checkout already had (a workspace's,
 * above the directory) that the install left as it was is not one it
 * resolved.
 */
function resolvedLockfileLine(
  dir: string,
  before: LockfileState | null,
  after: LockfileState | null,
): string {
  if (after === null) return `no lockfile written for ${dir}`;
  const sameFile = before !== null && before.path === after.path;
  if (sameFile && before.sha256 === after.sha256) {
    return `no lockfile written for ${dir}: ${after.path} was already in the checkout, and the install left it unchanged`;
  }
  const changed = sameFile ? " (the install changed the checkout's own)" : "";
  return `resolved lockfile for ${dir}: ${after.path} sha256 ${after.sha256}${changed}`;
}

/**
 * Installs every listed directory in order. Every directory is checked
 * before the first install runs; throws {@link InstallError} for a directory
 * that cannot be installed, or at the first install that fails. An empty
 * list installs nothing (a repository without a `package.json`).
 */
export function installDependencies(options: InstallOptions): void {
  const { checkoutDir, logger } = options;
  if (options.installDirs.length === 0) {
    logger(
      "install.installDirs is empty: no dependencies are installed; wrangler bundles the entry and its relative imports",
    );
    return;
  }
  const run = options.run ?? spawnInstall;
  const planned = options.installDirs.map((entry) =>
    planInstall(checkoutDir, entry, options.packageManager),
  );
  for (const dir of planned) {
    const extra = { production: dir.production };
    const describe = (flavor: PackageManagerFlavor) => {
      const invocation = installInvocation(dir.packageManager, dir.lockfile, flavor, extra);
      return [invocation.command, ...invocation.args].join(" ");
    };
    const attempt = (flavor: PackageManagerFlavor) => {
      const invocation = installInvocation(dir.packageManager, dir.lockfile, flavor, extra);
      const shown = describe(flavor);
      const res = run(invocation, dir.abs, options.env);
      if (res.error !== undefined) {
        const hint = RUNNER_HINT[invocation.command];
        throw new InstallError(
          `installing dependencies in ${dir.path} failed: could not run ${invocation.command}: ${res.error.message}` +
            (hint === undefined ? "" : `; ${hint}`),
        );
      }
      return { shown, res };
    };
    const pinned =
      dir.flavor.yarnBerry === true
        ? " 2 or later"
        : dir.flavor.pnpm9 === true
          ? " 9 (the lockfile is lockfileVersion 6, which pnpm 10 refuses)"
          : dir.flavor.nodeMajor !== undefined && dir.flavor.npmMajor !== undefined
            ? ` ${dir.flavor.npmMajor} (the checkout asks for Node.js ${dir.flavor.nodeMajor}, which ships npm ${dir.flavor.npmMajor})`
            : dir.flavor.npmMajor !== undefined
              ? ` ${dir.flavor.npmMajor}`
              : "";
    logger(
      `installing dependencies in ${dir.path} with ${dir.packageManager}${pinned}` +
        (dir.lockfile === "none" ? ", resolving them (upstream ships no lockfile)" : "") +
        (dir.production ? ", without devDependencies" : "") +
        `: ${describe(dir.flavor)}`,
    );
    const before =
      dir.lockfile === "none" ? lockfileState(checkoutDir, dir.abs, dir.packageManager) : null;
    let { shown, res } = attempt(dir.flavor);
    const lockfilePath = findLockfile(checkoutDir, dir.abs, dir.packageManager);
    const refusal =
      res.status !== 0 &&
      dir.packageManager === "npm" &&
      dir.lockfile === "required" &&
      dir.flavor.npmMajor === undefined
        ? newerNpmLockfileFailure(lockfilePath, `${res.stdout}\n${res.stderr}`)
        : null;
    if (refusal !== null) {
      const retry = { npmMajor: FALLBACK_NPM_MAJOR };
      const lock = lockfilePath === null ? "the lockfile" : checkoutPath(checkoutDir, lockfilePath);
      const how =
        refusal === "out-of-sync"
          ? `refused ${lock} (lockfileVersion 3) as out of sync`
          : `could not resolve the peer dependencies of ${lock} (lockfileVersion 3, ERESOLVE)`;
      logger(
        `${shown} ${how}, as the npm Node.js 22 ships does with a lockfile npm ${FALLBACK_NPM_MAJOR} wrote; ` +
          `installing with npm ${FALLBACK_NPM_MAJOR}: ${describe(retry)}`,
      );
      ({ shown, res } = attempt(retry));
    }
    if (res.status !== 0) {
      throw new InstallError(
        `installing dependencies in ${dir.path} failed: ${shown} exited with ${res.status}:\n${res.stdout}\n${res.stderr}`,
      );
    }
    if (dir.lockfile === "none") {
      const after = lockfileState(checkoutDir, dir.abs, dir.packageManager);
      logger(resolvedLockfileLine(dir.path, before, after));
    }
  }
}
