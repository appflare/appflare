import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ArtifactManifest, appWorkers } from "@appflare/schema";
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

  it("writes a format 2 manifest with the primary Worker first", () => {
    expect(manifest.format).toBe(2);
    expect(manifest.worker.name).toBe("duo-web");
    expect(manifest.format === 2 && manifest.workers.map((w) => w.name)).toEqual(["jobs"]);
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
    expect(Object.keys(manifest.d1Migrations)).toEqual(["DB"]);
    expect(manifest.d1Migrations.DB?.map((f) => f.name)).toEqual(["0001_init.sql"]);
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
      ...Object.values(manifest.d1Migrations).flat(),
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
      const jobs = copy.format === 2 ? copy.workers[0] : undefined;
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
  });

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

  it("a Workflow bound from another Worker of the entry", async () => {
    const dir = editedFixture("web/wrangler.jsonc", (t) =>
      t.replace(
        '"durable_objects"',
        '"workflows": [{ "binding": "FLOW", "name": "flow", "class_name": "Flow", "script_name": "duo-jobs" }],\n  "durable_objects"',
      ),
    );
    await packFails(dir, /Appflare installs each Workflow with the Worker that defines it/);
  });
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
