import path from "node:path";
import { parseArgs } from "node:util";
import { buildDeployRepo } from "./deploy-repo.ts";

/**
 * Writes the contents of the public deploy repository (appflare/deploy) that
 * the "Deploy to Cloudflare" button deploys from, from one manager release
 * (scripts/deploy-repo.ts explains every choice):
 *
 *   node scripts/build-deploy-repo.ts --artifact-dir <release dir> --out <dir>
 *     [--version <x.y.z>] [--allow-unsigned] [--allow-legacy] [--no-lockfile]
 *
 * <release dir> holds manifest.json, manifest.sig, and appflare-<version>.zip,
 * as published on a manager@<version> GitHub Release or written by
 * `pnpm release:pack`. The signature is required unless --allow-unsigned (a
 * local build); every file's sha256 is checked before anything is written.
 * A release without a `version_metadata` binding predates token-first setup
 * and is refused; `--allow-legacy` (local experiments only) adds the binding.
 * `--no-lockfile` skips package-lock.json, which needs the npm registry.
 *
 * Needs @appflare/cli and @appflare/pack built (`pnpm exec turbo run build
 * --filter=@appflare/cli...`), since Node runs this file without the
 * workspace's source resolution.
 */

const USAGE =
  "usage: node scripts/build-deploy-repo.ts --artifact-dir <dir> --out <dir> [--version <x.y.z>] [--allow-unsigned] [--allow-legacy] [--no-lockfile]\n";

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    options: {
      "artifact-dir": { type: "string" },
      out: { type: "string" },
      version: { type: "string" },
      "allow-unsigned": { type: "boolean", default: false },
      "allow-legacy": { type: "boolean", default: false },
      "no-lockfile": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values["artifact-dir"] || !values.out) {
    process.stderr.write(`error: --artifact-dir and --out are required\n${USAGE}`);
    return 1;
  }
  const cwd = process.cwd();
  const outDir = path.resolve(cwd, values.out);
  const { version, problems } = await buildDeployRepo({
    artifactDir: path.resolve(cwd, values["artifact-dir"]),
    outDir,
    allowUnsigned: values["allow-unsigned"],
    allowLegacy: values["allow-legacy"],
    ...(values.version ? { expectedVersion: values.version } : {}),
    lockfile: !values["no-lockfile"],
  });
  if (problems.length > 0) {
    process.stderr.write(`the deploy repository is wrong:\n  - ${problems.join("\n  - ")}\n`);
    return 1;
  }
  process.stderr.write(`deploy repository for Appflare ${version} written to ${outDir}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
