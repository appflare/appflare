import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ArtifactManifest,
  appWorkers,
  appWorkersInDeployOrder,
  artifactD1Files,
} from "@appflare/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PackResult, pack } from "./pack.ts";
import { verify } from "./verify.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.resolve(HERE, "..", "fixtures", "duo");

function readRange(filePath: string, offset: number, size: number): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(size);
    if (size > 0) readSync(fd, buf, 0, size, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** A copy of the duo fixture with `edit` applied to one of its files. */
function editedFixture(file: string, edit: (text: string) => string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "appflare-pack-duo-"));
  cpSync(FIXTURE, dir, { recursive: true });
  const target = path.join(dir, file);
  writeFileSync(target, edit(readFileSync(target, "utf8")));
  return dir;
}

describe("pack an app of several Workers", () => {
  let outDir: string;
  let result: PackResult;
  let manifest: ArtifactManifest;

  beforeAll(async () => {
    outDir = mkdtempSync(path.join(tmpdir(), "appflare-pack-duo-out-"));
    result = await pack({
      checkoutDir: FIXTURE,
      manifestPath: path.join(FIXTURE, "appflare.jsonc"),
      outDir,
      install: false,
    });
    manifest = result.manifest;
  }, 120_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("writes a manifest with the primary Worker first", () => {
    expect(manifest.format).toBe(1);
    expect(manifest.worker.name).toBe("duo-web");
    expect(manifest.workers?.map((w) => w.name)).toEqual(["jobs"]);
    expect(result.workers.map((w) => [w.name, w.primary, w.moduleCount])).toEqual([
      ["web", true, 1],
      ["jobs", false, 1],
    ]);
  });

  it("points bindings between the Workers at placeholders and keeps a self binding", () => {
    const [web, jobs] = appWorkers(manifest);
    expect(web?.worker.bindings).toContainEqual({
      type: "service",
      name: "JOBS",
      service: "{{workerName:jobs}}",
      entrypoint: "Jobs",
    });
    expect(web?.worker.bindings).toContainEqual({ type: "service", name: "SELF", service: "self" });
    expect(web?.worker.bindings).toContainEqual({
      type: "durable_object_namespace",
      name: "COUNTER",
      class_name: "Counter",
      script_name: "{{workerName:jobs}}",
    });
    expect(jobs?.worker.bindings).toContainEqual({
      type: "durable_object_namespace",
      name: "COUNTER",
      class_name: "Counter",
    });
    expect(jobs?.worker.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["Counter"] }]);
    expect(jobs?.worker.crons).toEqual(["*/30 * * * *"]);
  });

  it("knows a queue one Worker sends to and the other consumes by its producer binding", () => {
    const jobs = appWorkers(manifest)[1];
    expect(jobs?.worker.queueConsumers).toEqual([{ queue: { binding: "TASKS" }, max_retries: 3 }]);
  });

  it("records the shared D1 migrations once and each Worker's files apart", () => {
    expect(Object.keys(manifest.d1)).toEqual(["DB"]);
    expect(manifest.d1.DB?.migrations.map((f) => f.name)).toEqual(["0001_init.sql"]);
    const jobs = appWorkers(manifest)[1];
    expect(jobs?.worker.modules[0]?.path).toBe("workers/jobs/worker/index.js");
    expect(manifest.worker.modules[0]?.path).toBe("worker/index.js");
    expect(manifest.assets.files.map((f) => f.path)).toEqual(["assets/index.html"]);
    expect(jobs?.assets.files).toEqual([]);
    expect(JSON.stringify(manifest)).not.toContain("11111111-2222-3333-4444-555555555555");
  });

  it("records ranges that read back every Worker's files", () => {
    const entries = [
      ...appWorkers(manifest).flatMap((w) => [...w.worker.modules, ...w.assets.files]),
      ...artifactD1Files(manifest),
    ];
    for (const entry of entries) {
      const bytes = readRange(result.zipPath, entry.offset, entry.size);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
    }
  });

  it("verifies every Worker's files", async () => {
    const res = await verify({ dir: outDir, hashesOnly: true, checkUpload: true });
    expect(res.checkedFiles).toBe(4); // 2 modules + 1 asset + 1 migration
  });

  it("fails verify when another Worker's module is tampered with", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "appflare-pack-duo-tamper-"));
    try {
      const copy = JSON.parse(readFileSync(result.manifestJsonPath, "utf8")) as ArtifactManifest;
      const jobs = copy.workers?.[0];
      const module = jobs?.worker.modules[0];
      if (module === undefined) throw new Error("no jobs module");
      module.sha256 = "0".repeat(64);
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(copy));
      writeFileSync(path.join(dir, path.basename(result.zipPath)), readFileSync(result.zipPath));
      await expect(verify({ dir, hashesOnly: true })).rejects.toThrow(/sha256 mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pack refuses what an app of several Workers cannot install", () => {
  async function packFails(dir: string, message: RegExp): Promise<void> {
    const out = path.join(dir, "out");
    await expect(
      pack({
        checkoutDir: dir,
        manifestPath: path.join(dir, "appflare.jsonc"),
        outDir: out,
        install: false,
      }),
    ).rejects.toThrow(message);
    expect(existsSync(out)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }

  it("a service binding to a Worker outside the entry", async () => {
    const dir = editedFixture("web/wrangler.jsonc", (t) =>
      t.replace('"service": "duo-jobs"', '"service": "appflare"'),
    );
    await packFails(dir, /other Workers of its catalog entry/);
  }, 120_000);

  it("Workers that bind each other in a cycle", async () => {
    const dir = editedFixture("jobs/wrangler.jsonc", (t) =>
      t.replace(
        '"triggers"',
        '"services": [{ "binding": "WEB", "service": "duo-web" }],\n  "triggers"',
      ),
    );
    await packFails(dir, /name each other in a cycle/);
  }, 120_000);

  it("one D1 binding with different migrations", async () => {
    const dir = editedFixture("jobs/wrangler.jsonc", (t) =>
      t.replace('"migrations_dir": "../migrations"', '"migrations_dir": "migrations"'),
    );
    const extra = path.join(dir, "jobs", "migrations");
    cpSync(path.join(dir, "migrations"), extra, { recursive: true });
    writeFileSync(path.join(extra, "0002_more.sql"), "SELECT 1;\n");
    await packFails(dir, /bind the D1 database DB with different migrations/);
  }, 120_000);

  it("a Workflow bound from another Worker of the entry that does not define it", async () => {
    const dir = editedFixture("web/wrangler.jsonc", (t) =>
      t.replace(
        '"durable_objects"',
        '"workflows": [{ "binding": "FLOW", "name": "flow", "class_name": "Flow", "script_name": "duo-jobs" }],\n  "durable_objects"',
      ),
    );
    await packFails(
      dir,
      /runs the Workflow "flow" of the Worker "jobs", which defines no Workflow/,
    );
  }, 120_000);
});

