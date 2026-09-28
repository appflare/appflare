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

  it("binds the manager to its own job units by the name it deploys under", () => {
    expect(buildWranglerConfig(manifest, { name: "appflare" }).services).toEqual([
      { binding: "SELF", service: "appflare", entrypoint: "JobUnits" },
    ]);
    expect(buildWranglerConfig(manifest, { name: "team-apps" }).services).toEqual([
      { binding: "SELF", service: "team-apps", entrypoint: "JobUnits" },
    ]);
  });

  it("declares the version metadata binding the manager reads at setup", () => {
    expect(buildWranglerConfig(manifest, { name: "appflare" }).version_metadata).toEqual({
      binding: "CF_VERSION_METADATA",
    });
  });

  it("refuses a release from before setup started with the API token", () => {
    const older = structuredClone(manifest);
    older.worker.bindings = older.worker.bindings.filter((b) => b.type !== "version_metadata");
    expect(() => buildWranglerConfig(older, { name: "appflare" })).toThrow(
      "the manager release 1.2.3 predates setup with a Cloudflare API token (it has no version_metadata binding); this installer needs manager 0.1.0 or newer",
    );
  });

  it("replaces a SELF binding the artifact declares with one to this install", () => {
    const edited = structuredClone(manifest);
    edited.worker.bindings.push({
      type: "service",
      name: "SELF",
      service: "appflare",
      entrypoint: "JobUnits",
    });
    expect(buildWranglerConfig(edited, { name: "team-apps" }).services).toEqual([
      { binding: "SELF", service: "team-apps", entrypoint: "JobUnits" },
    ]);
    edited.worker.bindings.push({ type: "service", name: "OTHER", service: "x" });
    expect(() => buildWranglerConfig(edited, { name: "appflare" })).toThrow(
      "service binding (OTHER)",
    );
  });

  it("keeps the assets directory and binding even if the config names others", () => {
    const edited = structuredClone(manifest);
    edited.assets.config = { ...edited.assets.config, directory: "/etc", binding: "X" };
    expect(buildWranglerConfig(edited, { name: "appflare" }).assets).toMatchObject({
      directory: "assets",
      binding: "ASSETS",
    });
  });

  it("leaves _redirects and _headers out of the assets config (they are files wrangler reads)", () => {
    const edited = structuredClone(manifest);
    edited.assets.config = { ...edited.assets.config, _redirects: "/a /b 301\n", _headers: "" };
    const assets = buildWranglerConfig(edited, { name: "appflare" }).assets;
    expect(assets).not.toHaveProperty("_redirects");
    expect(assets).not.toHaveProperty("_headers");
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
