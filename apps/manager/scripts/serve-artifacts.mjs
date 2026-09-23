// Local stand-in for the catalog (GitHub Pages index.json + GitHub Release
// assets) so `pnpm --filter @appflare/manager dev` can browse and install signed
// artifacts without publishing them.
//
//   node scripts/serve-artifacts.mjs <dir> [--port 8766] [--host 127.0.0.1]
//
// <dir> is one artifact directory (manifest.json, manifest.sig, <slug>-<version>.zip)
// or a directory of them (<dir>/<slug>/...). The script writes <dir>/index.json
// listing every artifact it found, using the catalog's rules
// (appflare/catalog scripts/lib/index-builder.ts): release-style URLs
// `<base>/releases/download/<slug>@<version>/{<slug>-<version>.zip,manifest.json,manifest.sig}`
// and `digest` = sha256 of the exact manifest.json bytes. It then serves the
// index and the files, honouring `Range: bytes=a-b` with 206 like GitHub's asset
// host, because the manager reads every file of the zip as a byte range.
//
// Point the manager at it with CATALOG_INDEX_URL=http://127.0.0.1:8766/index.json
// in apps/manager/.dev.vars (`pnpm --filter @appflare/manager dev:init` adds it).
// Only use copies of artifacts: index.json is written into <dir>.
//
// Artifacts of the manager itself (`app: "appflare"`, from `pnpm release:pack`) are
// not catalog apps: they are left out of index.json and listed instead as a
// GitHub-style releases feed at <base>/releases (tags `manager@<version>`, assets
// `appflare-<version>.zip`, `manifest.json`, `manifest.sig`). Point the manager's
// release check at it with MANAGER_RELEASES_URL=http://127.0.0.1:8766/releases.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string", default: "8766" },
    host: { type: "string", default: "127.0.0.1" },
  },
});
const root = positionals[0];
if (!root) {
  console.error("usage: node scripts/serve-artifacts.mjs <dir> [--port 8766] [--host 127.0.0.1]");
  process.exit(2);
}
const dir = resolve(root);
const port = Number(values.port);
const base = `http://${values.host}:${port}`;

/** Directories that hold one artifact each. */
function artifactDirs() {
  if (existsSync(join(dir, "manifest.json"))) return [dir];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, "manifest.json")));
}

/** `<slug>@<version>/<file>` -> absolute path on disk. */
const files = new Map();
const apps = [];
/** The manager's own releases, GitHub-shaped, newest first. */
const managerReleases = [];
for (const artifactDir of artifactDirs()) {
  const manifestBytes = readFileSync(join(artifactDir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const slug = manifest.app;
  const version = manifest.version;
  const zipName = `${slug}-${version}.zip`;
  const missing = [zipName, "manifest.sig"].filter((f) => !existsSync(join(artifactDir, f)));
  if (missing.length > 0) {
    console.error(`skipping ${artifactDir}: missing ${missing.join(", ")}`);
    continue;
  }
  const isManager = slug === "appflare";
  const tag = isManager ? `manager@${version}` : `${slug}@${version}`;
  for (const name of [zipName, "manifest.json", "manifest.sig"]) {
    files.set(`/releases/download/${tag}/${name}`, join(artifactDir, name));
  }
  const download = `${base}/releases/download/${tag}`;
  if (isManager) {
    managerReleases.push({
      tag_name: tag,
      name: tag,
      draft: false,
      prerelease: version.includes("-"),
      published_at: statSync(join(artifactDir, "manifest.json")).mtime.toISOString(),
      assets: [zipName, "manifest.json", "manifest.sig"].map((name) => ({
        name,
        browser_download_url: `${download}/${name}`,
      })),
    });
    continue;
  }
  const catalog = manifest.catalog ?? {};
  apps.push({
    slug,
    name: catalog.name ?? slug,
    summary: catalog.summary ?? "",
    version,
    artifacts: {
      zip: `${download}/${zipName}`,
      manifest: `${download}/manifest.json`,
      sig: `${download}/manifest.sig`,
    },
    digest: createHash("sha256").update(manifestBytes).digest("hex"),
    tier: catalog.install?.tier ?? "artifact",
    plan: catalog.plan ?? "free",
    requires: catalog.requires ?? [],
    lastVerified: null,
    maintainers: catalog.maintainers ?? [],
  });
}
apps.sort((a, b) => a.slug.localeCompare(b.slug));
const indexPath = join(dir, "index.json");
writeFileSync(
  indexPath,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), apps }, null, 2)}\n`,
);
files.set("/index.json", indexPath);

managerReleases.sort((a, b) => b.published_at.localeCompare(a.published_at));

createServer((req, res) => {
  const url = new URL(req.url ?? "/", base);
  if (req.method === "GET" && url.pathname === "/releases") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(managerReleases));
    console.log(`GET /releases -> 200`);
    return;
  }
  const path = files.get(url.pathname);
  if ((req.method !== "GET" && req.method !== "HEAD") || path === undefined || !existsSync(path)) {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    console.log(`${req.method} ${url.pathname} -> 404`);
    return;
  }
  const body = readFileSync(path);
  const type = path.endsWith(".json") ? "application/json" : "application/octet-stream";
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), body.length - 1);
    if (start > end || start >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` }).end();
      console.log(`${req.method} ${url.pathname} ${req.headers.range} -> 416`);
      return;
    }
    res.writeHead(206, {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${body.length}`,
      "content-length": end - start + 1,
    });
    res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    console.log(`${req.method} ${url.pathname} ${req.headers.range} -> 206`);
    return;
  }
  res.writeHead(200, {
    "content-type": type,
    "accept-ranges": "bytes",
    "content-length": body.length,
  });
  res.end(req.method === "HEAD" ? undefined : body);
  console.log(`${req.method} ${url.pathname} -> 200`);
}).listen(port, values.host, () => {
  console.log(`Serving ${apps.length} artifact(s) from ${dir}`);
  for (const app of apps) console.log(`  ${app.slug} ${app.version}`);
  console.log(`CATALOG_INDEX_URL=${base}/index.json`);
  if (managerReleases.length > 0) {
    console.log(`Serving ${managerReleases.length} Appflare release(s)`);
    for (const r of managerReleases) console.log(`  ${r.tag_name}`);
    console.log(`MANAGER_RELEASES_URL=${base}/releases`);
  }
});
