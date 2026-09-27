import { spawn } from "node:child_process";
import {
  type Dirent,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCommandArgv, buildCommandProblem } from "@appflare/schema";

/**
 * Runs a catalog manifest's `install.buildCommand` in the checkout, each of
 * its commands once and in order: after the dependencies are installed (with
 * install scripts disabled) and before the packer reads the wrangler config
 * and bundles the Worker, so the config may name a file the build writes (for
 * example the Cloudflare Vite plugin's generated `wrangler.json`).
 *
 * Each command runs as a plain argv, never through a shell, in the packer's
 * scrubbed environment (no Cloudflare, signing, or CI credentials) with the
 * checkout's `node_modules/.bin` first on PATH, as a package script would
 * see it, and with pre and post hooks of package scripts turned off for pnpm
 * and npm ({@link BUILD_HOOKS_OFF_ENV}). The commands share one time limit;
 * when it runs out, or when a command ends, every process it started is
 * stopped, so nothing outlives it. The first command that fails ends the
 * build.
 */

/** How long a build may run, all its commands together, before the packer stops it: 15 minutes. */
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000;

/**
 * Added to every build command's environment so that running a package
 * script runs only that script, the way the dependency install runs with
 * `--ignore-scripts`: pnpm skips `pre<name>` and `post<name>` hooks with
 * `enable-pre-post-scripts` off (on by default in pnpm 10), and npm skips them,
 * and any nested install's lifecycle scripts, with `ignore-scripts` on (an
 * explicit `npm run <name>` still runs). A step a hook would have run is
 * listed as a command of its own instead. Checked with pnpm 10.34.5 and
 * npm 10; bun and classic yarn read neither setting.
 */
export const BUILD_HOOKS_OFF_ENV: Readonly<Record<string, string>> = {
  npm_config_enable_pre_post_scripts: "false",
  npm_config_ignore_scripts: "true",
};

/** Lines of the build's output quoted when it fails. */
export const BUILD_OUTPUT_TAIL_LINES = 40;

/** Output kept while the build runs; only its end is ever quoted. */
const OUTPUT_KEEP_BYTES = 64 * 1024;

/** The build command is not allowed, did not start, failed, or ran out of time. */
export class BuildCommandError extends Error {
  override name = "BuildCommandError";
}

export interface BuildCommandOptions {
  checkoutDir: string;
  command: string;
  /** How messages name the command. Default `install.buildCommand`. */
  label?: string;
  /** The scrubbed environment every child of the packer gets. */
  env: NodeJS.ProcessEnv;
  /**
   * The catalog manifest's build-time constants (`install.buildEnv`), set
   * in the command's environment over `env`. The schema refuses names the
   * build's tools read, so they change what the build writes, not how it runs.
   */
  buildEnv?: Readonly<Record<string, string>> | undefined;
  timeoutMs?: number;
  /**
   * How long to wait for the build's output to close after it exits or is
   * stopped. A process the build moved out of its group can hold the output
   * open; the packer stops waiting for it after this. Default 5 seconds.
   */
  exitGraceMs?: number;
  logger?: (message: string) => void;
}

/** The last `lines` non-empty lines of `output`. */
export function outputTail(output: string, lines: number = BUILD_OUTPUT_TAIL_LINES): string {
  const all = output.replace(/\r\n?/g, "\n").split("\n");
  while (all.length > 0 && all.at(-1)?.trim() === "") all.pop();
  return all.slice(-lines).join("\n");
}

/** Stops the build's whole process group; quietly does nothing once it is gone. */
function stopGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** What a build command that succeeded printed last. */
export interface BuildCommandResult {
  /** The last lines of its output ({@link outputTail}). */
  outputTail: string;
}

