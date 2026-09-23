import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Drives the `wrangler` the CLI depends on: resolved from the
 * CLI's own node_modules and run with the current Node binary, never a global
 * or shell `wrangler`. Every command runs from a private working directory with
 * an explicit `--config`, so a wrangler config or `.env` in the user's current
 * directory is never read.
 */

/** How a child's stdin is fed. */
export type StdinMode =
  /** Share the terminal (interactive prompts, OAuth login). */
  | { kind: "inherit" }
  /** No stdin: wrangler treats the run as non-interactive and uses defaults. */
  | { kind: "ignore" }
  /** Write this text, then close stdin (secret values). */
  | { kind: "text"; text: string };

/** One process to spawn. */
export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: StdinMode;
  /**
   * `capture`: collect stdout/stderr and return them. `stream`: send the
   * child's stdout and stderr to this process's stderr, keeping stdout free for
   * the CLI's own result. `tee`: both, so a command's output is shown as it
   * runs and can still be read afterwards (to explain a failure).
   */
  output: OutputMode;
}

export type OutputMode = "capture" | "stream" | "tee";

/** The outcome of a spawned process. `stdout`/`stderr` are empty when only streamed. */
export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Spawner = (request: SpawnRequest) => Promise<SpawnResult>;

/** Spawns with node:child_process. */
export const nodeSpawner: Spawner = (request) =>
  new Promise((resolve, reject) => {
    const stdin =
      request.stdin.kind === "inherit"
        ? "inherit"
        : request.stdin.kind === "ignore"
          ? "ignore"
          : "pipe";
    const out = request.output === "stream" ? process.stderr : "pipe";
    const echo = request.output === "tee";
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: [stdin, out, out],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (echo) process.stderr.write(chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
      if (echo) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
    if (request.stdin.kind === "text") {
      child.stdin?.end(request.stdin.text);
    }
  });

/** Absolute path of the `wrangler` bin script of the wrangler package this CLI depends on. */
export function resolveWranglerBin(): string {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    bin?: Record<string, string>;
  };
  const bin = pkg.bin?.wrangler;
  if (!bin) {
    throw new Error("the installed wrangler package declares no `wrangler` bin");
  }
  return path.resolve(path.dirname(packageJsonPath), bin);
}

/**
 * The environment for every wrangler child: the caller's environment, the
 * chosen account, and Appflare's no-telemetry defaults for
 * anything the user has not set explicitly.
 */
export function wranglerEnv(base: NodeJS.ProcessEnv, accountId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (accountId) {
    env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }
  env.WRANGLER_SEND_METRICS ??= "false";
  env.WRANGLER_SEND_ERROR_REPORTS ??= "false";
  env.WRANGLER_NO_SKILLS_UPDATE_PROMPTS ??= "true";
  env.WRANGLER_HIDE_BANNER ??= "true";
  return env;
}

/**
 * Argument lists for every wrangler command the CLI runs (wrangler 4.136).
 * Kept as data so tests pin them without spawning anything.
 */
export const wranglerArgs = {
  /** Prints `{"loggedIn":true,"accounts":[…],…}`; exits 1 with `{"loggedIn":false}`. */
  whoami: (): string[] => ["whoami", "--json"],
  /** Interactive OAuth in the browser. */
  login: (): string[] => ["login"],
  /**
   * `--strict` makes a non-interactive deploy abort instead of silently taking
   * over a Workflow name that belongs to another Worker (wrangler's
   * checkWorkflowConflicts) or overwriting remote changes. D1 and KV bindings
   * without ids are provisioned by default (`--experimental-provision` and
   * `--experimental-auto-create` both default to true in wrangler 4.136).
   */
  deploy: (configPath: string): string[] => ["deploy", "--config", configPath, "--strict"],
  /** Reads the value from stdin when stdin is not a TTY. */
  secretPut: (worker: string, secretName: string): string[] => [
    "secret",
    "put",
    secretName,
    "--name",
    worker,
  ],
  deploymentsList: (worker: string): string[] => [
    "deployments",
    "list",
    "--name",
    worker,
    "--json",
  ],
  versionsList: (worker: string): string[] => ["versions", "list", "--name", worker, "--json"],
  versionsView: (worker: string, versionId: string): string[] => [
    "versions",
    "view",
    versionId,
    "--name",
    worker,
    "--json",
  ],
  rollback: (worker: string, versionId: string, message: string): string[] => [
    "rollback",
    versionId,
    "--name",
    worker,
    "--message",
    message,
    "--yes",
  ],
  /**
   * `--force` skips wrangler's confirmation AND sends `force=true` on the
   * DELETE (wrangler 4.136.2), so the Worker is deleted even when other
   * Workers depend on it (service bindings, Durable Objects, tail consumers).
   * The CLI requires `--yes` before running it.
   */
  delete: (worker: string): string[] => ["delete", "--name", worker, "--force"],
  d1List: (): string[] => ["d1", "list", "--json"],
  /** `-y` skips wrangler's confirmation; the CLI confirms first. Looks the database up by name. */
  d1Delete: (databaseName: string): string[] => ["d1", "delete", databaseName, "-y"],
  /** By id, never by title; `-y` skips wrangler's confirmation. */
  kvDelete: (namespaceId: string): string[] => [
    "kv",
    "namespace",
    "delete",
    "--namespace-id",
    namespaceId,
    "-y",
  ],
  /** Prints JSON without a flag. */
  kvList: (): string[] => ["kv", "namespace", "list"],
  /** Fails while the bucket holds objects. */
  r2BucketDelete: (bucket: string): string[] => ["r2", "bucket", "delete", bucket],
  /** By application id; asks nothing when stdin is not a terminal. */
  containersDelete: (id: string): string[] => ["containers", "delete", id],
  /** Prints `{"type":"oauth"|"api_token",…,"token":…}`. Output must never be shown. */
  authToken: (): string[] => ["auth", "token", "--json"],
};

