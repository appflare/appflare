import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyMergePatch,
  type CatalogManifest,
  catalogManifestSchema,
  INSPECT_OUTPUT_PREFIX,
  PATCHED_WRANGLER_CONFIG,
  parseInspectOutput,
} from "@appflare/schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import { main } from "./cli-main.ts";
import {
  applyConfigPatches,
  ConfigPatchError,
  readRawWranglerConfig,
  workerSpecs,
} from "./config-patch.ts";
import { inspectWranglerConfig } from "./inspect.ts";
import { parseJsonc } from "./jsonc.ts";
import { pack } from "./pack.ts";

// Each fixture below has the shape of a real catalog app whose wrangler
// config needs a patch to install from its pinned commit. The configs are
// read by real wrangler, and the packs run real dry runs.

const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function project(files: Record<string, string>): string {
  const dir = tempDir("appflare-config-patch-");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const WORKER = 'export default { fetch: () => new Response("ok") };\n';

function catalog(slug: string, install: Record<string, unknown>): CatalogManifest {
  return catalogManifestSchema.parse({
    slug,
    name: slug,
    summary: "A config patch fixture.",
    tagline: "A config patch fixture",
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
  });
}

/** Packs `dir` with `manifest`, collecting the log. */
async function packWith(dir: string, manifest: CatalogManifest) {
  const manifestPath = path.join(tempDir("appflare-config-patch-manifest-"), "appflare.jsonc");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const outDir = path.join(tempDir("appflare-config-patch-out-"), "out");
  const logs: string[] = [];
  const result = await pack({
    checkoutDir: dir,
    manifestPath,
    outDir,
    install: false,
    logger: (m) => logs.push(m),
  });
  return { result, logs, outDir };
}

function readPatched(dir: string, configDir = "."): Record<string, unknown> {
  return parseJsonc(
    readFileSync(path.join(dir, configDir, PATCHED_WRANGLER_CONFIG), "utf8"),
  ) as Record<string, unknown>;
}

describe("md.page: storage bindings with empty ids, in a subdirectory", () => {
  const config = {
    name: "mdpage",
    main: "src/index.js",
    compatibility_date: "2025-01-01",
    assets: { directory: "./public", binding: "ASSETS" },
    kv_namespaces: [{ binding: "PAGES", id: "" }],
    r2_buckets: [{ binding: "FILES", bucket_name: "" }],
    d1_databases: [
      { binding: "DB", database_name: "mdpage", database_id: "", migrations_dir: "db" },
    ],
  };
  const files = {
    "apps/web/wrangler.jsonc": `// upstream's template\n${JSON.stringify(config, null, 2)}`,
    "apps/web/src/index.js": WORKER,
    "apps/web/public/index.html": "<h1>md.page</h1>",
    "apps/web/db/0001_init.sql": "CREATE TABLE IF NOT EXISTS pages (id TEXT);",
  };
  const install = { wranglerConfig: "apps/web/wrangler.jsonc" };
  const configPatch = {
    kv_namespaces: [{ binding: "PAGES" }],
    r2_buckets: [{ binding: "FILES" }],
    d1_databases: [{ binding: "DB", database_name: "mdpage", migrations_dir: "db" }],
  };

  it("is refused by wrangler without the patch", async () => {
    await expect(packWith(project(files), catalog("mdpage", install))).rejects.toThrow(
      /should have a string "id" field/,
    );
  }, 120_000);

  it("packs with the ids cleared, resolving every relative path from the config's directory", async () => {
    const dir = project(files);
    const { result, logs } = await packWith(dir, catalog("mdpage", { ...install, configPatch }));
    const worker = result.manifest.worker;
    expect(worker.bindings).toEqual(
      expect.arrayContaining([
        { type: "kv_namespace", name: "PAGES" },
        { type: "r2_bucket", name: "FILES" },
        { type: "d1", name: "DB" },
      ]),
    );
    expect(worker.wranglerConfig).toEqual({
      declared: "apps/web/wrangler.jsonc",
      effective: `apps/web/${PATCHED_WRANGLER_CONFIG}`,
    });
    // main, assets.directory and migrations_dir all resolved beside the original.
    expect(worker.mainModule).toBe("index.js");
    expect(result.manifest.assets.files.map((f) => f.route)).toEqual(["/index.html"]);
    expect(result.manifest.d1.DB?.migrations.map((f) => f.name)).toEqual(["0001_init.sql"]);
    // The signed catalog manifest carries the patch.
    expect(result.manifest.catalog.install.configPatch).toEqual(configPatch);
    expect(logs).toContain(
      `install.configPatch applied to apps/web/wrangler.jsonc, building from apps/web/${PATCHED_WRANGLER_CONFIG}:`,
    );
    expect(logs).toContain(
      '  kv_namespaces: [{"binding":"PAGES","id":""}] -> [{"binding":"PAGES"}]',
    );
    // The repository's own config is left as it was.
    expect(readFileSync(path.join(dir, "apps/web/wrangler.jsonc"), "utf8")).toBe(
      files["apps/web/wrangler.jsonc"],
    );
  }, 120_000);

  it("refuses a patch that removes a storage binding, and writes nothing", async () => {
    const dir = project(files);
    const refused = catalog("mdpage", {
      ...install,
      configPatch: { ...configPatch, kv_namespaces: [{ binding: "OTHER" }] },
    });
    const run = packWith(dir, refused);
    await expect(run).rejects.toThrow(ConfigPatchError);
    await expect(run).rejects.toThrow(
      "install.configPatch for apps/web/wrangler.jsonc: the config patch cannot be applied: kv_namespaces leaves out the binding PAGES",
    );
    expect(existsSync(path.join(dir, "apps/web", PATCHED_WRANGLER_CONFIG))).toBe(false);
  }, 120_000);
});

describe("SaaSMail: KV-backed Durable Object classes made SQLite-backed", () => {
  it("renames new_classes to new_sqlite_classes and records the renamed migrations", async () => {
    const dir = project({
      "wrangler.jsonc": JSON.stringify({
        name: "saasmail",
        main: "src/index.js",
        compatibility_date: "2025-01-01",
        durable_objects: { bindings: [{ name: "MAILBOX", class_name: "Mailbox" }] },
        migrations: [{ tag: "v1", new_classes: ["Mailbox"] }],
      }),
      "src/index.js": `export class Mailbox { constructor(state) { this.state = state; } async fetch() { return new Response("mailbox"); } }\n${WORKER}`,
    });
    const { result } = await packWith(
      dir,
      catalog("saasmail", {
        wranglerConfig: "wrangler.jsonc",
        configPatch: { migrations: [{ tag: "v1", new_sqlite_classes: ["Mailbox"] }] },
      }),
    );
    expect(result.manifest.worker.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["Mailbox"] },
    ]);
  }, 120_000);
});

