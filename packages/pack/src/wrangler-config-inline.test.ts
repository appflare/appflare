import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CatalogManifest,
  catalogManifestSchema,
  PATCHED_WRANGLER_CONFIG,
} from "@appflare/schema";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigPatchError, workerSpecs, writeInlineConfigs } from "./config-patch.ts";
import { DEPLOY_CONFIG_PATH } from "./config-redirect.ts";
import { inspectWranglerConfig } from "./inspect.ts";
import { parseJsonc } from "./jsonc.ts";
import { pack } from "./pack.ts";

// Fixtures of apps whose repository ships no wrangler config, packed with
// real wrangler dry runs from the config the catalog manifest carries.

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function project(files: Record<string, string>): string {
  const dir = tempDir("appflare-inline-config-");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function catalog(slug: string, fields: Record<string, unknown>): CatalogManifest {
  const { install, ...rest } = fields as { install: Record<string, unknown> };
  return catalogManifestSchema.parse({
    slug,
    name: slug,
    summary: "An inline wrangler config fixture.",
    homepage: "https://example.com",
    repo: `example/${slug}`,
    license: "MIT",
    categories: ["utilities"],
    maintainers: ["example"],
    source: { ref: "v1.0.0", sha: "0123456789abcdef0123456789abcdef01234567" },
    install: { tier: "artifact", packageManager: "npm", workerName: slug, ...install },
    plan: "free",
    requires: [],
    secrets: [],
    vars: [],
    postInstall: [],
    tokenPermissions: [],
    ...rest,
  });
}

async function packWith(dir: string, manifest: CatalogManifest) {
  const manifestPath = path.join(tempDir("appflare-inline-manifest-"), "appflare.jsonc");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const outDir = path.join(tempDir("appflare-inline-out-"), "out");
  const logs: string[] = [];
  const result = await pack({
    checkoutDir: dir,
    manifestPath,
    outDir,
    install: false,
    logger: (m) => logs.push(m),
  });
  return { result, logs };
}

/** Rin: a blog whose upstream writes its wrangler config at deploy time and commits none. */
const RIN_CONFIG = {
  main: "server/src/_worker.ts",
  compatibility_date: "2026-01-20",
  assets: { directory: "./dist/client", binding: "ASSETS" },
  triggers: { crons: ["*/20 * * * *"] },
  vars: { S3_FOLDER: "images/", NAME: "Rin", PAGE_SIZE: "5" },
  placement: { mode: "smart" },
  d1_databases: [{ binding: "DB", database_name: "rin" }],
  ai: { binding: "AI" },
  queues: {
    producers: [{ binding: "JOB_QUEUE", queue: "rin-server-jobs" }],
    consumers: [{ queue: "rin-server-jobs", max_batch_size: 1, max_batch_timeout: 5 }],
  },
  r2_buckets: [{ binding: "R2_BUCKET" }],
};

const RIN_FILES = {
  "package.json": JSON.stringify({ name: "rin", private: true }),
  "server/src/_worker.ts": [
    "export default {",
    '  fetch: () => new Response("rin"),',
    "  scheduled: () => {},",
    "  queue: () => {},",
    "};",
    "",
  ].join("\n"),
  "server/sql/0001_init.sql": "CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY);\n",
  "dist/client/index.html": "<h1>Rin</h1>",
};

function rinManifest(extra: Record<string, unknown> = {}): CatalogManifest {
  return catalog("rin", {
    install: {
      wranglerConfig: PATCHED_WRANGLER_CONFIG,
      wranglerConfigInline: RIN_CONFIG,
      healthPath: "/api/auth/status",
      ...extra,
    },
    requires: ["r2", "workers-ai"],
    resources: { d1: { DB: { migrationsDir: "server/sql" } } },
  });
}

describe("Rin: the catalog carries the config the repository does not", () => {
  it("packs from the inline config, named after the install's Worker", async () => {
    const dir = project(RIN_FILES);
    const { result, logs } = await packWith(dir, rinManifest());
    const worker = result.manifest.worker;
    expect(worker.name).toBe("rin");
    expect(worker.wranglerConfig).toEqual({
      declared: PATCHED_WRANGLER_CONFIG,
      effective: PATCHED_WRANGLER_CONFIG,
    });
    expect(worker.compatibilityDate).toBe("2026-01-20");
    expect(worker.crons).toEqual(["*/20 * * * *"]);
    expect(worker.placement).toEqual({ mode: "smart" });
    expect(worker.bindings.map((b) => `${b.type}:${b.name}`).sort()).toEqual([
      "ai:AI",
      "d1:DB",
      "plain_text:NAME",
      "plain_text:PAGE_SIZE",
      "plain_text:S3_FOLDER",
      "queue:JOB_QUEUE",
      "r2_bucket:R2_BUCKET",
    ]);
    expect(worker.queueConsumers).toEqual([
      { queue: { binding: "JOB_QUEUE" }, max_batch_size: 1, max_batch_timeout: 5 },
    ]);
    expect(result.manifest.assets.binding).toBe("ASSETS");
    expect(result.manifest.assets.files.map((f) => f.route)).toEqual(["/index.html"]);
    expect(Object.keys(result.manifest.d1Migrations)).toEqual(["DB"]);
    expect(logs).toContain(`install.wranglerConfigInline written to ${PATCHED_WRANGLER_CONFIG}`);

    const written = parseJsonc(
      readFileSync(path.join(dir, PATCHED_WRANGLER_CONFIG), "utf8"),
    ) as Record<string, unknown>;
    expect(written).toEqual({ name: "rin", ...RIN_CONFIG });
  }, 120_000);

  it("is read by inspect as the pack reads it", () => {
    const dir = project(RIN_FILES);
    const facts = inspectWranglerConfig(dir, PATCHED_WRANGLER_CONFIG, { catalog: rinManifest() });
    expect(facts).toEqual({
      name: "rin",
      vars: ["S3_FOLDER", "NAME", "PAGE_SIZE"],
      unsupported: [],
      secrets: [],
    });
  });

  it("writes into the directory wranglerConfig names", async () => {
    const files = Object.fromEntries(
      Object.entries(RIN_FILES).map(([name, text]) => [`apps/rin/${name}`, text]),
    );
    const dir = project(files);
    const manifest = catalog("rin", {
      install: {
        wranglerConfig: `apps/rin/${PATCHED_WRANGLER_CONFIG}`,
        wranglerConfigInline: { ...RIN_CONFIG, d1_databases: undefined },
      },
      requires: ["r2", "workers-ai"],
    });
    const { result } = await packWith(dir, manifest);
    expect(result.manifest.worker.wranglerConfig?.effective).toBe(
      `apps/rin/${PATCHED_WRANGLER_CONFIG}`,
    );
    expect(existsSync(path.join(dir, "apps/rin", PATCHED_WRANGLER_CONFIG))).toBe(true);
  }, 120_000);
});

describe("a static site whose repository ships no config", () => {
  it("packs an assets-only Worker from the inline config", async () => {
    const dir = project({ "dist/index.html": "<h1>QR</h1>", "dist/app.js": "1;\n" });
    const manifest = catalog("qr", {
      install: {
        wranglerConfig: PATCHED_WRANGLER_CONFIG,
        wranglerConfigInline: {
          compatibility_date: "2025-05-01",
          assets: { directory: "dist", not_found_handling: "single-page-application" },
        },
        installDirs: [],
      },
    });
    const { result } = await packWith(dir, manifest);
    expect(result.manifest.worker.name).toBe("qr");
    expect(result.manifest.assets.files.map((f) => f.route).sort()).toEqual([
      "/app.js",
      "/index.html",
    ]);
  }, 120_000);
});

describe("writeInlineConfigs refusals", () => {
  const specs = (wranglerConfig = PATCHED_WRANGLER_CONFIG) =>
    workerSpecs({
      wranglerConfig,
      wranglerConfigInline: rinManifest().install.wranglerConfigInline,
    });

  it("refuses a repository that has a config of its own, a template included", () => {
    for (const own of ["wrangler.toml", "wrangler.jsonc", "wrangler.toml.example"]) {
      const dir = project({ ...RIN_FILES, [own]: 'name = "rin"\n' });
      expect(() =>
        writeInlineConfigs({ checkoutDir: dir, specs: specs(), workerName: "rin" }),
      ).toThrow(
        new ConfigPatchError(
          `install.wranglerConfigInline cannot be written: the repository has a wrangler config of its own in . (${own}); set install.wranglerConfig to it and change it with a config patch instead`,
        ),
      );
    }
  });

  it("refuses a build redirect beside it", () => {
    const dir = project({
      ...RIN_FILES,
      [DEPLOY_CONFIG_PATH]: JSON.stringify({ configPath: "../../dist/wrangler.json" }),
      "dist/wrangler.json": JSON.stringify({ name: "rin" }),
    });
    expect(() =>
      writeInlineConfigs({ checkoutDir: dir, specs: specs(), workerName: "rin" }),
    ).toThrow(
      /cannot be written: \.wrangler\/deploy\/config\.json redirects wrangler to a config the build generated/,
    );
  });

  it("refuses a directory the checkout does not have", () => {
    const dir = project(RIN_FILES);
    expect(() =>
      writeInlineConfigs({
        checkoutDir: dir,
        specs: specs(`missing/${PATCHED_WRANGLER_CONFIG}`),
        workerName: "rin",
      }),
    ).toThrow(/the directory missing does not exist in the checkout/);
  });

  it("refuses the pack when the build leaves a redirect", async () => {
    const dir = project({
      ...RIN_FILES,
      "build.mjs": [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'mkdirSync(".wrangler/deploy", { recursive: true });',
        'writeFileSync(".wrangler/deploy/config.json", JSON.stringify({ configPath: "../../dist/wrangler.json" }));',
        'writeFileSync("dist/wrangler.json", JSON.stringify({ name: "rin" }));',
        "",
      ].join("\n"),
    });
    await expect(packWith(dir, rinManifest({ buildCommand: "node build.mjs" }))).rejects.toThrow(
      /redirects wrangler to a config the build generated/,
    );
  }, 120_000);
});

describe("dropping a section the packer does not read", () => {
  // matrix-workers binds a Workers VPC service for LiveKit calls, which the
  // app works without; Nautica carries an unsafe block it does not use.
  const config = {
    name: "matrix",
    main: "src/index.js",
    compatibility_date: "2025-01-01",
    kv_namespaces: [{ binding: "SESSIONS" }],
    vpc_services: [{ binding: "LIVEKIT", service_id: "0199d0b4-0000-7000-8000-000000000000" }],
    unsafe: { bindings: [{ name: "PROBE", type: "internal_probe" }] },
  };
  const files = {
    "wrangler.jsonc": JSON.stringify(config, null, 2),
    "src/index.js": 'export default { fetch: () => new Response("ok") };\n',
  };

  it("refuses the pack while the config declares them", async () => {
    await expect(
      packWith(
        project(files),
        catalog("matrix", { install: { wranglerConfig: "wrangler.jsonc" } }),
      ),
    ).rejects.toThrow(
      /declares vpc_services \(Workers VPC services\), which Appflare cannot install/,
    );
  }, 120_000);

  it("refuses unsafe while vpc_services alone is dropped", async () => {
    const manifest = catalog("matrix", {
      install: { wranglerConfig: "wrangler.jsonc", configPatch: { vpc_services: null } },
    });
    await expect(packWith(project(files), manifest)).rejects.toThrow(
      /unsafe binding PROBE has the type "internal_probe"/,
    );
  }, 120_000);

  it("packs once the patch drops both", async () => {
    const manifest = catalog("matrix", {
      install: {
        wranglerConfig: "wrangler.jsonc",
        configPatch: { vpc_services: null, unsafe: null },
      },
    });
    const { result, logs } = await packWith(project(files), manifest);
    expect(result.manifest.worker.bindings).toEqual([{ type: "kv_namespace", name: "SESSIONS" }]);
    expect(logs).toContain("  unsafe: removed");
    expect(logs).toContain("  vpc_services: removed");
  }, 120_000);
});
