import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Builds and packs the manager's release artifact (docs/RELEASING.md):
 *
 *   APPFLARE_VERSION=<version> pnpm release:pack --out <dir> [--key-id appflare-2026-09]
 *
 * 1. builds @appflare/pack (and what it bundles) through turbo;
 * 2. builds the manager with `pnpm --filter @appflare/manager build`, APPFLARE_VERSION
 *    in the environment (vite.config.ts bakes it into the Worker's vars);
 *    The build also writes dist/server/wrangler.release.json (the generated
 *    config without the Worker's service binding to itself), which
 *    apps/manager/appflare.jsonc packs from;
 * 3. stamps apps/manager/appflare.jsonc's placeholder `source` with the version and
 *    `git rev-parse HEAD`, in a temp copy;
 * 4. runs `appflare-pack apps/manager --manifest <copy> --out <dir> --no-install
 *    [--key-id <id>]` (with --key-id: an unsigned intermediate for `appflare-pack
 *    sign`; without: a local `keyId: "unsigned"` build);
 * 5. runs `appflare-pack verify --hashes-only`, then the manager artifact checks in
 *    scripts/manager-release.ts (flags, bindings without ids, cron, SPA assets, and a
 *    zip holding nothing but the listed files).
 *
 * With `--app sandbox` it packs the sandbox Worker (apps/sandbox) instead:
 * no build step (the packer bundles its source with `wrangler deploy
 * --dry-run`), the deploy config is apps/sandbox/wrangler.jsonc with the
 * version stamped in (scripts/sandbox-release.ts), and the checks are the
 * sandbox Worker's. Its zip is `appflare-sandbox-<version>.zip`.
 *
 * Signing is deliberately not part of this script: the release workflow signs in
 * a separate job that holds the key and runs no build code.
 */

const USAGE =
  "usage: APPFLARE_VERSION=<version> pnpm release:pack --out <dir> [--key-id <id>] [--app manager|sandbox]\n";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK_BIN = path.join(ROOT, "packages", "pack", "bin", "appflare-pack.js");

/**
 * The environment for build and pack steps: no Cloudflare credentials and no
 * signing key, so nothing here can reach an account or see the key.
 */
function buildEnv(version: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^(CLOUDFLARE_|CF_API_)/.test(name) || name === "APPFLARE_SIGNING_KEY") {
      continue;
    }
    env[name] = value;
  }
  env.APPFLARE_VERSION = version;
  return env;
}

/**
 * Reads an environment variable. By name, not as `process.env.X`: Biome's turbo
 * env-var rule would otherwise ask for turbo.json declarations, but this script
 * never runs as a turbo task.
 */
function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  process.stderr.write(`$ ${command} ${args.join(" ")}\n`);
  const res = spawnSync(command, args, { cwd: ROOT, env, stdio: "inherit" });
  if (res.error) {
    throw new Error(`failed to run ${command}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${res.status}`);
  }
}

function gitHead(): string {
  const res = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = res.stdout?.trim() ?? "";
  if (res.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("could not read the commit SHA with `git rev-parse HEAD`");
  }
  const dirty = spawnSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" });
  if (dirty.stdout?.trim()) {
    process.stderr.write(
      `warning: the working tree has uncommitted changes; source.sha ${sha} does not describe them\n`,
    );
  }
  return sha;
}