describe("Deepcrawl: a service binding to a Worker outside the app", () => {
  const files = {
    "wrangler.jsonc": JSON.stringify({
      name: "deepcrawl",
      main: "src/index.js",
      compatibility_date: "2025-01-01",
      services: [{ binding: "AUTH_WORKER", service: "deepcrawl-auth" }],
      vars: { AUTH_MODE: "jwt" },
    }),
    "src/index.js": WORKER,
  };

  it("is refused by the packer without the patch", async () => {
    await expect(
      packWith(project(files), catalog("deepcrawl", { wranglerConfig: "wrangler.jsonc" })),
    ).rejects.toThrow(/service binding AUTH_WORKER points at the Worker "deepcrawl-auth"/);
  }, 120_000);

  it("drops the binding, and wrangler reads a config without it", () => {
    const dir = project(files);
    const specs = workerSpecs(
      catalog("deepcrawl", {
        wranglerConfig: "wrangler.jsonc",
        configPatch: { services: null },
      }).install,
    );
    const logs: string[] = [];
    const patched = applyConfigPatches({ checkoutDir: dir, specs, logger: (m) => logs.push(m) });
    const target = patched.get("wrangler.jsonc");
    expect(target?.effectivePath).toBe(path.join(dir, PATCHED_WRANGLER_CONFIG));
    const read = unstable_readConfig({ config: target?.effectivePath }, {});
    expect(read.services ?? []).toEqual([]);
    expect(read.vars).toEqual({ AUTH_MODE: "jwt" });
    expect(logs).toContain("  services: removed");
  });
});

describe("Discohook: a TOML config with a CDN service binding", () => {
  const TOML = `name = "discohook"
main = "src/index.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]
services = [
  { binding = "CDN", service = "discohook-cdn", entrypoint = "UploaderService" },
  { binding = "SELF", service = "discohook" },
]

[vars]
SITE_URL = "https://discohook.app"
MAX_EMBEDS = 10

[observability]
enabled = true

[[kv_namespaces]]
binding = "KV"
id = "0123456789abcdef0123456789abcdef"

[[d1_databases]]
binding = "DB"
database_name = "discohook"
database_id = "11111111-2222-3333-4444-555555555555"
migrations_dir = "drizzle"
`;

  it("round-trips the TOML through JSONC and changes only what the patch names", () => {
    const dir = project({ "wrangler.toml": TOML, "src/index.js": WORKER });
    const configPatch = { services: [{ binding: "SELF", service: "discohook" }] };
    const specs = workerSpecs(
      catalog("discohook", { wranglerConfig: "wrangler.toml", configPatch }).install,
    );
    const target = applyConfigPatches({ checkoutDir: dir, specs }).get("wrangler.toml");
    if (target === undefined) throw new Error("expected a patched config");

    const raw = readRawWranglerConfig(path.join(dir, "wrangler.toml"));
    expect(readPatched(dir)).toEqual(applyMergePatch(raw, configPatch));
    expect(readRawWranglerConfig(target.effectivePath)).toEqual(applyMergePatch(raw, configPatch));

    // Wrangler resolves both files alike, except for the binding the patch dropped.
    const original = unstable_readConfig({ config: path.join(dir, "wrangler.toml") }, {});
    const patched = unstable_readConfig({ config: target.effectivePath }, {});
    for (const key of [
      "name",
      "main",
      "compatibility_date",
      "compatibility_flags",
      "vars",
      "observability",
      "kv_namespaces",
      "d1_databases",
    ] as const) {
      expect(patched[key]).toEqual(original[key]);
    }
    expect(patched.services).toEqual([{ binding: "SELF", service: "discohook" }]);
    expect(patched.main).toBe(path.join(dir, "src/index.js"));
  });
});

