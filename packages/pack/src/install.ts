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
 */

/** A listed directory cannot be installed, or its install failed. */
export class InstallError extends Error {
  override name = "InstallError";
}

/** One package manager run: the program, its arguments, and what it adds to the environment. */
export interface InstallInvocation {
  command: PackageManager;
  args: string[];
  env: Record<string, string>;
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
 */
export function installInvocation(
  packageManager: PackageManager,
  lockfile: InstallLockfile,
): InstallInvocation {
  const frozen = lockfile === "required";
  switch (packageManager) {
    case "pnpm":
      return {
        command: "pnpm",
        args: [
          "install",
          frozen ? "--frozen-lockfile" : "--no-frozen-lockfile",
          "--ignore-scripts",
          "--config.package-manager-strict=false",
        ],
        env: { COREPACK_ENABLE_STRICT: "0" },
      };
    case "npm":
      return {
        command: "npm",
        args: frozen
          ? ["ci", "--ignore-scripts"]
          : ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
        env: {},
      };
    case "yarn":
      // Classic yarn's flags; yarn 2 and later refuse them.
      return {
        command: "yarn",
        args: frozen
          ? ["install", "--frozen-lockfile", "--ignore-scripts"]
          : ["install", "--ignore-scripts"],
        env: { YARN_ENABLE_SCRIPTS: "false" },
      };
    case "bun":
      return {
        command: "bun",
        args: frozen
          ? ["install", "--frozen-lockfile", "--ignore-scripts"]
          : ["install", "--ignore-scripts"],
        env: {},
      };
  }
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
}

function planInstall(
  checkoutDir: string,
  entry: CatalogInstallDir,
  entryPackageManager: PackageManager,
): PlannedInstall {
  const abs = resolveInstallDir(checkoutDir, entry.path);
  const files = new Set(readdirSync(abs));
  const lockfile = entry.lockfile ?? "required";
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
  return { path: entry.path, abs, packageManager, lockfile };
}

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
 * that cannot be installed, or at the first install that fails.
 */
export function installDependencies(options: InstallOptions): void {
  const { checkoutDir, logger } = options;
  const run = options.run ?? spawnInstall;
  const planned = options.installDirs.map((entry) =>
    planInstall(checkoutDir, entry, options.packageManager),
  );
  for (const dir of planned) {
    const invocation = installInvocation(dir.packageManager, dir.lockfile);
    const shown = [invocation.command, ...invocation.args].join(" ");
    logger(
      `installing dependencies in ${dir.path} with ${dir.packageManager}` +
        (dir.lockfile === "none" ? ", resolving them (upstream ships no lockfile)" : "") +
        `: ${shown}`,
    );
    const before =
      dir.lockfile === "none" ? lockfileState(checkoutDir, dir.abs, dir.packageManager) : null;
    const res = run(invocation, dir.abs, options.env);
    if (res.error !== undefined) {
      throw new InstallError(
        `installing dependencies in ${dir.path} failed: could not run ${invocation.command}: ${res.error.message}`,
      );
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
