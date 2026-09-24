// Smoke test for the built package (`pnpm test:dist` builds first). Runs dist/
// the way an installed package does, with no TypeScript loader: `--help` and
// `--version` through the bin launcher, the single `create-appflare` bin, the library entry's exports, and that the
// dependency's wrangler bin resolves. Touches no network and no account.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`smoke-dist: ${message}\n`);
  process.exit(1);
}

const bin = path.join(pkgDir, "bin", "appflare.js");
const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
if (help.status !== 0 || !help.stdout.includes("npx create-appflare")) {
  fail(`--help exited ${help.status}\n${help.stdout}\n${help.stderr}`);
}
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
  fail(`--version exited ${version.status}\n${version.stdout}\n${version.stderr}`);
}
if (JSON.stringify(Object.keys(pkg.bin)) !== JSON.stringify(["create-appflare"])) {
  fail(`the package's bins are ${Object.keys(pkg.bin).join(", ")}, not only create-appflare`);
}

const lib = await import(path.join(pkgDir, "dist", "index.js"));
for (const name of [
  "main",
  "verifyArtifact",
  "unpackArtifact",
  "buildWranglerConfig",
  "createWrangler",
]) {
  if (typeof lib[name] !== "function") fail(`dist/index.js does not export ${name}`);
}
if (typeof lib.resolveWranglerBin !== "function" || !existsSync(lib.resolveWranglerBin())) {
  fail("the wrangler dependency's bin does not resolve");
}
process.stdout.write("smoke-dist: ok\n");
