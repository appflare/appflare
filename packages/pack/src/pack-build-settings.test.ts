import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pack } from "./pack.ts";

/** A catalog manifest for a checkout that installs nothing, as JSON. */
function catalog(overrides: Record<string, unknown> = {}, install: Record<string, unknown> = {}) {
  return {
    slug: "settings",
    name: "Settings",
    summary: "A Worker that exercises the packer's settings.",
    homepage: "https://github.com/appflare/appflare",
    repo: "appflare/appflare",
    license: "MIT",
    categories: ["utilities"],
    maintainers: ["appflare"],
    source: { ref: "v1.0.0", sha: "0123456789abcdef0123456789abcdef01234567" },
    install: {
      tier: "artifact",
      packageManager: "npm",
      wranglerConfig: "wrangler.jsonc",
      workerName: "settings",
      installDirs: [],
      ...install,
    },
    plan: "free",
    requires: [],
    secrets: [],
    vars: [],
    postInstall: [],
    tokenPermissions: [],
    ...overrides,
  };
}

let parent: string;
let dir: string;
let outDir: string;
let manifestPath: string;
let lines: string[];

function write(rel: string, content: string): void {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function setUp(config: Record<string, unknown>, entry = catalog()): void {
  write("wrangler.jsonc", JSON.stringify(config));
  writeFileSync(manifestPath, JSON.stringify(entry));
}

function run() {
  return pack({ checkoutDir: dir, manifestPath, outDir, logger: (line) => lines.push(line) });
}

const WORKER = {
  name: "settings",
  main: "src/index.js",
  compatibility_date: "2025-06-01",
};

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-settings-"));
  dir = path.join(parent, "checkout");
  outDir = path.join(parent, "out");
  manifestPath = path.join(parent, "appflare.jsonc");
  lines = [];
  write("src/index.js", 'export default { fetch: () => new Response("ok") };\n');
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

describe("build-time constants", () => {
  it("reach the build command, and the artifact's catalog manifest records them", async () => {
    write(
      "build.mjs",
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("public", { recursive: true });
writeFileSync("public/origin.txt", String(process.env.VITE_ORIGIN));`,
    );
    setUp(
      { ...WORKER, assets: { directory: "./public" } },
      catalog(
        {},
        { buildCommand: "node build.mjs", buildEnv: { VITE_ORIGIN: "https://example.com" } },
      ),
    );
    const result = await run();
    const asset = result.manifest.assets.files.find((f) => f.route === "/origin.txt");
    expect(asset?.size).toBe("https://example.com".length);
    expect(result.manifest.catalog.install.buildEnv).toEqual({
      VITE_ORIGIN: "https://example.com",
    });
    expect(lines).toContain(
      "build-time constants from install.buildEnv: VITE_ORIGIN (set for the build commands and the bundling; the artifact's catalog manifest records their values)",
    );
  }, 120_000);
});

describe("a build that writes nothing", () => {
  it("is refused, and nothing is written", async () => {
    write("usage.mjs", 'console.log("usage: tool [options]");');
    setUp(WORKER, catalog({}, { buildCommand: "node usage.mjs --cwd web run build" }));
    // Writing the fixture changed the checkout; let the file clock move past it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(run()).rejects.toThrow(/built nothing/);
  }, 120_000);
});

describe("static assets", () => {
  it("never include .git, .wrangler or node_modules, even from an assets directory of .", async () => {
    write("index.html", "<h1>hi</h1>\n");
    write(".git/HEAD", "ref: refs/heads/main\n");
    write(".wrangler/state/v3/d1.sqlite", "x");
    write("node_modules/left-pad/index.js", "module.exports = 1;\n");
    write("docs/node_modules/x.js", "1;\n");
    write(".assetsignore", "src\nwrangler.jsonc\n!node_modules\n");
    setUp({ ...WORKER, assets: { directory: "." } });
    const result = await run();
    const routes = result.manifest.assets.files.map((f) => f.route);
    expect(routes).toContain("/index.html");
    expect(routes.some((r) => /\/(\.git|\.wrangler|node_modules)\//.test(r))).toBe(false);
    expect(lines).toContain(
      "left .git, .wrangler, node_modules, docs/node_modules out of the static assets: a project's own .git, .wrangler, node_modules directories are never served",
    );
  }, 120_000);
});

describe("resource settings", () => {
  it("copy R2 lifecycle rules and Vectorize metadata indexes into the bindings, in format 6", async () => {
    setUp(
      {
        ...WORKER,
        r2_buckets: [{ binding: "FILES", bucket_name: "upstream-files" }],
        vectorize: [{ binding: "VECTORS", index_name: "upstream-index" }],
      },
      catalog({
        resources: {
          r2: { FILES: { lifecycle: [{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }] } },
          vectorize: {
            VECTORS: {
              dimensions: 3,
              metric: "cosine",
              metadataIndexes: [{ propertyName: "url", type: "string" }],
            },
          },
        },
      }),
    );
    const result = await run();
    expect(result.manifest.format).toBe(6);
    expect(result.manifest.worker.bindings).toEqual(
      expect.arrayContaining([
        {
          type: "r2_bucket",
          name: "FILES",
          lifecycle: [{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }],
        },
        {
          type: "vectorize",
          name: "VECTORS",
          dimensions: 3,
          metric: "cosine",
          metadataIndexes: [{ propertyName: "url", type: "string" }],
        },
      ]),
    );
  }, 120_000);

  it("refuse resources.r2 for a binding the wrangler config does not have", async () => {
    setUp(
      WORKER,
      catalog({
        resources: { r2: { FILES: { lifecycle: [{ id: "tmp", deleteAfterDays: 1 }] } } },
      }),
    );
    await expect(run()).rejects.toThrow(
      "the catalog manifest declares resources.r2.FILES, but the wrangler config has no R2 binding by that name",
    );
  }, 120_000);
});
