import { parseArgs } from "node:util";
import { install } from "./commands/install.ts";
import { rollback } from "./commands/rollback.ts";
import { sandboxDisable, sandboxEnable } from "./commands/sandbox.ts";
import { status } from "./commands/status.ts";
import { uninstall } from "./commands/uninstall.ts";
import type { CommandContext } from "./context.ts";
import { CancelledError } from "./ui.ts";

export const USAGE = `Appflare installer: installs and manages the Appflare manager in your Cloudflare account.

Usage:
  npx create-appflare [options]              install the manager (default command)
  npx @appflare/cli status [--name <name>] [--url <url>]
  npx @appflare/cli rollback [--name <name>] [--list | --to <version-id>] [--yes] [--url <url>]
  npx @appflare/cli uninstall --yes [--name <name>] [--purge [--i-understand-data-loss]] [--url <url>]
  npx @appflare/cli sandbox enable [--version <x.y.z> | --artifact-dir <dir>] [--yes]
  npx @appflare/cli sandbox disable --yes [--purge [--i-understand-data-loss]]

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
  --list                  print recent versions with ids and dates; change nothing
  --to <version-id>       version to roll back to (default: the previous deployment)
  -y, --yes               do not ask for confirmation
  --url <url>             the manager's URL for the health check afterwards

Uninstall options:
  --yes                   required; deletes the manager Worker (and its Workflow).
                          With several accounts it still asks which one; without a
                          terminal set CLOUDFLARE_ACCOUNT_ID.
  --purge                 also delete the manager's D1 database and KV namespace
                          (all its data): the ones the manager Worker is bound
                          to, or, if the Worker is gone, the ones named exactly
                          <name> and <name>-kv. Asks you to type the manager's
                          name. Installed apps are never touched.
  --i-understand-data-loss
                          with --yes --purge: do not ask for the name
  --url <url>             the manager's URL, to recognize it by /api/health
                          (default: looked up from the account)

Sandbox builds (needs Workers Paid):
  sandbox enable          deploy or update the sandbox Worker "appflare-sandbox",
                          which builds sandbox tier apps from their pinned commit
                          in Cloudflare Containers in your account. --version,
                          --artifact-dir, --yes and --allow-unsigned work as for
                          install. Each build runs a standard-1 container; a
                          10-minute build costs about US$0.012 beyond the usage
                          Workers Paid includes.
  sandbox disable --yes   delete the sandbox Worker and its container
                          applications. The R2 bucket appflare-builds (build
                          outputs and logs) stays unless --purge is given, which
                          asks you to type the sandbox Worker's name (or pass
                          --i-understand-data-loss).

It uses wrangler: log in with \`npx wrangler login\` first, or let the installer
open the login for you. With several accounts, set CLOUDFLARE_ACCOUNT_ID or pick
one when asked.
`;

const COMMANDS = ["install", "status", "rollback", "uninstall", "sandbox", "help"] as const;
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
            list: { type: "boolean", default: false },
            url: { type: "string" },
            yes: { type: "boolean", short: "y", default: false },
            help: { type: "boolean", short: "h" },
          },
        });
        if (values.help) {
          process.stdout.write(USAGE);
          return 0;
        }
        rejectPositionals(positionals);
        if (values.list && values.to !== undefined) {
          throw new Error("--list and --to cannot be used together");
        }
        await rollback(
          { name: values.name, to: values.to, list: values.list, url: values.url, yes: values.yes },
          ctx,
        );
        return 0;
      }
      case "uninstall": {
        const { values, positionals } = parseArgs({
          args,
          options: {
            name: { type: "string" },
            yes: { type: "boolean", short: "y", default: false },
            purge: { type: "boolean", default: false },
            url: { type: "string" },
            "i-understand-data-loss": { type: "boolean", default: false },
            help: { type: "boolean", short: "h" },
          },
        });
        if (values.help) {
          process.stdout.write(USAGE);
          return 0;
        }
        rejectPositionals(positionals);
        await uninstall(
          {
            name: values.name,
            yes: values.yes,
            purge: values.purge,
            iUnderstandDataLoss: values["i-understand-data-loss"],
            url: values.url,
          },
          ctx,
        );
        return 0;
      }
      case "sandbox":
        return await runSandbox(args, ctx);
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

/** `sandbox enable|disable`. */
async function runSandbox(args: string[], ctx: CommandContext): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "enable") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        version: { type: "string" },
        "artifact-dir": { type: "string" },
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
    await sandboxEnable(
      {
        version: values.version,
        artifactDir: values["artifact-dir"],
        yes: values.yes,
        allowUnsigned: values["allow-unsigned"],
      },
      ctx,
    );
    return 0;
  }
  if (sub === "disable") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        yes: { type: "boolean", short: "y", default: false },
        purge: { type: "boolean", default: false },
        "i-understand-data-loss": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    rejectPositionals(positionals);
    await sandboxDisable(
      {
        yes: values.yes,
        purge: values.purge,
        iUnderstandDataLoss: values["i-understand-data-loss"],
      },
      ctx,
    );
    return 0;
  }
  if (sub === undefined || sub === "--help" || sub === "-h") {
    process.stdout.write(USAGE);
    return sub === undefined ? 1 : 0;
  }
  throw new Error(`unknown sandbox command: ${sub} (use enable or disable)`);
}

function rejectPositionals(positionals: string[]): void {
  if (positionals.length > 0) {
    throw new Error(`unexpected argument: ${positionals[0]} (see --help)`);
  }
}
