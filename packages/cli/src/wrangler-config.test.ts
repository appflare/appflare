import { rmSync } from "node:fs";
import type { ArtifactManifest } from "@appflare/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixtureArtifact } from "./test-fixtures.ts";
import { buildWranglerConfig, workflowNameFor } from "./wrangler-config.ts";

let manifest: ArtifactManifest;
let dir: string;
beforeAll(async () => {
  ({ manifest, dir } = await buildFixtureArtifact({ version: "1.2.3" }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildWranglerConfig", () => {
  it("matches the snapshot for the default name", () => {
    expect(buildWranglerConfig(manifest, { name: "appflare" })).toMatchSnapshot();
  });

  it("never carries an account id or resource ids", () => {
    const json = JSON.stringify(buildWranglerConfig(manifest, { name: "appflare" }));
    expect(json).not.toMatch(/account_id|database_id|"id"|namespace_id|preview_id/);
  });

  it("keeps both compatibility flags, the workflow binding, the cron, and the var", () => {
    const config = buildWranglerConfig(manifest, { name: "appflare" });
    expect(config.compatibility_flags).toEqual(["nodejs_compat", "global_fetch_strictly_public"]);
    expect(config.workflows).toEqual([
      { binding: "JOBS", name: "appflare-jobs", class_name: "JobWorkflow" },
    ]);
    expect(config.triggers).toEqual({ crons: ["*/30 * * * *"] });
    expect(config.vars).toEqual({ APPFLARE_VERSION: "1.2.3" });
    expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "appflare" }]);
    expect(config.kv_namespaces).toEqual([{ binding: "KV" }]);
    expect(config).toMatchObject({ workers_dev: true, preview_urls: true, keep_vars: true });
  });

  it("names the database and workflow after a custom Worker name", () => {
    const config = buildWranglerConfig(manifest, { name: "appflare-cli-test" });
    expect(config.name).toBe("appflare-cli-test");
    expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "appflare-cli-test" }]);
    expect(config.workflows?.[0]?.name).toBe("appflare-cli-test-jobs");
  });

  it("keeps the assets directory and binding even if the config names others", () => {
    const edited = structuredClone(manifest);
    edited.assets.config = { ...edited.assets.config, directory: "/etc", binding: "X" };
    expect(buildWranglerConfig(edited, { name: "appflare" }).assets).toMatchObject({
      directory: "assets",
      binding: "ASSETS",
    });
  });

  it("refuses binding types it cannot provision", () => {
    const edited = structuredClone(manifest);
    edited.worker.bindings.push({ type: "r2_bucket", name: "BUCKET" });
    expect(() => buildWranglerConfig(edited, { name: "appflare" })).toThrow(
      "r2_bucket binding (BUCKET)",
    );
  });
});

describe("workflowNameFor", () => {
  it("keeps the manifest name for the default Worker name", () => {
    expect(workflowNameFor("appflare-jobs", "appflare", "appflare")).toBe("appflare-jobs");
  });
  it("swaps the prefix for another name", () => {
    expect(workflowNameFor("appflare-jobs", "appflare", "mgr")).toBe("mgr-jobs");
  });
  it("prefixes names that do not start with the Worker name", () => {
    expect(workflowNameFor("jobs", "appflare", "mgr")).toBe("mgr-jobs");
  });
});
