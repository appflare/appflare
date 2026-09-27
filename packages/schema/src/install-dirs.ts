import { z } from "zod";

/**
 * The directories whose dependencies the packer installs (`install.installDirs`),
 * and the lockfile rules both the packer and the sandbox Worker go by.
 *
 * Most apps install once at the root of the checkout, which is the default.
 * Some keep their Worker in a directory of its own with its own
 * `package.json` and no root one (a template repository), or need a second
 * install beside the root one. Each listed directory is installed in order,
 * with install scripts disabled.
 *
 * `lockfile: "none"` is for a directory upstream ships without a lockfile:
 * the install resolves the dependencies itself (so they are not pinned), and
 * the pack log records the sha256 of the lockfile it wrote. Everywhere else
 * the install is frozen to the lockfile.
 *
 * An empty list installs nothing, for a repository without a `package.json`:
 * wrangler still bundles the Worker's entry and every relative import, but a
 * bare import (a package) cannot resolve, and build commands run with no
 * dependencies installed. `lockfile: "none"` is no substitute there: pnpm and
 * bun refuse a directory without a `package.json`, and npm looks for one in
 * the directories above the checkout.
 *
 * This module imports nothing but zod: `catalog.ts` imports it, and the JSON
 * Schema export runs `catalog.ts` directly under Node's type stripping.
 */

/**
 * The `info().features` entry of a sandbox Worker whose build installs the
 * directories an entry lists: it lets its packer install them instead of
 * running the root install. The manager refuses to send such an entry to a
 * sandbox Worker without it, which would install the root alone.
 */
export const SANDBOX_FEATURE_INSTALL_DIRS = "install-dirs";

/** Package manager the packer uses to build the app from its checkout. */
export const packageManagerSchema = z.enum(["pnpm", "npm", "yarn", "bun"]);
export type PackageManager = z.infer<typeof packageManagerSchema>;

/**
 * Lockfiles, in the order they are looked for, and the package manager each
 * means. The first one a directory holds names its package manager.
 */
export const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** The lockfiles `packageManager` reads and writes, in the order they are looked for. */
export function lockfilesOf(packageManager: PackageManager): string[] {
  return LOCKFILES.filter(([, manager]) => manager === packageManager).map(([file]) => file);
}

/** The package manager the first lockfile in `files` names, or null when there is none. */
export function lockfilePackageManager(files: ReadonlySet<string>): PackageManager | null {
  for (const [file, manager] of LOCKFILES) {
    if (files.has(file)) return manager;
  }
  return null;
}

/**
 * The package manager of an install directory that does not name one: the
 * entry's `install.packageManager` when the directory holds its lockfile or
 * holds no lockfile at all, else the one its lockfile names. At the root of
 * an entry that installs today, that is always `install.packageManager`.
 */
export function installDirPackageManager(
  files: ReadonlySet<string>,
  entryPackageManager: PackageManager,
): PackageManager {
  if (lockfilesOf(entryPackageManager).some((file) => files.has(file))) return entryPackageManager;
  return lockfilePackageManager(files) ?? entryPackageManager;
}

/** Whether a directory's install must follow a lockfile (`required`) or resolves its own (`none`). */
export const installLockfileSchema = z.enum(["required", "none"]);
export type InstallLockfile = z.infer<typeof installLockfileSchema>;

/** The most directories `install.installDirs` may list. */
export const MAX_INSTALL_DIRS = 8;

/** The longest install directory path. */
export const MAX_INSTALL_DIR_LENGTH = 256;

const SEGMENT = /^[0-9A-Za-z.@+_-]+$/;

/** The same rule as {@link installDirProblem}, for editors reading the JSON Schema. */
const INSTALL_DIR_PATTERN =
  "^(?:\\.|(?!\\.\\.?(?:/|$))[0-9A-Za-z.@+_-]+(?:/(?!\\.\\.?(?:/|$))[0-9A-Za-z.@+_-]+)*)$";

/**
 * Why `dir` cannot be an install directory, or null when it can. It is `.`
 * (the root of the checkout) or a relative path of `/`-separated names
 * inside it, with no `.` or `..` names, so it cannot reach outside the
 * checkout.
 */
