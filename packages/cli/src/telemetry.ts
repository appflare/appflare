import { readFileSync } from "node:fs";
import {
  commonTelemetryProperties,
  INSTALL_ID_VAR,
  TELEMETRY_BATCH_URL,
  TELEMETRY_DOCS_URL,
  TELEMETRY_VAR,
  type TelemetryValue,
  telemetryBatchBody,
  telemetryLock,
} from "@appflare/schema";
import type { FetchLike } from "./release.ts";
import type { Ui } from "./ui.ts";
import { CancelledError } from "./ui.ts";

/**
 * The installer's anonymous usage data: one event per run, sent when the
 * install ends (whether it worked, failed, or was cancelled), never earlier.
 * It says how it ended, how long it took, the step it reached and
 * an error category, and the machine's OS, CPU architecture and Node.js major
 * version. It never says the account, the Worker's name, paths, the user's
 * name or hostname, or any message text.
 *
 * `--no-telemetry`, `APPFLARE_TELEMETRY=off` (or `0`, `false`) or
 * `DO_NOT_TRACK=1` turn it off; `create-appflare` then deploys the manager
 * with `APPFLARE_TELEMETRY=off`, which keeps the manager's usage data off too.
 * Otherwise it deploys the manager with the random install id of this run, so
 * the manager's events continue it.
 */

/** How far the install got; `last_step` of the event and the source of its error category. */
export type CliStep =
  | "start"
  | "node_version"
  | "login"
  | "account"
  | "release_download"
  | "verify"
  | "preflight"
  | "deploy"
  | "secrets"
  | "health"
  | "run"
  | "done";

const ERROR_BY_STEP: Partial<Record<CliStep, string>> = {
  node_version: "node_version",
  login: "wrangler_login",
  account: "account_selection",
  release_download: "release_download",
  verify: "artifact_integrity",
  preflight: "preflight_conflict",
  deploy: "wrangler_deploy",
  secrets: "secret_put",
  health: "health_timeout",
};

/** How long a send may hold up the end of a run. */
export const SEND_TIMEOUT_MS = 3000;

/** Environment variables a coding agent sets, and the agent's name; first match wins. */
const AGENT_VARIABLES: readonly [readonly string[], string][] = [
  [["CURSOR_TRACE_ID"], "cursor"],
  [["CURSOR_AGENT"], "cursor-cli"],
  [["GEMINI_CLI"], "gemini"],
  [["CODEX_SANDBOX", "CODEX_CI", "CODEX_THREAD_ID"], "codex"],
  [["ANTIGRAVITY_AGENT"], "antigravity"],
  [["AUGMENT_AGENT"], "augment-cli"],
  [["OPENCODE_CLIENT"], "opencode"],
  [["CLAUDECODE", "CLAUDE_CODE"], "claude"],
  [["REPL_ID"], "replit"],
  [["COPILOT_MODEL"], "github-copilot"],
];

/**
 * The coding agent running the CLI, from the environment variables agents
 * set (the table of Vercel's `@vercel/detect-agent`). `CURSOR_TRACE_ID` is
 * also set in a person's own Cursor terminal, so `cursor` means "probably".
 */
export function detectAgent(env: NodeJS.ProcessEnv): string {
  const named = env.AI_AGENT?.trim().toLowerCase();
  // Only a short token: the variable is free text and must not carry anything else.
  if (named && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(named)) return named;
  for (const [variables, agent] of AGENT_VARIABLES) {
    if (variables.some((name) => env[name])) return agent;
  }
  return "none";
}

