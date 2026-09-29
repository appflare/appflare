// Packs the package the way it goes to npm: `pnpm pack` (workspace versions
// resolved, publishConfig applied) from a manifest without devDependencies.
// Those are workspace packages that are never published and only matter for
// the build, which bundles them into dist/. Restores package.json afterwards,
// then checks that the packed manifest names no workspace package and prints
// the tarball's path.
//
// Usage: node scripts/pack.mjs <destination directory>   (after `pnpm build`)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(pkgDir, "package.json");

function fail(message) {
  process.stderr.write(`pack: ${message}\n`);
  process.exit(1);
}

const destination = process.argv[2];
if (!destination) fail("usage: node scripts/pack.mjs <destination directory>");
const dest = path.resolve(destination);
mkdirSync(dest, { recursive: true });

const original = readFileSync(manifestPath, "utf8");
const pkg = JSON.parse(original);
const { devDependencies: _dropped, ...published } = pkg;
let packed;
try {
  writeFileSync(manifestPath, `${JSON.stringify(published, null, 2)}\n`);
  // pnpm's own output goes to stderr, so stdout carries only the path.
  packed = spawnSync("pnpm", ["pack", "--pack-destination", dest], {
    cwd: pkgDir,
    stdio: ["ignore", 2, 2],
  });
} finally {
  writeFileSync(manifestPath, original);
}
if (packed.error) fail(`pnpm pack did not run: ${packed.error.message}`);
if (packed.status !== 0) fail(`pnpm pack exited ${packed.status}`);

const tarball = path.join(dest, `${pkg.name}-${pkg.version}.tgz`);
const read = spawnSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" });
if (read.status !== 0) fail(`cannot read package.json from ${tarball}: ${read.stderr}`);
const manifest = JSON.parse(read.stdout);
if ("devDependencies" in manifest) fail("the packed package.json has devDependencies");
if (/"@appflare\/|workspace:/.test(read.stdout)) {
  fail("the packed package.json names a workspace package");
}
process.stdout.write(`${tarball}\n`);
