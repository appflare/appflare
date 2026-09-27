import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pack } from "./pack.ts";
import { verify } from "./verify.ts";

/** A catalog manifest for a checkout without a `package.json`, as JSON. */
function catalog(overrides: Record<string, unknown> = {}, install: Record<string, unknown> = {}) {
  return {
    slug: "static",
    name: "Static",
    summary: "A static site with no Worker code.",
    homepage: "https://github.com/appflare/appflare",
    repo: "appflare/appflare",
    license: "MIT",
    categories: ["utilities"],
    maintainers: ["appflare"],
    source: { ref: "v2.0.0", sha: "0123456789abcdef0123456789abcdef01234567" },
    install: {
      tier: "artifact",
      packageManager: "npm",
      wranglerConfig: "wrangler.jsonc",
      workerName: "static",
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
  return pack({
    checkoutDir: dir,
    manifestPath,
    outDir,
    logger: (line) => lines.push(line),
  });
}

beforeEach(() => {
  parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-static-"));
  dir = path.join(parent, "checkout");
  outDir = path.join(parent, "out");
  manifestPath = path.join(parent, "appflare.jsonc");
  lines = [];
  write("public/index.html", "<!doctype html><h1>Static</h1>\n");
  write("public/css/site.css", "h1 { color: teal; }\n");
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

const STATIC = {
  name: "static",
  compatibility_date: "2025-06-01",
  compatibility_flags: ["nodejs_compat"],
  assets: { directory: "./public", not_found_handling: "single-page-application" },
};

describe("pack a Worker of static assets only", () => {
  it("records its assets and no modules, as format 5", async () => {
    // A template's observability block is left out: wrangler does not send it for such a Worker.
    setUp({ ...STATIC, observability: { enabled: true } });
    const res = await run();
    expect(res.manifest.format).toBe(5);
    expect(res.manifest.worker.mainModule).toBeUndefined();
    expect("mainModule" in res.manifest.worker).toBe(false);
    expect(res.manifest.worker.modules).toEqual([]);
    expect(res.manifest.worker.bindings).toEqual([]);
    expect(res.manifest.worker.observability).toBeNull();
    expect(res.manifest.worker.compatibilityDate).toBe("2025-06-01");
    expect(res.manifest.assets).toMatchObject({
      config: { not_found_handling: "single-page-application" },
      binding: null,
    });
    expect(res.manifest.assets.files.map((f) => f.route)).toEqual(["/css/site.css", "/index.html"]);
    expect(res.moduleCount).toBe(0);
    expect(res.workerSize.size).toBe(0);
    expect(lines).toContain(
      "install.installDirs is empty: no dependencies are installed; wrangler bundles the entry and its relative imports",
    );
    expect(lines.some((l) => l.includes("serves its static assets only"))).toBe(true);
    expect(lines.some((l) => l.includes("sets observability"))).toBe(true);
    await expect(verify({ dir: outDir, checkUpload: true })).resolves.toMatchObject({
      ok: true,
      checkedFiles: 2,
    });
  }, 120_000);

  it("refuses bindings, which nothing could use, and writes nothing", async () => {
    setUp({ ...STATIC, kv_namespaces: [{ binding: "CACHE", id: "0".repeat(32) }] });
    await expect(run()).rejects.toThrow(
      /The Worker has bindings \(CACHE\), but it has no code of its own/,
    );
    expect(existsSync(outDir)).toBe(false);
  }, 120_000);

  it("refuses vars, crons, and catalog secrets", async () => {
    setUp(
      { ...STATIC, vars: { MODE: "prod" }, triggers: { crons: ["0 0 * * *"] } },
      catalog({
        secrets: [{ name: "TOKEN", label: "Token", help: "An API token.", generate: true }],
      }),
    );
    await expect(run()).rejects.toThrow(
      /bindings \(MODE\), catalog secrets \(TOKEN\), cron triggers, but it has no code/,
    );
  }, 120_000);

  it("refuses an assets binding before wrangler does", async () => {
    setUp({ ...STATIC, assets: { ...STATIC.assets, binding: "ASSETS" } });
    await expect(run()).rejects.toThrow(/an assets binding \(ASSETS\)/);
  }, 120_000);

  it("refuses a config with neither main nor assets", async () => {
    setUp({ name: "static", compatibility_date: "2025-06-01" });
    await expect(run()).rejects.toThrow(/has no `main` entrypoint and no `assets.directory`/);
  }, 120_000);
});

describe("pack a checkout without a package.json (installDirs: [])", () => {
  it("installs nothing and bundles the entry's relative imports", async () => {
    write(
      "src/index.js",
      'import { greet } from "./lib/greet.js";\nexport default { fetch: () => new Response(greet()) };\n',
    );
    write("src/lib/greet.js", 'export const greet = () => "hello from a relative import";\n');
    write(
      "gen.mjs",
      'import { writeFileSync } from "node:fs";\nwriteFileSync("public/built.txt", "built");\n',
    );
    setUp({ ...STATIC, main: "src/index.js" }, catalog({}, { buildCommand: "node gen.mjs" }));
    const res = await run();
    expect(res.manifest.format).toBe(1);
    expect(res.manifest.worker.mainModule).toBe("index.js");
    expect(res.manifest.worker.modules.map((m) => m.name)).toEqual(["index.js"]);
    const [module] = res.manifest.worker.modules;
    if (module === undefined) throw new Error("no module");
    const zip = readFileSync(res.zipPath);
    const code = zip.subarray(module.offset, module.offset + module.size).toString("utf8");
    expect(code).toContain("hello from a relative import");
    expect(res.manifest.assets.files.map((f) => f.route)).toContain("/built.txt");
    expect(lines).toContain(
      "the build commands run with no dependencies installed (install.installDirs is empty)",
    );
    expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  }, 120_000);

  it("fails at bundling when the entry imports a package", async () => {
    write("src/index.js", 'import { Hono } from "hono";\nexport default new Hono();\n');
    setUp({ ...STATIC, main: "src/index.js" });
    await expect(run()).rejects.toThrow(/wrangler deploy --dry-run failed/);
  }, 120_000);
});
