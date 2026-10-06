import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "./jsonc.ts";
import { pack } from "./pack.ts";
import { verify } from "./verify.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURE = path.resolve(HERE, "..", "fixtures", "hello");

/**
 * A copy of the fixture whose wrangler config declares a Durable Object and an
 * entrypoint in `exports`, a `cache` block and a Worker Loader, with the
 * catalog manifest's `plan` set to `plan`.
 */
function settingsCheckout(
  parent: string,
  plan: "free" | "paid",
): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  appendFileSync(
    path.join(dir, "src", "index.ts"),
    "\nexport class Room {}\nexport class Api {}\n",
  );
  const config = parseJsonc(readFileSync(path.join(dir, "wrangler.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      ...config,
      exports: {
        Room: { type: "durable-object", storage: "sqlite" },
        Api: { type: "worker", cache: { enabled: true } },
      },
      cache: { enabled: true, cross_version_cache: false },
      worker_loaders: [{ binding: "LOADER" }],
    }),
  );
  const catalog = parseJsonc(readFileSync(path.join(dir, "appflare.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  const manifest = path.join(parent, "appflare.jsonc");
  writeFileSync(manifest, JSON.stringify({ ...catalog, plan }));
  return { dir, manifest };
}

describe("pack with exports, cache and a Worker Loader", () => {
  it("records exports, the cache block and the worker_loader binding", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-settings-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = settingsCheckout(parent, "paid");
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
      });
      expect(res.manifest.worker.exports).toEqual({
        Room: { type: "durable-object", storage: "sqlite" },
        Api: { type: "worker", cache: { enabled: true } },
      });
      expect(res.manifest.worker.cacheOptions).toEqual({
        enabled: true,
        cross_version_cache: false,
      });
      expect(res.manifest.worker.bindings).toContainEqual({
        type: "worker_loader",
        name: "LOADER",
      });
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses a Worker Loader unless the catalog manifest says plan paid, before building", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-loader-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = settingsCheckout(parent, "free");
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
          logger: (m) => logs.push(m),
        }),
      ).rejects.toThrow(/Worker Loader \(LOADER\).*only on Workers Paid.*"plan": "paid"/);
      expect(existsSync(outDir)).toBe(false);
      expect(logs.some((l) => l.includes("dry-run"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * A copy of the fixture whose Worker defines the Workflow `jobs` with every
 * setting wrangler takes on a `workflows` entry (`schedules` only when
 * `scheduled`), with the catalog manifest's `plan` set to `plan`.
 */
function workflowCheckout(
  parent: string,
  plan: "free" | "paid",
  scheduled: boolean,
  /** Fields to set over the entry's. */
  over: Record<string, unknown> = {},
): { dir: string; manifest: string } {
  const dir = path.join(parent, "checkout");
  cpSync(FIXTURE, dir, { recursive: true });
  appendFileSync(path.join(dir, "src", "index.ts"), "\nexport class Jobs {}\n");
  const config = parseJsonc(readFileSync(path.join(dir, "wrangler.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  writeFileSync(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      ...config,
      workflows: [
        {
          binding: "JOBS",
          name: "hello-jobs",
          class_name: "Jobs",
          limits: { steps: 500 },
          concurrency: { limit: 3 },
          ...(scheduled ? { schedules: "0 3 * * *" } : {}),
          default_retention: { success_retention: "1 day", error_retention: 3_600_000 },
          ...over,
        },
      ],
    }),
  );
  const catalog = parseJsonc(readFileSync(path.join(dir, "appflare.jsonc"), "utf8")) as Record<
    string,
    unknown
  >;
  const manifest = path.join(parent, "appflare.jsonc");
  writeFileSync(manifest, JSON.stringify({ ...catalog, plan }));
  return { dir, manifest };
}

describe("pack with Workflow settings", () => {
  it("records them beside the Workflow binding, which stays as wrangler uploads it", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-workflow-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = workflowCheckout(parent, "paid", true);
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
      });
      expect(res.manifest.worker.workflowSettings).toEqual({
        JOBS: {
          limits: { steps: 500 },
          concurrency: { limit: 3 },
          schedules: ["0 3 * * *"],
          default_retention: { success_retention: "1 day", error_retention: 3_600_000 },
        },
      });
      expect(res.manifest.worker.bindings).toContainEqual({
        type: "workflow",
        name: "JOBS",
        workflow_name: "hello-jobs",
        class_name: "Jobs",
      });
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("takes settings without a schedule on the free plan", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-workflow-free-"));
    const outDir = path.join(parent, "out");
    try {
      const checkout = workflowCheckout(parent, "free", false);
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
      });
      expect(res.manifest.worker.workflowSettings?.JOBS).toEqual({
        limits: { steps: 500 },
        concurrency: { limit: 3 },
        default_retention: { success_retention: "1 day", error_retention: 3_600_000 },
      });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("leaves out, saying so, a field of a setting wrangler does not know", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-workflow-unknown-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = workflowCheckout(parent, "free", false, {
        limits: { steps: 500, cpu_ms: 100 },
      });
      const res = await pack({
        checkoutDir: checkout.dir,
        manifestPath: checkout.manifest,
        outDir,
        install: false,
        logger: (m) => logs.push(m),
      });
      expect(res.manifest.worker.workflowSettings?.JOBS?.limits).toEqual({ steps: 500 });
      expect(logs).toContain(
        "the Workflow binding JOBS sets limits.cpu_ms, which wrangler does not know as a Workflow setting; left out",
      );
      await expect(verify({ dir: outDir })).resolves.toMatchObject({ ok: true });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses a Workflow on a schedule unless the catalog manifest says plan paid, before building", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "appflare-pack-workflow-cron-"));
    const outDir = path.join(parent, "out");
    const logs: string[] = [];
    try {
      const checkout = workflowCheckout(parent, "free", true);
      await expect(
        pack({
          checkoutDir: checkout.dir,
          manifestPath: checkout.manifest,
          outDir,
          install: false,
          logger: (m) => logs.push(m),
        }),
      ).rejects.toThrow(
        /Workflow binding JOBS runs its Workflow on a schedule, which Cloudflare offers only on Workers Paid; set "plan": "paid"/,
      );
      expect(existsSync(outDir)).toBe(false);
      expect(logs.some((l) => l.includes("dry-run"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 120_000);
});
