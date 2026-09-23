import { spawn } from "node:child_process";
import path from "node:path";
import { buildCommandArgv, buildCommandProblem } from "@appflare/schema";

/**
 * Runs a catalog manifest's `install.buildCommand` once in the checkout:
 * after the dependencies are installed (with install scripts disabled) and
 * before the packer reads the wrangler config and bundles the Worker, so the
 * config may name a file the build writes (for example the Cloudflare Vite
 * plugin's generated `wrangler.json`).
 *
 * The command runs as a plain argv, never through a shell, in the packer's
 * scrubbed environment (no Cloudflare, signing, or CI credentials) with the
 * checkout's `node_modules/.bin` first on PATH, as a package script would
 * see it. It gets a time limit; when it runs out, or when the build ends,
 * every process the build started is stopped, so nothing outlives it.
 */

/** How long a build may run before the packer stops it: 15 minutes. */
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000;

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
  /** The scrubbed environment every child of the packer gets. */
  env: NodeJS.ProcessEnv;
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

export async function runBuildCommand(options: BuildCommandOptions): Promise<void> {
  const { checkoutDir, command } = options;
  const logger = options.logger ?? (() => {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const exitGraceMs = options.exitGraceMs ?? 5_000;
  const problem = buildCommandProblem(command);
  if (problem !== null) throw new BuildCommandError(`install.buildCommand ${problem}`);
  const [program, ...args] = buildCommandArgv(command);
  if (program === undefined) throw new BuildCommandError("install.buildCommand is empty");

  const bin = path.join(path.resolve(checkoutDir), "node_modules", ".bin");
  const inherited = options.env.PATH ?? options.env.Path ?? "";
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    PATH: inherited.length > 0 ? `${bin}${path.delimiter}${inherited}` : bin,
  };

  logger(`running install.buildCommand: ${command} (scrubbed environment)`);
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
      reject(
        new BuildCommandError(`could not run install.buildCommand "${command}": ${error.message}`),
      );
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
      `install.buildCommand "${command}" did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped${quoted}`,
    );
  }
  if (outcome.code !== 0) {
    const how =
      outcome.code === null
        ? `was killed by ${outcome.signal ?? "a signal"}`
        : `failed (exit ${outcome.code})`;
    throw new BuildCommandError(`install.buildCommand "${command}" ${how}${quoted}`);
  }
  logger(`install.buildCommand finished in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
