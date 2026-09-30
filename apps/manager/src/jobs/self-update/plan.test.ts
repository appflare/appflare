import type { ArtifactManifest } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { accessLoginUrl } from "../../test/access-sign-in";
import { buildArtifactFixture } from "../../test/artifact-fixture";
import type { HealthProbe } from "../install/health";
import {
  appendVersionHistory,
  classifyManagerCanary,
  isManagerKeyId,
  parseVersionHistory,
  selfUpdateBindings,
  verifyManagerManifest,
} from "./plan";

const MANIFEST: Pick<ArtifactManifest, "worker" | "assets"> = {
  worker: {
    name: "appflare",
    wranglerConfig: { declared: "wrangler.jsonc", effective: "{}" },
    mainModule: "index.js",
    compatibilityDate: "2026-09-21",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    modules: [],
    bindings: [
      { type: "d1", name: "DB" },
      { type: "kv_namespace", name: "KV" },
      { type: "workflow", name: "JOBS", workflow_name: "appflare-jobs", class_name: "JobWorkflow" },
      { type: "plain_text", name: "APPFLARE_VERSION", text: "0.2.0" },
    ],
    migrations: [],
    crons: ["*/30 * * * *"],
    queueConsumers: [],
    observability: { enabled: true },
    placement: null,
    limits: null,
  },
  assets: { config: {}, binding: "ASSETS", files: [] },
};

/** What `GET /workers/scripts/<name>/bindings` reports for a manager installed as "team-apps". */
const CURRENT = [
  { type: "assets", name: "ASSETS" },
  { type: "d1", name: "DB", database_id: "d1-uuid" },
  { type: "kv_namespace", name: "KV", namespace_id: "kv-id" },
  {
    type: "workflow",
    name: "JOBS",
    workflow_name: "team-apps-jobs",
    class_name: "JobWorkflow",
    script_name: "team-apps",
  },
  { type: "plain_text", name: "APPFLARE_VERSION", text: "0.1.0" },
  { type: "plain_text", name: "CATALOG_INDEX_URL", text: "https://example.test/index.json" },
  { type: "secret_text", name: "BETTER_AUTH_SECRET" },
  { type: "secret_text", name: "CF_API_TOKEN" },
];

