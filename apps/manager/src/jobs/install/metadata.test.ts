import { describe, expect, it } from "vitest";
import { buildArtifactFixture } from "../../test/artifact-fixture";
import {
  buildScriptMetadata,
  durableObjectMigrations,
  resolveVars,
  uploadModule,
} from "./metadata";

describe("resolveVars", () => {
  it("uses the user's value, else the catalog default, else the recorded var; blanks are omitted", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "plain_text", name: "MODE", text: "prod" },
        { type: "plain_text", name: "HOME_PAGE", text: "recorded" },
      ],
      catalog: {
        vars: [
          { name: "HOME_PAGE", label: "Home", required: false },
          { name: "GREETING", label: "Greeting", default: "hi", required: false },
          { name: "EMPTY", label: "Empty", required: false },
        ],
      },
    });
    expect(resolveVars(f.manifest, { HOME_PAGE: "admin", EMPTY: "" })).toEqual({
      MODE: "prod",
      HOME_PAGE: "admin",
      GREETING: "hi",
    });
    expect(resolveVars(f.manifest, {})).toEqual({
      MODE: "prod",
      HOME_PAGE: "recorded",
      GREETING: "hi",
    });
  });
});

describe("buildScriptMetadata", () => {
  it("fills binding ids from created resources and adds vars and assets", async () => {
    const f = await buildArtifactFixture({
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "d1", name: "DB" },
        { type: "r2_bucket", name: "FILES" },
        { type: "queue", name: "Q", delivery_delay: 5 },
        { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "JobWorkflow" },
        { type: "plain_text", name: "MODE", text: "prod" },
      ],
      assets: [{ route: "/index.html", content: "<h1>hi</h1>" }],
      tweak: (m) => {
        m.assets.binding = "ASSETS";
        m.assets.config = { not_found_handling: "single-page-application" };
        m.worker.observability = { enabled: true };
      },
    });
    const metadata = buildScriptMetadata({
      manifest: f.manifest,
      resources: [
        { binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv-id" },
        { binding: "DB", type: "d1", name: "cut-db", cfId: "d1-uuid" },
        { binding: "FILES", type: "r2_bucket", name: "cut-files", cfId: "cut-files" },
        { binding: "Q", type: "queue", name: "cut-q", cfId: "queue-id" },
      ],
      vars: { MODE: "prod", HOME_PAGE: "admin" },
      assetsJwt: "completion-jwt",
      workflowNames: { JOBS: "cut-jobs" },
    });
    expect(metadata).toEqual({
      main_module: "worker.js",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-id" },
        { type: "d1", name: "DB", id: "d1-uuid" },
        { type: "r2_bucket", name: "FILES", bucket_name: "cut-files" },
        { type: "queue", name: "Q", queue_name: "cut-q", delivery_delay: 5 },
        { type: "workflow", name: "JOBS", workflow_name: "cut-jobs", class_name: "JobWorkflow" },
        { type: "plain_text", name: "MODE", text: "prod" },
        { type: "plain_text", name: "HOME_PAGE", text: "admin" },
        { type: "assets", name: "ASSETS" },
      ],
      assets: { jwt: "completion-jwt", config: { not_found_handling: "single-page-application" } },
      observability: { enabled: true },
    });
    expect(metadata.keep_bindings).toBeUndefined();
  });

  it("sends assets without a binding when the app has none, and nothing when there are no assets", async () => {
    const f = await buildArtifactFixture();
    const withAssets = buildScriptMetadata({
      manifest: f.manifest,
      resources: [{ binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv" }],
      vars: {},
      assetsJwt: "jwt",
    });
    expect(withAssets.assets).toEqual({ jwt: "jwt", config: {} });
    expect(withAssets.bindings?.some((b) => b.type === "assets")).toBe(false);
    const none = buildScriptMetadata({
      manifest: f.manifest,
      resources: [{ binding: "CUT_KV", type: "kv_namespace", name: "cut-cut-kv", cfId: "kv" }],
      vars: {},
      assetsJwt: null,
    });
    expect(none.assets).toBeUndefined();
  });

  it("refuses a resource binding that was not created", async () => {
    const f = await buildArtifactFixture();
    expect(() =>
      buildScriptMetadata({ manifest: f.manifest, resources: [], vars: {}, assetsJwt: null }),
    ).toThrow(/CUT_KV \(kv_namespace\) has no created resource/);
  });

  it("sends Durable Object migrations the way wrangler does for a new script", () => {
    expect(durableObjectMigrations([])).toBeUndefined();
    expect(
      durableObjectMigrations([
        { tag: "v1", new_sqlite_classes: ["Room"] },
        { tag: "v2", renamed_classes: [{ from: "Room", to: "Chat" }] },
      ]),
    ).toEqual({
      new_tag: "v2",
      steps: [
        { new_sqlite_classes: ["Room"] },
        { renamed_classes: [{ from: "Room", to: "Chat" }] },
      ],
    });
  });

  it("gives module parts wrangler's content types", () => {
    const bytes = new Uint8Array([1]);
    expect(uploadModule({ name: "a.js", type: "esm" }, bytes).contentType).toBe(
      "application/javascript+module",
    );
    expect(uploadModule({ name: "a.bin", type: "data" }, bytes).contentType).toBe(
      "application/octet-stream",
    );
  });
});
