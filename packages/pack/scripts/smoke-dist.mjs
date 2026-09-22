// Smoke test for the built package (run by `pnpm test:dist`, which builds
// first). Exercises dist/ exactly as an outside consumer would, with no
// TypeScript loader: imports the library entry, then packs fixtures/hello with
// the built CLI and verifies the result.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(pkgDir, "dist", "cli.js");

function fail(message) {
  process.stderr.write(`smoke-dist: ${message}\n`);
  process.exit(1);
}

const lib = await import(path.join(pkgDir, "dist", "index.js"));
for (const name of ["pack", "verify", "parseJsonc", "ZipStore"]) {
  if (typeof lib[name] !== "function") fail(`dist/index.js does not export ${name}`);
}

function run(args) {
  const res = spawnSync(process.execPath, [cli, ...args], { cwd: pkgDir, encoding: "utf8" });
  if (res.status !== 0) {
    fail(`\`appflare-pack ${args.join(" ")}\` exited ${res.status}\n${res.stdout}\n${res.stderr}`);
  }
  return res.stdout;
}

const outDir = mkdtempSync(path.join(tmpdir(), "appflare-smoke-"));
try {
  run(["--help"]);
  run([
    "fixtures/hello",
    "--manifest",
    "fixtures/hello/appflare.jsonc",
    "--out",
    outDir,
    "--no-install",
  ]);
  const verified = run(["verify", outDir]);
  if (!verified.startsWith("OK:")) fail(`unexpected verify output: ${verified}`);
  process.stdout.write(`smoke-dist: ok (${verified.trim()})\n`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
