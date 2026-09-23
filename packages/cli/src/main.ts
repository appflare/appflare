import { parseArgs } from "node:util";
import { install } from "./commands/install.ts";
import { rollback } from "./commands/rollback.ts";
import { status } from "./commands/status.ts";
import { uninstall } from "./commands/uninstall.ts";
import type { CommandContext } from "./context.ts";
import { CancelledError } from "./ui.ts";

export const USAGE = `Appflare installer: installs and manages the Appflare manager in your Cloudflare account.

Usage:
  npx create-appflare [options]              install the manager (default command)
  npx @appflare/cli status [--name <name>] [--url <url>]
  npx @appflare/cli rollback [--name <name>] [--to <version-id>] [--yes]
  npx @appflare/cli uninstall --yes [--name <name>]

Install options:
  --version <x.y.z>       manager release to install (default: the latest)
  --artifact-dir <dir>    use manifest.json, manifest.sig and appflare-<version>.zip
                          from <dir> instead of downloading a release
  --name <name>           Worker name (default: appflare)
  -y, --yes               never prompt; fail where a question would be needed
                          (several accounts, a Workflow name owned by another
                          Worker, no workers.dev subdomain yet)
  --allow-unsigned        development only (needs APPFLARE_DEV=1 and --artifact-dir):
                          accept an artifact without manifest.sig

Status options:
  --url <url>             the manager's URL (default: looked up from the account)

Rollback options:
  --to <version-id>       version to roll back to (default: the previous deployment)
  -y, --yes               do not ask for confirmation

Uninstall options:
  --yes                   required; deletes the manager Worker (and its Workflow)
                          only. With several accounts it still asks which one;
                          without a terminal set CLOUDFLARE_ACCOUNT_ID.

It uses wrangler: log in with \`npx wrangler login\` first, or let the installer
open the login for you. With several accounts, set CLOUDFLARE_ACCOUNT_ID or pick
one when asked.
`;

const COMMANDS = ["install", "status", "rollback", "uninstall", "help"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return (COMMANDS as readonly string[]).includes(value ?? "");
}

/** Splits `argv` into the command (default `install`) and its arguments. */
export function splitCommand(argv: string[]): { command: Command; args: string[] } {
  const [first, ...rest] = argv;
  return isCommand(first) ? { command: first, args: rest } : { command: "install", args: argv };
}

/** Runs the CLI. Returns the process exit code. */
export async function main(argv: string[], ctx: CommandContext): Promise<number> {
  const { command, args } = splitCommand(argv);
  if (command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    switch (command) {
      case "install": {
        const { values, positionals } = parseArgs({
          args,
          options: {
            version: { type: "string" },
            "artifact-dir": { type: "string" },
            name: { type: "string" },
            yes: { type: "boolean", short: "y", default: false },
            "allow-unsigned": { type: "boolean", default: false },
            help: { type: "boolean", short: "h" },
          },
        });
        if (values.help) {
          process.stdout.write(USAGE);
          return 0;
        }
        rejectPositionals(positionals);
        ctx.ui.banner();
        await install(
          {
            version: values.version,
            artifactDir: values["artifact-dir"],
            name: values.name,
            yes: values.yes,
            allowUnsigned: values["allow-unsigned"],
          },
          ctx,
        );
        return 0;
      }
      case "status": {
        const { values, positionals } = parseArgs({
          args,
          options: {
            name: { type: "string" },
            url: { type: "string" },
            help: { type: "boolean", short: "h" },
          },
        });
        if (values.help) {
          process.stdout.write(USAGE);
          return 0;
        }
        rejectPositionals(positionals);
        await status({ name: values.name, url: values.url }, ctx);
        return 0;
      }
      case "rollback": {
        const { values, positionals } = parseArgs({
          args,
          options: {
            name: { type: "string" },
            to: { type: "string" },
            yes: { type: "boolean", short: "y", default: false },
            help: { type: "boolean", short: "h" },
          },
        });
        if (values.help) {
          process.stdout.write(USAGE);
          return 0;
        }
        rejectPositionals(positionals);
        await rollback({ name: values.name, to: values.to, yes: values.yes }, ctx);
        return 0;
      }
      case "uninstall": {
        const { values, positionals } = parseArgs({
          args,
          options: {
            name: { type: "string" },
            yes: { type: "boolean", short: "y", default: false },
            help: { type: "boolean", short: "h" },
          },
        });
        if (values.help) {
          process.stdout.write(USAGE);
          return 0;
        }
        rejectPositionals(positionals);
        await uninstall({ name: values.name, yes: values.yes }, ctx);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof CancelledError) {
      process.stderr.write("Cancelled.\n");
      return 130;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nError: ${message}\n`);
    return 1;
  }
}

function rejectPositionals(positionals: string[]): void {
  if (positionals.length > 0) {
    throw new Error(`unexpected argument: ${positionals[0]} (see --help)`);
  }
}
