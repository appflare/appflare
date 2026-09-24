import type { BuildRequest, PackageManager } from "@appflare/schema";

/**
 * Paths, commands, and limits of one build inside the container. Everything
 * here is pure so the build steps stay readable and the tests can pin the
 * exact commands.
 */

/** Everything a build writes lives under this directory, removed before each build. */
export const WORK_ROOT = "/workspace/appflare-build";
/** The checkout of the pinned commit. */
export const SOURCE_DIR = `${WORK_ROOT}/source`;
/** The packer's output: the zip and manifest.json. */
export const OUT_DIR = `${WORK_ROOT}/out`;
/** The catalog manifest handed to the packer. */
export const MANIFEST_INPUT = `${WORK_ROOT}/appflare.json`;
/** Where the build's R2 prefix is mounted for the copy. */
export const MOUNT_DIR = "/mnt/appflare-builds";

/** How long each step may run, in milliseconds. */
export const STAGE_TIMEOUTS = {
  checkout: 5 * 60_000,
  install: 15 * 60_000,
  /** Includes the entry's build command, which the packer runs (its own limit: 15 minutes). */
  pack: 25 * 60_000,
  upload: 5 * 60_000,
  /** Short housekeeping commands (rm, ls, stat, git rev-parse). */
  quick: 60_000,
  /** A self-deploying app's `install.buildCommand`, run on its own (no packer). */
  build: 15 * 60_000,
  /**
   * A self-deploying app's installer: its deploy or destroy command. With the
   * checkout, install and build at their limits, a run takes at most 65
   * minutes plus housekeeping; the manager's step waits 75.
   */
  installer: 30 * 60_000,
} as const;

/** How often, at most, the build log is written to R2 while output arrives. */
export const LOG_FLUSH_INTERVAL_MS = 5_000;

/** Lines of output a failure message quotes. */
export const FAILURE_TAIL_LINES = 50;

/** The longest id the Sandbox SDK accepts (ids double as DNS labels). */
export const MAX_SANDBOX_ID_LENGTH = 63;

/**
 * The container for one install and pin: `build-<first 24 characters of the
 * install id>-<10 hex of its sha256>-<sha7>`, lower case, at most 49
 * characters whatever the install id (up to 64 characters) is. The hash keeps
 * ids that share a prefix apart. A retried build of the same pin lands in the
 * same container and starts from a clean work directory, unless the retry is
 * a later attempt of the caller's (see `attemptSuffix`).
 */
export async function sandboxId(
  installId: string,
  sha: string,
  attempt: number = 1,
): Promise<string> {
  return `build-${installId.slice(0, 24)}-${await installHash(installId)}-${sha.slice(0, 7)}${attemptSuffix(attempt)}`.toLowerCase();
}

/**
 * A later attempt at the same run gets a container of its own (`-a2`, ...):
 * the previous one may still be running, or restarting, after the run was cut
 * off, and wiping its work directory would pull it out from under it.
 */
function attemptSuffix(attempt: number): string {
  return attempt > 1 ? `-a${attempt}` : "";
}

/**
 * The container of an install's self-deploying runs: `self-<first 24
 * characters of the install id>-<10 hex of its sha256>`, lower case. One per
 * install, whatever the pin: an install's runs never overlap (the manager
 * runs one job per install at a time), and each starts from a clean work
 * directory.
 */
export async function selfManagedSandboxId(
  installId: string,
  attempt: number = 1,
): Promise<string> {
  return `self-${installId.slice(0, 24)}-${await installHash(installId)}${attemptSuffix(attempt)}`.toLowerCase();
}

/**
 * The container a run starts over in when a new version of this Worker reset
 * its first one as it started (see restart.ts): `<id>-r`, at most 56
 * characters for the ids above.
 */
export function freshSandboxId(id: string): string {
  return `${id}-r`;
}

async function installHash(installId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(installId));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 10);
}

export function cloneUrl(repo: string): string {
  return `https://github.com/${repo}.git`;
}

/** The wrangler project inside the checkout. */
export function projectDir(request: Pick<BuildRequest, "subdirectory">): string {
  return request.subdirectory ? `${SOURCE_DIR}/${request.subdirectory}` : SOURCE_DIR;
}

/** One shell word. Inputs are validated already; quoting keeps that true for the shell too. */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9@%+,./:=_-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** An argv as one command line (the sandbox runs command strings). */
export function commandLine(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

/**
 * The dependency install, with install scripts disabled: the same argv the
 * packer uses for a checkout, so a sandbox build installs exactly what a
 * catalog CI pack would.
 */
export function installArgv(packageManager: PackageManager): string[] {
  switch (packageManager) {
    case "pnpm":
      return [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--config.package-manager-strict=false",
      ];
    case "npm":
      return ["npm", "ci", "--ignore-scripts"];
    case "yarn":
      return ["yarn", "install", "--frozen-lockfile", "--ignore-scripts"];
    case "bun":
      return ["bun", "install", "--frozen-lockfile", "--ignore-scripts"];
  }
}

/**
 * The environment every build command gets on top of the container's own,
 * which holds no credentials: nothing in the container can reach an account.
 */
export const BUILD_ENV: Readonly<Record<string, string>> = {
  CI: "1",
  // Let the image's pnpm build a checkout that pins another pnpm version.
  COREPACK_ENABLE_STRICT: "0",
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_SEND_ERROR_REPORTS: "false",
  NO_UPDATE_NOTIFIER: "1",
  // Classic yarn reads this as well as --ignore-scripts, as the packer sets it.
  YARN_ENABLE_SCRIPTS: "false",
};

/** The packer, run on the checkout without a second install; it writes an unsigned artifact. */
export function packArgv(project: string): string[] {
  return ["appflare-pack", project, "--manifest", MANIFEST_INPUT, "--out", OUT_DIR, "--no-install"];
}

/** Minutes between two timestamps, one decimal. */
export function minutesBetween(startMs: number, endMs: number): number {
  return Math.round(Math.max(0, endMs - startMs) / 6_000) / 10;
}

/** The last `lines` non-empty lines of `text`. */
export function tailLines(text: string, lines: number = FAILURE_TAIL_LINES): string {
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  while (all.length > 0 && all.at(-1)?.trim() === "") all.pop();
  return all.slice(-lines).join("\n");
}