describe("Nodrix: the config's build replaced by the catalog's build commands", () => {
  const files = {
    // Wrangler would run this build and fail the dry run.
    "wrangler.jsonc": JSON.stringify({
      name: "nodrix",
      main: "dist/index.js",
      compatibility_date: "2025-01-01",
      build: { command: "exit 7" },
    }),
    "src/index.js": WORKER,
  };
  const install = {
    wranglerConfig: "wrangler.jsonc",
    buildCommand: ["mkdir dist", "cp src/index.js dist/index.js"],
  };

  it("fails the dry run on the config's own build without the patch", async () => {
    await expect(packWith(project(files), catalog("nodrix", install))).rejects.toThrow(
      /wrangler deploy --dry-run failed/,
    );
  }, 120_000);

  it("packs with build removed, after the catalog's commands built the entrypoint", async () => {
    const dir = project(files);
    const { result, logs } = await packWith(
      dir,
      catalog("nodrix", { ...install, configPatch: { build: null } }),
    );
    expect(result.moduleCount).toBe(1);
    expect(logs).toContain("  build: removed");
    expect(readPatched(dir)).not.toHaveProperty("build");
  }, 120_000);
});

describe("applyConfigPatches", () => {
  it("lets a Worker of several add a service binding to another Worker of the entry only", () => {
    const dir = project({
      "web/wrangler.jsonc": JSON.stringify({
        name: "app-web",
        main: "index.js",
        compatibility_date: "2025-01-01",
      }),
      "api/wrangler.jsonc": JSON.stringify({
        name: "app-api",
        main: "index.js",
        compatibility_date: "2025-01-01",
      }),
    });
    const withService = (service: string) =>
      workerSpecs(
        catalog("app", {
          wranglerConfig: "web/wrangler.jsonc",
          workers: [
            {
              name: "web",
              wranglerConfig: "web/wrangler.jsonc",
              primary: true,
              configPatch: { services: [{ binding: "API", service }] },
            },
            { name: "api", wranglerConfig: "api/wrangler.jsonc" },
          ],
        }).install,
      );
    const patched = applyConfigPatches({ checkoutDir: dir, specs: withService("app-api") });
    expect([...patched.keys()]).toEqual(["web/wrangler.jsonc"]);
    expect(readPatched(dir, "web").services).toEqual([{ binding: "API", service: "app-api" }]);
    expect(() => applyConfigPatches({ checkoutDir: dir, specs: withService("elsewhere") })).toThrow(
      /the configPatch of the Worker "web" for web\/wrangler.jsonc: .*services adds or changes the binding API; .*\(app-web, app-api\)/,
    );
  });

  describe("a config the build generated", () => {
    /** A Vite build's output: the generated config records the config it came from. */
    const viteBuild = () => {
      const dir = project({
        "wrangler.jsonc": JSON.stringify({ name: "vite", main: "src/index.js" }),
        ".wrangler/deploy/config.json": JSON.stringify({
          configPath: "../../dist/vite/wrangler.json",
          auxiliaryWorkers: [],
        }),
      });
      mkdirSync(path.join(dir, "dist/vite"), { recursive: true });
      writeFileSync(
        path.join(dir, "dist/vite/wrangler.json"),
        JSON.stringify({
          userConfigPath: path.join(dir, "wrangler.jsonc"),
          legacy_env: true,
          name: "vite",
          main: "index.js",
          vars: { X: "1", Y: "2" },
          ratelimits: [],
        }),
      );
      return dir;
    };
    const rateLimit = {
      name: "MCP_RATE_LIMIT",
      namespace_id: "1001",
      simple: { limit: 50, period: 60 },
    } as const;

    it("is patched itself, after the build, and read without legacy_env", () => {
      const dir = viteBuild();
      const specs = workerSpecs(
        catalog("vite", {
          wranglerConfig: "wrangler.jsonc",
          configPatch: { vars: { X: null }, ratelimits: [rateLimit] },
        }).install,
      );
      const logs: string[] = [];
      const target = applyConfigPatches({
        checkoutDir: dir,
        specs,
        logger: (m) => logs.push(m),
      }).get("wrangler.jsonc");
      expect(target).toEqual({
        // Relative paths of the app's own config still read against it.
        declaredPath: path.join(dir, "wrangler.jsonc"),
        effectivePath: path.join(dir, "dist/vite", PATCHED_WRANGLER_CONFIG),
        deployConfigPath: null,
      });
      const patched = readPatched(dir, "dist/vite");
      expect(patched.vars).toEqual({ Y: "2" });
      expect(patched.ratelimits).toEqual([rateLimit]);
      expect(patched).not.toHaveProperty("legacy_env");
      expect(logs.some((l) => l.includes("without legacy_env"))).toBe(true);
      // Wrangler reads the copy as a hand-written config.
      const config = unstable_readConfig({ config: target?.effectivePath }) as {
        ratelimits: unknown[];
      };
      expect(config.ratelimits).toEqual([rateLimit]);
    });

    it("refuses a patch to a path or the build the build already resolved", () => {
      const dir = viteBuild();
      const specs = workerSpecs(
        catalog("vite", {
          wranglerConfig: "wrangler.jsonc",
          configPatch: { main: "other.js", assets: { directory: "public" } },
        }).install,
      );
      expect(() => applyConfigPatches({ checkoutDir: dir, specs })).toThrow(
        "install.configPatch cannot change main, assets.directory of dist/vite/wrangler.json: the build generated that config from wrangler.jsonc",
      );
    });
  });

  it("refuses to write the patched config through a link", () => {
    const dir = project({
      "wrangler.jsonc": JSON.stringify({ name: "linked", main: "src/index.js" }),
    });
    const outside = tempDir("appflare-config-patch-outside-");
    symlinkSync(path.join(outside, "target.jsonc"), path.join(dir, PATCHED_WRANGLER_CONFIG));
    const specs = workerSpecs(
      catalog("linked", { wranglerConfig: "wrangler.jsonc", configPatch: { build: null } }).install,
    );
    expect(() => applyConfigPatches({ checkoutDir: dir, specs })).toThrow(
      /exists and is not a regular file/,
    );
    expect(existsSync(path.join(outside, "target.jsonc"))).toBe(false);
  });

  it("patches a config kept as a template, under its real name", () => {
    const dir = project({
      "wrangler.toml.example": 'name = "tpl"\nmain = "src/index.js"\n\n[vars]\nA = "1"\nB = "2"\n',
    });
    const specs = workerSpecs(
      catalog("tpl", {
        wranglerConfig: "wrangler.toml.example",
        configPatch: { vars: { A: null } },
      }).install,
    );
    applyConfigPatches({ checkoutDir: dir, specs });
    expect(readPatched(dir).vars).toEqual({ B: "2" });
  });
});

