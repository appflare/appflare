// Smoke test for the built package (`pnpm test:dist` builds first). Runs dist/
// the way an installed package does, with no TypeScript loader: `--help`
// through the bin launcher, the library entry's exports, and that the
// dependency's wrangler bin resolves. Touches no network and no account.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`smoke-dist: ${message}\n`);
  process.exit(1);
}

const help = spawnSync(process.execPath, [path.join(pkgDir, "bin", "appflare.js"), "--help"], {
  encoding: "utf8",
});
if (help.status !== 0 || !help.stdout.includes("npx create-appflare")) {
  fail(`--help exited ${help.status}\n${help.stdout}\n${help.stderr}`);
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