export function installDirProblem(dir: string): string | null {
  if (dir.length === 0) return "is empty; use . for the root of the checkout";
  if (dir.length > MAX_INSTALL_DIR_LENGTH) {
    return `is longer than ${MAX_INSTALL_DIR_LENGTH} characters`;
  }
  if (dir === ".") return null;
  if (dir.includes("\\")) return `"${dir}" uses a backslash; separate directories with /`;
  if (dir.startsWith("/") || /^[A-Za-z]:/.test(dir)) {
    return `"${dir}" is absolute; give a path relative to the root of the checkout, such as templates/blog`;
  }
  const segments = dir.split("/");
  if (segments.includes("..")) {
    return `"${dir}" contains ..; an install directory must stay inside the checkout`;
  }
  if (segments.includes(".")) return `"${dir}" contains a . directory; write it without one`;
  if (segments.includes("")) {
    return `"${dir}" has an empty directory name (a doubled or trailing /)`;
  }
  if (!segments.every((segment) => SEGMENT.test(segment))) {
    return `"${dir}" may contain only letters, digits, and . @ + _ - between the / separators`;
  }
  return null;
}

/** One entry of `install.installDirs`. */
export const catalogInstallDirSchema = z.object({
  path: z
    .string()
    .superRefine((dir, ctx) => {
      const problem = installDirProblem(dir);
      if (problem !== null) ctx.addIssue({ code: "custom", message: `path ${problem}` });
    })
    .meta({ pattern: INSTALL_DIR_PATTERN })
    .describe(
      "The directory to install, relative to the root of the checkout: `.` for the root, or a " +
        "path such as `templates/blog`. No absolute paths and no `..`.",
    ),
  packageManager: packageManagerSchema
    .describe(
      "The package manager to install this directory with. Omitted, it is " +
        "`install.packageManager` when the directory holds that manager's lockfile or no " +
        "lockfile at all, else the one its lockfile names.",
    )
    .optional(),
  lockfile: installLockfileSchema
    .describe(
      'Omitted or `"required"`, the install follows the directory\'s lockfile exactly and ' +
        'fails without one. `"none"` resolves the dependencies instead and records the hash of ' +
        "the lockfile it wrote in the pack log; use it only when upstream ships no lockfile " +
        "for this directory.",
    )
    .optional(),
  devDependencies: z
    .boolean()
    .describe(
      "`false` installs this directory's dependencies without its devDependencies (pnpm " +
        "`--prod`, npm `--omit=dev`, classic yarn and bun `--production`), for a project whose " +
        "devDependencies cannot be installed (one from a private registry, say) and are not " +
        "needed to bundle the Worker. Omitted or `true` installs them all. yarn 2 and later " +
        "have no such frozen install, so they refuse it.",
    )
    .optional(),
});
export type CatalogInstallDir = z.infer<typeof catalogInstallDirSchema>;

/**
 * `install.installDirs`: the directories to install, in order, each once.
 * Empty installs nothing (a repository without a `package.json`).
 */
export const catalogInstallDirsSchema = z
  .array(catalogInstallDirSchema)
  .max(MAX_INSTALL_DIRS)
  .superRefine((dirs, ctx) => {
    const seen = new Set<string>();
    dirs.forEach((dir, index) => {
      if (seen.has(dir.path)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "path"],
          message: `path "${dir.path}" is listed twice; each directory is installed once`,
        });
      }
      seen.add(dir.path);
    });
  });

/** The install directories when an entry lists none: the root of the checkout. */
export const DEFAULT_INSTALL_DIRS: readonly CatalogInstallDir[] = [{ path: "." }];

/**
 * The directories the packer installs, in order: `installDirs`, or the root
 * when omitted. Empty when the entry lists none (`installDirs: []`).
 */
export function installDirList(install: {
  installDirs?: readonly CatalogInstallDir[] | undefined;
}): readonly CatalogInstallDir[] {
  return install.installDirs ?? DEFAULT_INSTALL_DIRS;
}