describe("appflare-pack inspect with a catalog manifest", () => {
  const files = {
    "wrangler.jsonc": JSON.stringify({
      name: "inspected",
      main: "src/index.js",
      compatibility_date: "2025-01-01",
      vars: { KEEP: "1", DROP: "2" },
    }),
  };
  const manifest = catalog("inspected", {
    wranglerConfig: "wrangler.jsonc",
    configPatch: { vars: { DROP: null } },
  });

  it("reads the patched config", () => {
    const dir = project(files);
    expect(inspectWranglerConfig(dir, "wrangler.jsonc").vars).toEqual(["KEEP", "DROP"]);
    const logs: string[] = [];
    expect(
      inspectWranglerConfig(dir, "wrangler.jsonc", {
        catalog: manifest,
        logger: (m) => logs.push(m),
      }).vars,
    ).toEqual(["KEEP"]);
    expect(logs).toContain("  vars.DROP: removed");
    expect(() => inspectWranglerConfig(dir, "other.jsonc", { catalog: manifest })).toThrow(
      /builds no Worker from other.jsonc/,
    );
  });

  it("takes the manifest on the command line", async () => {
    const dir = project(files);
    const manifestPath = path.join(dir, "appflare.jsonc");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const err: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    expect(
      await main(["inspect", dir, "--config", "wrangler.jsonc", "--manifest", manifestPath]),
    ).toBe(0);
    const printed = out.join("");
    expect(printed.startsWith(INSPECT_OUTPUT_PREFIX)).toBe(true);
    expect(parseInspectOutput(printed)).toMatchObject({ name: "inspected", vars: ["KEEP"] });
    expect(err.join("")).toContain("vars.DROP: removed");
  });
});
