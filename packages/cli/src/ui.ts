import { confirm, isCancel, select } from "@clack/prompts";

/**
 * Everything the CLI says or asks. Progress, warnings, and prompts go to
 * stderr; only a command's result (the setup URL, the status report) goes to
 * stdout, so `create-appflare > link.txt` captures just the link.
 */
export interface Ui {
  /** Whether prompts can be shown (stdin and stderr are terminals). */
  readonly interactive: boolean;
  step(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  /** The command's result, on stdout. */
  result(message: string): void;
  confirm(message: string): Promise<boolean>;
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

/** The terminal UI: plain lines on stderr, prompts from @clack/prompts drawn on stderr. */
export function terminalUi(): Ui {
  const err = (line: string) => process.stderr.write(`${line}\n`);
  return {
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
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