export async function runBuildCommand(options: BuildCommandOptions): Promise<BuildCommandResult> {
  const { checkoutDir, command } = options;
  const label = options.label ?? "install.buildCommand";
  const logger = options.logger ?? (() => {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const exitGraceMs = options.exitGraceMs ?? 5_000;
  const problem = buildCommandProblem(command);
  if (problem !== null) throw new BuildCommandError(`${label} ${problem}`);
  const [program, ...args] = buildCommandArgv(command);
  if (program === undefined) throw new BuildCommandError(`${label} is empty`);

  const bin = path.join(path.resolve(checkoutDir), "node_modules", ".bin");
  const inherited = options.env.PATH ?? options.env.Path ?? "";
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    ...options.buildEnv,
    ...BUILD_HOOKS_OFF_ENV,
    PATH: inherited.length > 0 ? `${bin}${path.delimiter}${inherited}` : bin,
  };

  logger(`running ${label}: ${command} (scrubbed environment)`);
  const started = Date.now();
  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    output: string;
  }>((resolve, reject) => {
    let output = "";
    const keep = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_KEEP_BYTES * 2) output = output.slice(-OUTPUT_KEEP_BYTES);
    };
    const child = spawn(program, args, {
      cwd: checkoutDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout stops everything the build started.
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    // Resolves once: when the output closes, or a short while after the build
    // exits (or is stopped) even if something it started elsewhere still
    // holds the output open, so nothing can keep the packer waiting.
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settle();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: exit?.code ?? code, signal: exit?.signal ?? signal, timedOut, output });
    };
    const armGrace = (): void => {
      grace ??= setTimeout(() => finish(null, null), exitGraceMs);
    };
    // Armed until the build is settled, whatever it leaves running.
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup(child.pid);
      armGrace();
    }, timeoutMs);
    // Its own process group does not get the terminal's Ctrl-C: pass an
    // interrupt of the packer on to the build, then let it end the packer.
    const onSignal = (signal: NodeJS.Signals): void => {
      stopGroup(child.pid);
      settle();
      process.kill(process.pid, signal);
    };
    function settle(): void {
      settled = true;
      clearTimeout(timer);
      if (grace !== undefined) clearTimeout(grace);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (error) => {
      if (settled) return;
      settle();
      reject(new BuildCommandError(`could not run ${label} "${command}": ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // A background process the build left running would hold its output open.
      stopGroup(child.pid);
      armGrace();
    });
    child.on("close", (code, signal) => finish(code, signal));
  });

  const tail = outputTail(outcome.output);
  const quoted = tail.length > 0 ? `; last lines of its output:\n${tail}` : "; it printed nothing";
  if (outcome.timedOut) {
    throw new BuildCommandError(
      `${label} "${command}" did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped${quoted}`,
    );
  }
  if (outcome.code !== 0) {
    const how =
      outcome.code === null
        ? `was killed by ${outcome.signal ?? "a signal"}`
        : `failed (exit ${outcome.code})`;
    throw new BuildCommandError(`${label} "${command}" ${how}${quoted}`);
  }
  logger(`${label} finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return { outputTail: tail };
}

/**
 * The file system's own clock now, as `mtimeMs` reads it: the modification
 * time of a file written for the purpose. File times come from the
 * kernel's coarse clock, which can lag `Date.now()` by a few milliseconds,
 * so comparing them with `Date.now()` could miss a file the build wrote at
 * once.
 */
function fileClockNow(): number {
  const dir = mkdtempSync(path.join(tmpdir(), "appflare-build-clock-"));
  try {
    const marker = path.join(dir, "now");
    writeFileSync(marker, "");
    return statSync(marker).mtimeMs;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Directory names never looked into: the checkout's git data. */
const UNWATCHED_DIRS = new Set([".git"]);

/**
 * Whether anything in `checkoutDir` was created, changed, removed or renamed
 * at or after `since` (a {@link fileClockNow} reading): a file's own
 * modification time for a change in place, its directory's for an entry
 * added, removed or renamed. `.git` is not looked into, and `node_modules`
 * directories last (a build that only generates code there, such as
 * `prisma generate`, still counts), stopping at the first change found.
 */
export function checkoutChangedSince(checkoutDir: string, since: number): boolean {
  const changed = (abs: string): boolean => {
    try {
      return lstatSync(abs).mtimeMs >= since;
    } catch {
      return true;
    }
  };
  if (changed(checkoutDir)) return true;
  const queue: string[] = [checkoutDir];
  const later: string[] = [];
  for (;;) {
    const dir = queue.shift() ?? later.shift();
    if (dir === undefined) return false;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && UNWATCHED_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (changed(abs)) return true;
      if (entry.isDirectory()) (entry.name === "node_modules" ? later : queue).push(abs);
    }
  }
}

export interface BuildCommandsOptions extends Omit<BuildCommandOptions, "command" | "label"> {
  /** The commands of `install.buildCommand`, in order (`buildCommandList`). */
  commands: readonly string[];
  /** For all the commands together. Default {@link DEFAULT_BUILD_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Runs every command of `install.buildCommand` in order with
 * {@link runBuildCommand}, stopping at the first that fails. They share one
 * time limit: each gets what the ones before it left. Every command is
 * checked before the first runs, so a bad one later in the list fails the
 * build before anything ran.
 *
 * A build that succeeds without creating, changing or removing a single file
 * in the checkout built nothing, and is refused: a command that prints its
 * usage and exits 0 (a tool given an option where it does not take one)
 * would otherwise pass, and the packer would bundle whatever the checkout
 * held. The commands are judged together, so one that only checks (a type
 * check) may sit beside the ones that write.
 */
export async function runBuildCommands(options: BuildCommandsOptions): Promise<void> {
  const { commands, ...rest } = options;
  const labels = commands.map((_, i) =>
    commands.length === 1
      ? "install.buildCommand"
      : `install.buildCommand (${i + 1} of ${commands.length})`,
  );
  commands.forEach((command, i) => {
    const problem = buildCommandProblem(command);
    if (problem !== null) throw new BuildCommandError(`${labels[i]} ${problem}`);
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const since = fileClockNow();
  let last: BuildCommandResult = { outputTail: "" };
  for (const [i, command] of commands.entries()) {
    last = await runBuildCommand({
      ...rest,
      command,
      label: labels[i],
      // At least a second, so a command that starts at the deadline still reports it.
      timeoutMs: Math.max(1_000, deadline - Date.now()),
    });
  }
  if (commands.length > 0 && !checkoutChangedSince(options.checkoutDir, since)) {
    const what =
      commands.length === 1
        ? `install.buildCommand "${commands[0]}"`
        : `the ${commands.length} commands of install.buildCommand (${commands.map((c) => `"${c}"`).join(", ")})`;
    const quoted =
      last.outputTail.length > 0
        ? `; last lines of its output:\n${last.outputTail}`
        : "; it printed nothing";
    throw new BuildCommandError(
      `${what} ran without an error but created, changed or removed no file in the checkout, so it built nothing. ` +
        "A command that prints its usage and exits 0 does this (a tool given an option it does not take there); " +
        `check that the command runs the build${quoted}`,
    );
  }
}
