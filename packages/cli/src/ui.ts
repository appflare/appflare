import { confirm, isCancel, select, text } from "@clack/prompts";

/**
 * Everything the CLI says or asks. Progress, warnings, and prompts go to
 * stderr; only a command's result (the setup URL, the status report) goes to
 * stdout, so `create-appflare > link.txt` captures just the link.
 */
export interface Ui {
  /** Whether prompts can be shown (stdin and stderr are terminals). */
  readonly interactive: boolean;
  /** The one-line brand shown when `create-appflare` starts, on a terminal only. */
  banner(): void;
  step(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** The command's result, on stdout. */
  result(message: string): void;
  confirm(message: string): Promise<boolean>;
  /** Free-text input; returns what the user typed. */
  text(message: string, placeholder?: string): Promise<string>;
  select<T extends string>(
    message: string,
    options: { value: T; label: string; hint?: string }[],
  ): Promise<T>;
}

/** Thrown when the user cancels a prompt (Ctrl-C or Escape). */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/** The stream properties colour detection needs; `hasColors` exists only on terminals. */
export interface ColorTarget {
  isTTY?: boolean;
  hasColors?: (env?: NodeJS.ProcessEnv) => boolean;
}

/**
 * Whether to colour output on `stream`. A non-empty `NO_COLOR` always turns
 * colour off (https://no-color.org); otherwise only a terminal that reports
 * colour support gets it (Node also honours `FORCE_COLOR` and `TERM=dumb` there).
 */
export function colorEnabled(env: NodeJS.ProcessEnv, stream: ColorTarget): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  return Boolean(stream.isTTY && stream.hasColors?.(env));
}

/** "Appflare" and what it is, on one line; the name bold and the rest dim when `color` is on. */
export function formatBanner(color: boolean): string {
  const name = "Appflare";
  const tagline = "self-hosted app manager for Cloudflare";
  return color
    ? `\u001b[1m${name}\u001b[22m \u001b[2m· ${tagline}\u001b[22m`
    : `${name} · ${tagline}`;
}

/**
 * The banner line for `stream`, or `null` when `stream` is not a terminal: pipes
 * and CI logs get no brand line, only the progress that matters there.
 */
export function bannerFor(env: NodeJS.ProcessEnv, stream: ColorTarget): string | null {
  return stream.isTTY ? formatBanner(colorEnabled(env, stream)) : null;
}

/** The terminal UI: plain lines on stderr, prompts from @clack/prompts drawn on stderr. */
export function terminalUi(env: NodeJS.ProcessEnv = process.env): Ui {
  const err = (line: string) => process.stderr.write(`${line}\n`);
  return {
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    banner() {
      const line = bannerFor(env, process.stderr);
      if (line !== null) err(line);
    },
    step: (message) => err(`\n> ${message}`),
    info: (message) => err(`  ${message}`),
    warn: (message) => err(`! ${message}`),
    result: (message) => process.stdout.write(`${message}\n`),
    async confirm(message) {
      const answer = await confirm({ message, output: process.stderr });
      if (isCancel(answer)) {
        throw new CancelledError();
      }
      return answer;
    },
    async text(message, placeholder) {
      const answer = await text({ message, placeholder, output: process.stderr });
      if (isCancel(answer)) {
        throw new CancelledError();
      }
      return answer;
    },
    async select(message, options) {
      const answer = await select({
        message,
        // The option type is conditional on the value type; every value here is a string.
        options: options as Parameters<typeof select<string>>[0]["options"],
        output: process.stderr,
      });
      if (isCancel(answer)) {
        throw new CancelledError();
      }
      return answer as (typeof options)[number]["value"];
    },
  };
}
