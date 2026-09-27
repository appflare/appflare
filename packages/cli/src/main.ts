import { parseArgs } from "node:util";
import { install } from "./commands/install.ts";
import { recover } from "./commands/recover.ts";
import type { CommandContext } from "./context.ts";
import { MANAGER_ADDRESS_PLACEHOLDER, MANAGER_PAGES, managerPageRef } from "./manager-pages.ts";
import { CliTelemetry, cliVersion } from "./telemetry.ts";
import { CancelledError } from "./ui.ts";

export const USAGE = `create-appflare: installs Appflare, a self-hosted app manager for Cloudflare, into your Cloudflare account.

Usage:
  npx create-appflare [options]            install Appflare
  npx create-appflare recover [options]    get a one-time code to reset a forgotten
                                           admin password (--name, --yes and
                                           --email <admin email> apply)

Options:
  --version <x.y.z>       manager release to install (default: the latest)
  --artifact-dir <dir>    use manifest.json, manifest.sig and appflare-<version>.zip
                          from <dir> instead of downloading a release
  --name <name>           Worker name (default: appflare)
  -y, --yes               never prompt; fail where a question would be needed
                          (several accounts, a Workflow name owned by another
                          Worker, no workers.dev subdomain yet)
  --allow-unsigned        development only (needs APPFLARE_DEV=1 and --artifact-dir):
                          accept an artifact without manifest.sig
  --no-telemetry          send no anonymous usage data, and install the manager
                          with its usage data turned off (APPFLARE_TELEMETRY=off)
  -v, --version           print this installer's version (--version without a value)
  -h, --help              print this help

\`recover\` is for when the owner or an admin forgot their password. It needs the
same Cloudflare login as the install. It saves a code's fingerprint on the manager
Worker and prints the code, which works once, for 30 minutes, on the sign-in page
under "Forgot your password?". With --email, it works only for that admin. It sends
no usage data.

It uses wrangler: log in with \`npx wrangler login\` first, or let the installer
open the login for you. With several accounts, set CLOUDFLARE_ACCOUNT_ID or pick
one when asked.

Once the manager runs, you manage it from its own settings pages, at its address
(${MANAGER_ADDRESS_PLACEHOLDER} below):
  ${MANAGER_PAGES.updates.name}: the running version and updates
    ${MANAGER_ADDRESS_PLACEHOLDER}${MANAGER_PAGES.updates.path}
  ${MANAGER_PAGES.building.name}: enable, update or disable sandbox builds
    ${MANAGER_ADDRESS_PLACEHOLDER}${MANAGER_PAGES.building.path}
  ${MANAGER_PAGES.dangerZone.name}: remove the manager and its data
    ${MANAGER_ADDRESS_PLACEHOLDER}${MANAGER_PAGES.dangerZone.path}
To return to an earlier manager version, use ${MANAGER_PAGES.versions.name}; if
the manager does not load, roll back on the Worker's Deployments page in the
Cloudflare dashboard, or run \`npx wrangler rollback --name <name>\`.

The installer sends anonymous usage data (one event when it ends: outcome,
duration, error category, OS and Node.js version; never account ids, names or
domains). --no-telemetry, or APPFLARE_TELEMETRY=off or DO_NOT_TRACK=1 in the
environment, turns it off.
`;

/** The option that turns usage data off; removed before the install parses its own. */
export const NO_TELEMETRY_FLAG = "--no-telemetry";

/**
 * Commands earlier versions of this package had, and where each one's job is
 * done now. Named here so running one says where to go instead of only
 * "unexpected argument".
 */
export const REMOVED_COMMANDS: Readonly<Record<string, string>> = {
  status: `open ${managerPageRef(null, "updates")} in the manager: it shows the running version and updates`,
  rollback:
    "roll back on the manager Worker's Deployments page in the Cloudflare dashboard, or run `npx wrangler rollback --name <name>`",
  uninstall: `open ${managerPageRef(null, "dangerZone")} in the manager: Remove Appflare there removes it and its data`,
  sandbox: `open ${managerPageRef(null, "building")} in the manager: it enables, updates and disables sandbox builds`,
};

/**
 * Whether `argv` asks for the installer's own version: `-v`, or `--version`
 * with no value after it (`--version <x.y.z>` picks the manager release).
 */
export function wantsVersion(argv: readonly string[]): boolean {
  return argv.some((arg, i) => {
    if (arg === "-v") return true;
    if (arg !== "--version") return false;
    const next = argv[i + 1];
    return next === undefined || next.startsWith("-");
  });
}

/**
 * Runs `create-appflare`. Returns the process exit code. An install that
 * starts (past `--help`, `--version` and its argument checks) sends one
 * usage-data event when it ends, unless usage data is off.
 */
export async function main(argv: string[], ctx: CommandContext): Promise<number> {
  const optOut = argv.includes(NO_TELEMETRY_FLAG);
  const telemetry =
    ctx.telemetry ?? new CliTelemetry({ env: ctx.env, optOut, fetch: ctx.fetch, ui: ctx.ui });
  const args = argv.filter((a) => a !== NO_TELEMETRY_FLAG);
  let outcome: "succeeded" | "failed" | "cancelled" = "succeeded";
  let failure: unknown;
  try {
    return await run(args, { ...ctx, telemetry });
  } catch (error) {
    failure = error;
    if (error instanceof CancelledError) {
      outcome = "cancelled";
      process.stderr.write("Cancelled.\n");
      return 130;
    }
    outcome = "failed";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\nError: ${message}\n`);
    return 1;
  } finally {
    await telemetry.finish(outcome, failure);
  }
}

async function run(
  args: string[],
  ctx: CommandContext & { telemetry: CliTelemetry },
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    ctx.ui.result(USAGE.trimEnd());
    return 0;
  }
  if (wantsVersion(args)) {
    ctx.ui.result(cliVersion());
    return 0;
  }
  // Checked before parsing, so a removed command's own flags (`rollback --to`,
  // `uninstall --purge`) do not hide the pointer to its replacement.
  const [command] = args;
  const instead = command === undefined ? undefined : REMOVED_COMMANDS[command];
  if (instead !== undefined) {
    throw new Error(`\`${command}\` is no longer part of the installer; ${instead}.`);
  }
  if (command === "recover") {
    const { values } = parseArgs({
      args: args.slice(1),
      allowPositionals: false,
      options: {
        name: { type: "string" },
        email: { type: "string" },
        yes: { type: "boolean", short: "y", default: false },
      },
    });
    ctx.ui.banner();
    // No `telemetry.begin`: nothing is sent for a recovery.
    await recover({ name: values.name, email: values.email, yes: values.yes }, ctx);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      version: { type: "string" },
      "artifact-dir": { type: "string" },
      name: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      "allow-unsigned": { type: "boolean", default: false },
    },
  });
  const [unexpected] = positionals;
  if (unexpected !== undefined) {
    throw new Error(`unexpected argument: ${unexpected} (see --help)`);
  }
  ctx.ui.banner();
  ctx.telemetry.begin(values.yes);
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