describe("selfUpdateBindings", () => {
  it("copies the running Worker's bindings, keeps a renamed Workflow, and sets the new version", () => {
    const plan = selfUpdateBindings({
      current: CURRENT,
      manifest: MANIFEST,
      workerName: "team-apps",
      newVersion: "0.2.0",
    });
    expect(plan.problems).toEqual([]);
    expect(plan.databaseId).toBe("d1-uuid");
    expect(plan.bindings).toEqual([
      { type: "d1", name: "DB", id: "d1-uuid" },
      { type: "kv_namespace", name: "KV", namespace_id: "kv-id" },
      {
        type: "workflow",
        name: "JOBS",
        workflow_name: "team-apps-jobs",
        class_name: "JobWorkflow",
      },
      { type: "plain_text", name: "APPFLARE_VERSION", text: "0.2.0" },
      { type: "plain_text", name: "CATALOG_INDEX_URL", text: "https://example.test/index.json" },
      // Job units: the service binding to this Worker itself, by its own name.
      { type: "service", name: "SELF", service: "team-apps", entrypoint: "JobUnits" },
    ]);
  });

  it("keeps SELF on the running Worker, whatever the release declares", () => {
    const plan = selfUpdateBindings({
      current: [
        ...CURRENT,
        { type: "service", name: "SELF", service: "team-apps", environment: "production" },
        { type: "service", name: "MAILER", service: "mailer", entrypoint: "Send" },
      ],
      manifest: {
        ...MANIFEST,
        worker: {
          ...MANIFEST.worker,
          bindings: [
            ...MANIFEST.worker.bindings,
            { type: "service", name: "SELF", service: "appflare", entrypoint: "JobUnits" },
          ],
        },
      },
      workerName: "team-apps",
      newVersion: "0.2.0",
    });
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.bindings.filter((b) => b.type === "service")).toEqual([
      { type: "service", name: "MAILER", service: "mailer", entrypoint: "Send" },
      { type: "service", name: "SELF", service: "team-apps", entrypoint: "JobUnits" },
    ]);
  });

  it("refuses a SELF that points at another Worker instead of replacing it", () => {
    const plan = selfUpdateBindings({
      current: [...CURRENT, { type: "service", name: "SELF", service: "billing" }],
      manifest: MANIFEST,
      workerName: "team-apps",
      newVersion: "0.2.0",
    });
    expect(plan.problems).toEqual([
      'The running Worker\'s service binding SELF points at "billing", not at this Worker ("team-apps"); Appflare needs SELF for its binding to itself. Remove or rename that binding first.',
    ]);
    expect(plan.bindings.some((b) => b.name === "SELF")).toBe(false);
  });

  it("refuses when another kind of binding is already named SELF", () => {
    const plan = selfUpdateBindings({
      current: [...CURRENT, { type: "plain_text", name: "SELF", text: "x" }],
      manifest: MANIFEST,
      workerName: "team-apps",
      newVersion: "0.2.0",
    });
    expect(plan.problems).toEqual([
      "The running Worker has a plain_text binding named SELF, which Appflare needs for the service binding to itself.",
    ]);
  });

  it("accepts the older `id` form of a D1 binding and fills in a missing Workflow class", () => {
    const plan = selfUpdateBindings({
      current: [
        { type: "d1", name: "DB", id: "old-form" },
        { type: "kv_namespace", name: "KV", namespace_id: "kv-id" },
        { type: "workflow", name: "JOBS", workflow_name: "appflare-jobs" },
      ],
      manifest: MANIFEST,
      workerName: "appflare",
      newVersion: "0.2.0",
    });
    expect(plan.problems).toEqual([]);
    expect(plan.bindings).toContainEqual({ type: "d1", name: "DB", id: "old-form" });
    expect(plan.bindings).toContainEqual({
      type: "workflow",
      name: "JOBS",
      workflow_name: "appflare-jobs",
      class_name: "JobWorkflow",
    });
    // The version var is added even though the running Worker lacked it.
    expect(plan.bindings).toContainEqual({
      type: "plain_text",
      name: "APPFLARE_VERSION",
      text: "0.2.0",
    });
  });

  it("warns about binding types it does not know and refuses a var without its value", () => {
    const plan = selfUpdateBindings({
      current: [
        ...CURRENT,
        { type: "hyperdrive", name: "PG", id: "hd-1" },
        { type: "ai", name: "AI" },
        { type: "plain_text", name: "EMPTY" },
      ],
      manifest: MANIFEST,
      workerName: "team-apps",
      newVersion: "0.2.0",
    });
    expect(plan.bindings).toContainEqual({ type: "hyperdrive", name: "PG", id: "hd-1" });
    expect(plan.bindings).toContainEqual({ type: "ai", name: "AI" });
    expect(plan.warnings).toEqual([
      'Binding PG has type "hyperdrive", which Appflare does not know; it is copied to the new version as Cloudflare reports it.',
    ]);
    expect(plan.problems).toEqual([
      "The running Worker reports variable EMPTY without its value, so the new version cannot keep it.",
    ]);
  });

  it("keeps the password reset email binding with its sender restriction, without a warning", () => {
    const authEmail = {
      type: "send_email",
      name: "AUTH_EMAIL",
      allowed_sender_addresses: ["reset@example.com"],
    };
    const plan = selfUpdateBindings({
      current: [...CURRENT, authEmail],
      manifest: MANIFEST,
      workerName: "team-apps",
      newVersion: "0.2.0",
    });
    expect(plan.bindings).toContainEqual(authEmail);
    expect(plan.warnings).toEqual([]);
    expect(plan.problems).toEqual([]);
  });

  it("adds new bindings that need no resource and refuses ones that do", () => {
    const manifest = {
      ...MANIFEST,
      worker: {
        ...MANIFEST.worker,
        bindings: [
          ...MANIFEST.worker.bindings,
          { type: "ai", name: "AI" },
          { type: "r2_bucket", name: "FILES" },
        ],
      },
    };
    const plan = selfUpdateBindings({
      current: CURRENT,
      manifest,
      workerName: "team-apps",
      newVersion: "0.2.0",
    });
    expect(plan.bindings).toContainEqual({ type: "ai", name: "AI" });
    expect(plan.problems).toEqual([
      "The new version needs a r2_bucket binding FILES, which the running Worker does not have; Appflare does not create resources for itself.",
    ]);
  });

  it("refuses when the running Worker lacks a binding the manager needs or changed its type", () => {
    const plan = selfUpdateBindings({
      current: [
        { type: "d1", name: "DB" },
        { type: "plain_text", name: "KV", text: "oops" },
      ],
      manifest: MANIFEST,
      workerName: "appflare",
      newVersion: "0.2.0",
    });
    expect(plan.databaseId).toBeNull();
    expect(plan.problems).toEqual([
      "The running Worker reports D1 binding DB without a database id.",
      "The new version needs a d1 binding DB, which the running Worker does not have; Appflare does not create resources for itself.",
      "Binding KV is a plain_text binding on the running Worker and a kv_namespace binding in the new version.",
      "The new version needs a workflow binding JOBS, which the running Worker does not have; Appflare does not create resources for itself.",
      "The running Worker has no d1 binding DB.",
      "The running Worker has no kv_namespace binding KV.",
      "The running Worker has no workflow binding JOBS.",
    ]);
  });
});