describe("pack an app of several Workers with a Workflow one runs and the other defines", () => {
  it("names the defining Worker in the other's binding and deploys it first", async () => {
    const dir = editedFixture("web/wrangler.jsonc", (t) =>
      t.replace(
        '"durable_objects"',
        '"workflows": [{ "binding": "AUDIT", "name": "site-audit", "class_name": "SiteAudit", "script_name": "duo-jobs" }],\n  "durable_objects"',
      ),
    );
    const jobs = path.join(dir, "jobs", "wrangler.jsonc");
    // The defining Worker may name itself, as wrangler allows.
    writeFileSync(
      jobs,
      readFileSync(jobs, "utf8").replace(
        '"triggers"',
        '"workflows": [{ "binding": "SITE_AUDIT", "name": "site-audit", "class_name": "SiteAudit", "script_name": "duo-jobs" }],\n  "triggers"',
      ),
    );
    try {
      const res = await pack({
        checkoutDir: dir,
        manifestPath: path.join(dir, "appflare.jsonc"),
        outDir: path.join(dir, "out"),
        install: false,
      });
      const byName = new Map(appWorkers(res.manifest).map((w) => [w.name, w.worker.bindings]));
      expect(byName.get("web")).toContainEqual({
        type: "workflow",
        name: "AUDIT",
        workflow_name: "site-audit",
        class_name: "SiteAudit",
        script_name: "{{workerName:jobs}}",
      });
      expect(byName.get("jobs")).toContainEqual({
        type: "workflow",
        name: "SITE_AUDIT",
        workflow_name: "site-audit",
        class_name: "SiteAudit",
      });
      expect(appWorkersInDeployOrder(res.manifest).map((w) => w.name)).toEqual(["jobs", "web"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("pack an app of several Workers with a secret one Worker gets", () => {
  it("leaves out that Worker's var of the secret's name, and keeps the other Worker's", async () => {
    const dir = editedFixture("web/wrangler.jsonc", (t) =>
      t.replace('"vars": {', '"vars": { "SESSION_SECRET": "dev-only",'),
    );
    const jobs = path.join(dir, "jobs", "wrangler.jsonc");
    writeFileSync(
      jobs,
      readFileSync(jobs, "utf8").replace(
        '"triggers"',
        '"vars": { "SESSION_SECRET": "a public label" },\n  "triggers"',
      ),
    );
    const logs: string[] = [];
    try {
      const res = await pack({
        checkoutDir: dir,
        manifestPath: path.join(dir, "appflare.jsonc"),
        outDir: path.join(dir, "out"),
        install: false,
        logger: (m) => logs.push(m),
      });
      const byName = new Map(appWorkers(res.manifest).map((w) => [w.name, w.worker.bindings]));
      // SESSION_SECRET is a secret of web only.
      expect(byName.get("web")?.some((b) => b.name === "SESSION_SECRET")).toBe(false);
      expect(byName.get("jobs")).toContainEqual({
        type: "plain_text",
        name: "SESSION_SECRET",
        text: "a public label",
      });
      expect(logs.filter((l) => l.startsWith("var SESSION_SECRET"))).toEqual([
        'var SESSION_SECRET is provided as a secret: the catalog manifest declares SESSION_SECRET as a secret, so the wrangler config\'s var of that name of the Worker "web" is left out',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A checkout shaped like OpenSEO: two wrangler configs in one directory,
 * built by the Cloudflare Vite plugin (an older one, which writes
 * `legacy_env`) into `dist/<name>/wrangler.json` with one redirect that
 * points at the entry Worker's config and lists the other under
 * `auxiliaryWorkers`. The app Worker runs a Workflow the audit Worker
 * defines.
 */
function viteTwoWorkerCheckout(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "appflare-pack-vite-duo-"));
  const files: Record<string, string> = {
    "src/app.ts":
      'import { WorkflowEntrypoint } from "cloudflare:workers";\nexport class Rank extends WorkflowEntrypoint { async run() {} }\nexport default { fetch: () => new Response("app") };\n',
    "src/audit.ts":
      'import { WorkflowEntrypoint } from "cloudflare:workers";\nexport class SiteAudit extends WorkflowEntrypoint { async run() {} }\nexport class AuditEngine {}\nexport default { fetch: () => new Response("audit") };\n',
    "drizzle/0001_init.sql": "CREATE TABLE t (id INTEGER);\n",
    "wrangler.jsonc": JSON.stringify({
      name: "seo",
      main: "src/app.ts",
      compatibility_date: "2025-09-02",
      workflows: [
        {
          name: "site-audit",
          binding: "SITE_AUDIT",
          class_name: "SiteAudit",
          script_name: "seo-audit",
        },
        { name: "rank", binding: "RANK", class_name: "Rank" },
      ],
      services: [{ binding: "AUDIT_ENGINE", service: "seo-audit" }],
      d1_databases: [
        { binding: "DB", database_name: "seo", database_id: "x", migrations_dir: "drizzle" },
      ],
    }),
    "wrangler.audit.jsonc": JSON.stringify({
      name: "seo-audit",
      main: "src/audit.ts",
      compatibility_date: "2025-09-02",
      workers_dev: false,
      workflows: [{ name: "site-audit", binding: "SITE_AUDIT", class_name: "SiteAudit" }],
      d1_databases: [
        { binding: "DB", database_name: "seo", database_id: "x", migrations_dir: "drizzle" },
      ],
    }),
    // What `vite build` leaves: each config with its main resolved from
    // dist/<name>/, the config it came from, and legacy_env.
    "build.mjs": `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const generate = (from, out, main) => {
  const config = JSON.parse(readFileSync(from, "utf8"));
  const abs = path.resolve(from);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ configPath: abs, userConfigPath: abs, topLevelName: config.name, legacy_env: true, ...config, main, ratelimits: [] }));
};
generate("wrangler.jsonc", "dist/server/wrangler.json", "../../src/app.ts");
generate("wrangler.audit.jsonc", "dist/seo_audit/wrangler.json", "../../src/audit.ts");
mkdirSync(".wrangler/deploy", { recursive: true });
writeFileSync(".wrangler/deploy/config.json", JSON.stringify({ configPath: "../../dist/server/wrangler.json", auxiliaryWorkers: [{ configPath: "../../dist/seo_audit/wrangler.json" }] }));
`,
    "appflare.jsonc": JSON.stringify({
      slug: "seo",
      name: "SEO",
      summary: "Two Workers built by Vite, one running the other's Workflow.",
      tagline: "An app Worker and an audit Worker",
      repo: "appflare/appflare",
      license: "Apache-2.0",
      categories: ["utilities"],
      maintainers: ["appflare"],
      source: { ref: "v0.1.10", sha: "0123456789abcdef0123456789abcdef01234567" },
      install: {
        packageManager: "pnpm",
        wranglerConfig: "wrangler.jsonc",
        buildCommand: "node build.mjs",
        workers: [
          {
            name: "app",
            wranglerConfig: "wrangler.jsonc",
            primary: true,
            configPatch: {
              ratelimits: [
                {
                  name: "MCP_RATE_LIMIT",
                  namespace_id: "1001",
                  simple: { limit: 5000, period: 60 },
                },
              ],
            },
          },
          { name: "audit", wranglerConfig: "wrangler.audit.jsonc", workersDev: false },
        ],
      },
      plan: "free",
      postInstall: [],
    }),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

describe("pack an app of several Workers built by the Vite plugin", () => {
  it("packs each Worker from the config the build generated from its own", async () => {
    const dir = viteTwoWorkerCheckout();
    const logs: string[] = [];
    try {
      const res = await pack({
        checkoutDir: dir,
        manifestPath: path.join(dir, "appflare.jsonc"),
        outDir: path.join(dir, "out"),
        install: false,
        logger: (m) => logs.push(m),
      });
      const [app, audit] = appWorkers(res.manifest);
      // The patch applies to the generated config; the audit Worker's
      // generated config is read without legacy_env.
      expect(app?.worker.wranglerConfig).toEqual({
        declared: "wrangler.jsonc",
        effective: "dist/server/.appflare.wrangler.jsonc",
      });
      expect(audit?.worker.wranglerConfig).toEqual({
        declared: "wrangler.audit.jsonc",
        effective: "dist/seo_audit/.appflare.wrangler.jsonc",
      });
      expect(
        logs.some((l) =>
          l.includes(
            "the build generated dist/seo_audit/wrangler.json from wrangler.audit.jsonc for an auxiliary Worker",
          ),
        ),
      ).toBe(true);
      expect(audit?.worker.name).toBe("seo-audit");
      expect(app?.worker.bindings).toContainEqual({
        type: "workflow",
        name: "SITE_AUDIT",
        workflow_name: "site-audit",
        class_name: "SiteAudit",
        script_name: "{{workerName:audit}}",
      });
      expect(app?.worker.bindings).toContainEqual({
        type: "service",
        name: "AUDIT_ENGINE",
        service: "{{workerName:audit}}",
      });
      expect(app?.worker.bindings).toContainEqual({
        type: "ratelimit",
        name: "MCP_RATE_LIMIT",
        namespace_id: "1001",
        simple: { limit: 5000, period: 60 },
      });
      expect(audit?.worker.bindings).toContainEqual({
        type: "workflow",
        name: "SITE_AUDIT",
        workflow_name: "site-audit",
        class_name: "SiteAudit",
      });
      // migrations_dir reads against each Worker's own config.
      expect(res.manifest.d1.DB?.migrations.map((f) => f.name)).toEqual(["0001_init.sql"]);
      expect(appWorkersInDeployOrder(res.manifest).map((w) => w.name)).toEqual(["audit", "app"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