/** `--app sandbox`: stamp the deploy config and the catalog manifest, pack, check. */
async function packSandbox(options: {
  outDir: string;
  keyId: string | undefined;
  sha: string;
  version: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { outDir, keyId, sha, version, env } = options;
  const release = await import("./manager-release.ts");
  const sandbox = await import("./sandbox-release.ts");
  mkdirSync(path.dirname(sandbox.SANDBOX_RELEASE_WRANGLER), { recursive: true });
  const config = sandbox.sandboxReleaseWranglerConfig(
    readFileSync(sandbox.SANDBOX_WRANGLER_SOURCE, "utf8"),
    version,
  );
  writeFileSync(sandbox.SANDBOX_RELEASE_WRANGLER, `${JSON.stringify(config, null, 2)}\n`);
  const tmp = mkdtempSync(path.join(tmpdir(), "appflare-release-"));
  try {
    const manifestPath = path.join(tmp, "appflare.json");
    const catalog = release.stampCatalogManifest(
      readFileSync(sandbox.SANDBOX_CATALOG_MANIFEST, "utf8"),
      { version, sha },
    );
    writeFileSync(manifestPath, `${JSON.stringify(catalog, null, 2)}\n`);
    run(
      process.execPath,
      [
        PACK_BIN,
        sandbox.SANDBOX_DIR,
        "--manifest",
        manifestPath,
        "--out",
        outDir,
        "--no-install",
        ...(keyId ? ["--key-id", keyId] : []),
      ],
      env,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  run(process.execPath, [PACK_BIN, "verify", outDir, "--hashes-only"], env);
  const problems = sandbox.checkSandboxArtifactDir(outDir, {
    version,
    sha,
    keyId: keyId ?? "unsigned",
  });
  if (problems.length > 0) {
    throw new Error(`the packed sandbox Worker artifact is wrong:\n  - ${problems.join("\n  - ")}`);
  }
  process.stderr.write("sandbox Worker artifact checks: OK\n");
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    // `pnpm release:pack -- --out x` passes the `--` through; drop it.
    args: argv.filter((arg) => arg !== "--"),
    options: {
      out: { type: "string" },
      "key-id": { type: "string" },
      app: { type: "string", default: "manager" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!values.out) {
    process.stderr.write(`error: --out is required\n${USAGE}`);
    return 1;
  }
  const app = values.app;
  if (app !== "manager" && app !== "sandbox") {
    process.stderr.write(`error: --app must be manager or sandbox, not "${app}"\n${USAGE}`);
    return 1;
  }
  const version = readEnv("APPFLARE_VERSION");
  if (!version) {
    process.stderr.write(`error: APPFLARE_VERSION is not set\n${USAGE}`);
    return 1;
  }
  // pnpm runs root scripts from the root; resolve --out against where it was typed.
  const outDir = path.resolve(readEnv("INIT_CWD") || process.cwd(), values.out);
  // The packer renames its outputs into place; a leftover manifest.sig from an
  // earlier run would silently survive next to a new manifest.json.
  if (existsSync(outDir) && readdirSync(outDir).length > 0) {
    process.stderr.write(`error: ${outDir} exists and is not empty\n`);
    return 1;
  }
  const keyId = values["key-id"];
  const sha = gitHead();
  const env = buildEnv(version);

  // Also builds @appflare/schema's dist/, which the sandbox Worker bundles.
  run("pnpm", ["exec", "turbo", "run", "build", "--filter=@appflare/pack..."], env);
  // Imported only now: it loads @appflare/pack and @appflare/schema from dist/.
  const release = await import("./manager-release.ts");
  if (!release.isReleaseVersion(version)) {
    process.stderr.write(`error: APPFLARE_VERSION "${version}" is not semver (no leading v)\n`);
    return 1;
  }
  if (app === "sandbox") {
    await packSandbox({ outDir, keyId, sha, version, env });
    return 0;
  }
  // Not through turbo: turbo passes only declared env vars to tasks and would
  // replay a cached build baked with another version.
  run("pnpm", ["--filter", "@appflare/manager", "build"], env);
  const built = JSON.parse(readFileSync(release.MANAGER_BUILT_WRANGLER, "utf8")) as {
    vars?: Record<string, unknown>;
  };
  if (built.vars?.APPFLARE_VERSION !== version) {
    throw new Error(
      `the build baked APPFLARE_VERSION=${JSON.stringify(built.vars?.APPFLARE_VERSION)}, expected "${version}"`,
    );
  }

  if (!existsSync(release.MANAGER_RELEASE_WRANGLER)) {
    throw new Error(`the build did not write ${release.MANAGER_RELEASE_WRANGLER}`);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "appflare-release-"));
  try {
    const manifestPath = path.join(tmp, "appflare.json");
    const catalog = release.stampCatalogManifest(
      readFileSync(release.MANAGER_CATALOG_MANIFEST, "utf8"),
      { version, sha },
    );
    writeFileSync(manifestPath, `${JSON.stringify(catalog, null, 2)}\n`);
    run(
      process.execPath,
      [
        PACK_BIN,
        release.MANAGER_DIR,
        "--manifest",
        manifestPath,
        "--out",
        outDir,
        "--no-install",
        ...(keyId ? ["--key-id", keyId] : []),
      ],
      env,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // verify validates manifest.json against the schema and every file's hashes;
  // the manager checks below rely on that.
  run(process.execPath, [PACK_BIN, "verify", outDir, "--hashes-only"], env);
  const problems = release.checkManagerArtifactDir(outDir, {
    version,
    sha,
    keyId: keyId ?? "unsigned",
  });
  if (problems.length > 0) {
    throw new Error(`the packed manager artifact is wrong:\n  - ${problems.join("\n  - ")}`);
  }
  process.stderr.write("manager artifact checks: OK\n");
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