const response = (status: number, body: string): HealthProbe => ({
  kind: "response",
  status,
  bodyStart: body.slice(0, 200),
  body,
});

describe("classifyManagerCanary", () => {
  const healthy = JSON.stringify({ version: "0.2.0", db: "ok", schemaVersion: 5 });

  it("is healthy only when the preview reports the new version and a working database", () => {
    expect(classifyManagerCanary(response(200, healthy), "0.2.0", 1, 0)).toEqual({
      verdict: "healthy",
      status: 200,
    });
    expect(
      classifyManagerCanary(
        response(200, JSON.stringify({ version: "0.1.0", db: "ok" })),
        "0.2.0",
        1,
        0,
      ),
    ).toEqual({ verdict: "unhealthy", reason: "the preview reports version 0.1.0, not 0.2.0" });
    expect(
      classifyManagerCanary(
        response(200, JSON.stringify({ version: "0.2.0", db: "error" })),
        "0.2.0",
        1,
        0,
      ),
    ).toEqual({ verdict: "unhealthy", reason: 'the preview reports its database as "error"' });
    expect(classifyManagerCanary(response(200, "<html>"), "0.2.0", 1, 0)).toMatchObject({
      verdict: "unhealthy",
    });
  });

  it("retries 1042, 404, connection errors, and early 5xx, then gives up", () => {
    expect(classifyManagerCanary(response(404, "error code: 1042"), "0.2.0", 1, 0)).toMatchObject({
      verdict: "retry",
    });
    expect(classifyManagerCanary(response(404, "Not found"), "0.2.0", 1, 0)).toMatchObject({
      verdict: "retry",
    });
    expect(classifyManagerCanary({ kind: "error", message: "dns" }, "0.2.0", 1, 0)).toMatchObject({
      verdict: "retry",
    });
    expect(
      classifyManagerCanary(response(503, '{"error":"migrating"}'), "0.2.0", 2, 5_000),
    ).toMatchObject({ verdict: "retry" });
    expect(
      classifyManagerCanary(response(503, '{"error":"migrating"}'), "0.2.0", 3, 60_000),
    ).toMatchObject({ verdict: "unhealthy" });
    expect(classifyManagerCanary(response(404, "Not found"), "0.2.0", 10, 0, 10)).toMatchObject({
      verdict: "unhealthy",
    });
  });

  it("fails at once, naming Cloudflare Access, when Access answers the preview", () => {
    const access: HealthProbe = {
      kind: "response",
      status: 302,
      bodyStart: "",
      location: accessLoginUrl("0a1b2c3d-appflare.appflare-dev.workers.dev", "/api/health"),
    };
    expect(classifyManagerCanary(access, "0.2.0", 1, 0)).toEqual({
      verdict: "unhealthy",
      reason:
        "Cloudflare Access answered the preview with its sign-in page instead of Appflare. In Zero Trust, let Appflare's preview URLs answer /api/health without a sign-in (a Bypass policy for that path), then try again",
    });
  });
});