/** Options for {@link createWrangler}. */
export interface WranglerOptions {
  /** Private working directory for every command. */
  cwd: string;
  /** Config passed as `--config` to commands that do not pass their own. */
  configPath: string;
  /** Base environment (normally `process.env`). */
  env: NodeJS.ProcessEnv;
  spawner?: Spawner;
  /** Path to wrangler's bin script; resolved from node_modules by default. */
  bin?: string;
}

/** Per-command options for {@link Wrangler.run}. */
export interface RunOptions {
  stdin?: StdinMode;
  output?: OutputMode;
  /** Extra environment for this command only. */
  env?: NodeJS.ProcessEnv;
}

export interface Wrangler {
  /** The account every command targets once chosen (`CLOUDFLARE_ACCOUNT_ID`). */
  accountId: string | undefined;
  run(args: string[], options?: RunOptions): Promise<SpawnResult>;
}

class WranglerRunner implements Wrangler {
  accountId: string | undefined;
  #bin: string | undefined;
  readonly #options: WranglerOptions;
  readonly #spawner: Spawner;

  constructor(options: WranglerOptions) {
    this.#options = options;
    this.#bin = options.bin;
    this.#spawner = options.spawner ?? nodeSpawner;
  }

  run(args: string[], runOptions: RunOptions = {}): Promise<SpawnResult> {
    this.#bin ??= resolveWranglerBin();
    const withConfig = args.includes("--config")
      ? args
      : [...args, "--config", this.#options.configPath];
    return this.#spawner({
      command: process.execPath,
      args: [this.#bin, ...withConfig],
      cwd: this.#options.cwd,
      env: { ...wranglerEnv(this.#options.env, this.accountId), ...runOptions.env },
      stdin: runOptions.stdin ?? { kind: "ignore" },
      output: runOptions.output ?? "capture",
    });
  }
}

/** A wrangler runner bound to one working directory and (once chosen) one account. */
export function createWrangler(options: WranglerOptions): Wrangler {
  return new WranglerRunner(options);
}

/** Error for a wrangler command that exited non-zero. */
export class WranglerError extends Error {
  constructor(
    readonly command: string,
    readonly result: SpawnResult,
    options: { showOutput?: boolean } = {},
  ) {
    const output = options.showOutput === false ? "" : `${result.stderr}\n${result.stdout}`.trim();
    super(
      `\`wrangler ${command}\` failed (exit code ${result.code})${output ? `:\n${indent(output)}` : ""}`,
    );
    this.name = "WranglerError";
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Runs a capturing command and throws {@link WranglerError} unless it exits 0. */
export async function runOk(
  wrangler: Wrangler,
  args: string[],
  options?: RunOptions,
): Promise<SpawnResult> {
  const result = await wrangler.run(args, options);
  if (result.code !== 0) {
    throw new WranglerError(args.slice(0, 2).join(" "), result);
  }
  return result;
}

/** True when a failed wrangler command reported the Cloudflare API "not found" code for Workers. */
export function isWorkerNotFound(result: SpawnResult): boolean {
  return /\bcode: 10007\b/.test(`${result.stdout}\n${result.stderr}`);
}

/** Parses the JSON a `--json` wrangler command printed, with a readable error. */
export function parseJsonOutput(command: string, stdout: string): unknown {
  // wrangler may print warnings before the JSON document; take the first line
  // that opens one.
  const start = stdout.search(/^[[{]/m);
  if (start === -1) {
    throw new Error(`\`wrangler ${command}\` printed no JSON`);
  }
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    throw new Error(`\`wrangler ${command}\` printed output that is not valid JSON`);
  }
}
