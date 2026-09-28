// Checks the built manager (run by `pnpm test:dist`, which builds first) for
// Kumo's spinner ring. The manager draws every busy state with the Appflare
// mark; the ring's stroke-dasharray keyframes ("0 150;42 150") appear in no
// other code, so finding them means the ring has come back into the bundle,
// through a new Kumo release or a component that imports it another way.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const RING_DASH_PATTERN = "0 150;42 150";
const dist = path.resolve(import.meta.dirname, "..", "dist");

function scripts(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(m?js|html)$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

const files = ["client", "server"].flatMap((part) => scripts(path.join(dist, part)));
if (!files.some((file) => file.endsWith(".js"))) {
  process.stderr.write(`check-no-kumo-ring: no built JavaScript under ${dist}; run the build\n`);
  process.exit(1);
}
const offenders = files.filter((file) => readFileSync(file, "utf8").includes(RING_DASH_PATTERN));
if (offenders.length > 0) {
  process.stderr.write(
    `check-no-kumo-ring: Kumo's spinner ring is in the build:\n${offenders
      .map((file) => `  ${path.relative(dist, file)}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}
process.stdout.write(`check-no-kumo-ring: ok (${files.length} files, no ring)\n`);