describe("verifyManagerManifest", () => {
  const manager = (keyId: string, version = "0.2.0") =>
    buildArtifactFixture({
      keyId,
      version,
      tweak: (m) => {
        m.app = "appflare";
      },
    });

  it("accepts an Appflare release signed with an Appflare key", async () => {
    const f = await manager("appflare-test");
    const manifest = await verifyManagerManifest(f.manifestBytes, f.signature, "0.2.0", f.keys);
    expect(manifest.version).toBe("0.2.0");
    expect(isManagerKeyId("appflare-2026-09")).toBe(true);
    expect(isManagerKeyId("catalog-2026-09")).toBe(false);
  });

  it("rejects catalog keys, other apps, other versions, and bad signatures", async () => {
    const catalogSigned = await manager("catalog-test");
    await expect(
      verifyManagerManifest(
        catalogSigned.manifestBytes,
        catalogSigned.signature,
        "0.2.0",
        catalogSigned.keys,
      ),
    ).rejects.toThrow(/does not sign Appflare releases/);

    const app = await buildArtifactFixture({ keyId: "appflare-test", version: "0.2.0" });
    await expect(
      verifyManagerManifest(app.manifestBytes, app.signature, "0.2.0", app.keys),
    ).rejects.toThrow(/not an Appflare release/);

    const f = await manager("appflare-test");
    await expect(
      verifyManagerManifest(f.manifestBytes, f.signature, "0.3.0", f.keys),
    ).rejects.toThrow(/version 0.2.0, the release is 0.3.0/);

    const other = await manager("appflare-test");
    await expect(
      verifyManagerManifest(f.manifestBytes, f.signature, "0.2.0", other.keys),
    ).rejects.toThrow(/does not verify/);
    await expect(verifyManagerManifest(f.manifestBytes, f.signature, "0.2.0")).rejects.toThrow(
      /no trusted signing key/,
    );
  });

  it("rejects a release of static assets only, which has no main module to upload", async () => {
    const f = await buildArtifactFixture({
      keyId: "appflare-test",
      version: "0.2.0",
      assetsOnly: true,
      assets: [{ route: "/index.html", content: "<h1>hi</h1>" }],
      tweak: (m) => {
        m.app = "appflare";
      },
    });
    await expect(
      verifyManagerManifest(f.manifestBytes, f.signature, "0.2.0", f.keys),
    ).rejects.toThrow("the release has no Worker code (it serves static assets only)");
  });
});

describe("version history", () => {
  const entry = (jobId: string, version: string) => ({
    version,
    from: "0.1.0",
    jobId,
    workerVersionId: "v1",
    at: "2026-09-23T00:00:00.000Z",
  });

  it("appends once per job and keeps the newest entries", () => {
    const one = appendVersionHistory(undefined, entry("a", "0.2.0"));
    expect(appendVersionHistory(one, entry("a", "0.2.0"))).toBe(one);
    const two = appendVersionHistory(one, entry("b", "0.3.0"));
    expect(parseVersionHistory(two).map((e) => e.jobId)).toEqual(["a", "b"]);
    expect(parseVersionHistory(appendVersionHistory(two, entry("c", "0.4.0"), 2))).toEqual([
      entry("b", "0.3.0"),
      entry("c", "0.4.0"),
    ]);
    expect(parseVersionHistory("not json")).toEqual([]);
  });
});