/** `CI` set to anything but empty, `0` or `false`. */
export function isCi(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** This package's version, from its package.json (one level above both `src/` and `dist/`). */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** The notice, printed once per run before anything could be sent. */
export function telemetryNotice(): string[] {
  return [
    "Appflare sends anonymous usage data (versions, OS, errors; never account ids, names",
    `or domains). Turn it off with --no-telemetry or ${TELEMETRY_VAR}=off.`,
    `Details: ${TELEMETRY_DOCS_URL}`,
  ];
}

export interface CliTelemetryOptions {
  env: NodeJS.ProcessEnv;
  /** `--no-telemetry` was given. */
  optOut: boolean;
  fetch: FetchLike;
  ui: Ui;
  now?: () => number;
  /** TTY on stdin and stdout; the process's by default. */
  interactive?: boolean;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  version?: string;
}

/** One run's usage data. Every method is safe to call when it is off. */
export class CliTelemetry {
  /** Whether this run may send. */
  enabled: boolean;
  yesFlag = false;
  /** The run got past its argument checks and printed the notice; only then is an event sent. */
  started = false;
  /** The install id events are tied to; null when off. */
  installId: string | null;
  step: CliStep = "start";
  managerVersion: string | null = null;
  severalAccounts: boolean | null = null;
  loginNeeded: boolean | null = null;
  nameIsDefault: boolean | null = null;
  private startedAt: number;

  constructor(private readonly options: CliTelemetryOptions) {
    this.enabled = !options.optOut && telemetryLock(options.env) === null;
    this.installId = this.enabled ? crypto.randomUUID() : null;
    this.startedAt = (options.now ?? Date.now)();
  }

  /** The install starts: prints the notice once, when usage data is on. */
  begin(yesFlag: boolean): void {
    if (this.started) return;
    this.started = true;
    this.yesFlag = yesFlag;
    this.startedAt = (this.options.now ?? Date.now)();
    if (!this.enabled) return;
    for (const line of telemetryNotice()) this.options.ui.info(line);
  }

  /** The variables `create-appflare` deploys the manager with. */
  managerVars(): Record<string, string> {
    return this.enabled && this.installId !== null
      ? { [INSTALL_ID_VAR]: this.installId }
      : { [TELEMETRY_VAR]: "off" };
  }

  /** The event's properties for an ending. */
  properties(
    outcome: "succeeded" | "failed" | "cancelled",
    error?: unknown,
  ): Record<string, TelemetryValue> {
    const { options } = this;
    const now = (options.now ?? Date.now)();
    const errorCategory =
      outcome === "succeeded"
        ? null
        : error instanceof CancelledError || outcome === "cancelled"
          ? "cancelled"
          : (ERROR_BY_STEP[this.step] ?? "unknown");
    const nodeMajor = Number((options.nodeVersion ?? process.versions.node).split(".")[0]);
    return {
      ...commonTelemetryProperties("cli", this.managerVersion),
      outcome,
      duration_s: Math.max(0, Math.round((now - this.startedAt) / 1000)),
      error_category: errorCategory,
      last_step: this.step,
      cli_version: options.version ?? cliVersion(),
      os: options.platform ?? process.platform,
      arch: options.arch ?? process.arch,
      node_major: Number.isFinite(nodeMajor) ? nodeMajor : null,
      interactive: options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      ci: isCi(options.env.CI),
      yes_flag: this.yesFlag,
      name_is_default: this.nameIsDefault,
      several_accounts: this.severalAccounts,
      login_needed: this.loginNeeded,
      agent: detectAgent(options.env),
    };
  }

  /**
   * Sends the run's one event and waits for it, at most
   * {@link SEND_TIMEOUT_MS}. A failure is ignored.
   */
  async finish(outcome: "succeeded" | "failed" | "cancelled", error?: unknown): Promise<void> {
    if (!this.started || !this.enabled || this.installId === null) return;
    if (outcome === "succeeded") this.step = "done";
    const body = telemetryBatchBody(this.installId, [
      {
        event: "cli setup finished",
        uuid: crypto.randomUUID(),
        timestamp: new Date((this.options.now ?? Date.now)()).toISOString(),
        properties: this.properties(outcome, error),
      },
    ]);
    try {
      const response = await this.options.fetch(TELEMETRY_BATCH_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      await response.body?.cancel();
    } catch {
      // Usage data never affects a run.
    }
  }
}
