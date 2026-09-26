import { describe, expect, it } from "vitest";
import { buildArtifactFixture } from "../test/artifact-fixture";
import {
  entryBindings,
  entryNameProblems,
  entryPlaceholders,
  entryWorkers,
  MAX_FREE_PLAN_WORKERS,
  otherDoTagsDiffer,
  otherEntryWorkers,
  otherWorkersMatch,
  parseWorkerVersions,
  storedOtherWorkers,
  workerCountProblem,
  workerLabel,
} from "./entry-workers";
import { buildScriptMetadata, installVars } from "./install/metadata";

async function app() {
  return buildArtifactFixture({
    bindings: [
      { type: "kv_namespace", name: "CUT_KV" },
      {
        type: "durable_object_namespace",
        name: "ROOM",
        class_name: "Room",
        script_name: "{{workerName:jobs}}",
      },
    ],
    otherWorkers: [
      {
        name: "jobs",
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "durable_object_namespace", name: "ROOM", class_name: "Room" },
          { type: "plain_text", name: "APP_URL", text: "https://example.test" },
        ],
      },
      {
        name: "hooks",
        bindings: [{ type: "service", name: "APP", service: "{{workerName:app}}" }],
      },
    ],
    catalog: {
      secrets: [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: true, workers: ["app"] },
      ],
      vars: [{ name: "APP_URL", label: "App URL", default: "{{workerUrl}}", required: false }],
    },
  });
}

describe("entry workers", () => {
  it("installs the primary Worker under the install's name and the others after it", async () => {
    const { manifest } = await app();
    const workers = entryWorkers(manifest, "links");
    expect(workers.map((w) => [w.name, w.scriptName, w.primary])).toEqual([
      ["jobs", "links-jobs", false],
      ["app", "links", true],
      ["hooks", "links-hooks", false],
    ]);
    const split = otherEntryWorkers(manifest, "links");
    expect(split.before.map((w) => w.name)).toEqual(["jobs"]);
    expect(split.after.map((w) => w.name)).toEqual(["hooks"]);
    // Each Worker sees only its own secrets and vars.
    const primary = workers.find((w) => w.primary);
    expect(primary?.manifest.catalog.secrets.map((s) => s.name)).toEqual(["ADMIN_PASSWORD"]);
    expect(workers[0]?.manifest.catalog.secrets).toEqual([]);
    expect(workers[0]?.manifest.catalog.vars.map((v) => v.name)).toEqual(["APP_URL"]);
    expect(
      workerLabel(workers[0] ?? primary ?? workers[1] ?? { primary: true, scriptName: "" }),
    ).toBe(' (Worker "links-jobs")');
  });

  it("plans one resource per binding name and records a class with the Worker that has it", async () => {
    const { manifest } = await app();
    const bindings = entryBindings(manifest);
    expect(bindings.filter((b) => b.name === "CUT_KV")).toHaveLength(1);
    expect(bindings.find((b) => b.name === "ROOM")).toEqual({
      type: "durable_object_namespace",
      name: "ROOM",
      class_name: "Room",
    });
  });

  it("fills in other Workers' names and URLs, the primary's URL being the app's", async () => {
    const { manifest } = await app();
    expect(entryPlaceholders(manifest, "links", "acme", "https://links.example.com")).toEqual({
      app: { workerName: "links", workerUrl: "https://links.example.com" },
      jobs: { workerName: "links-jobs", workerUrl: "https://links-jobs.acme.workers.dev" },
      hooks: { workerName: "links-hooks", workerUrl: "https://links-hooks.acme.workers.dev" },
    });
    const single = await buildArtifactFixture();
    expect(entryPlaceholders(single.manifest, "links", "acme")).toBeUndefined();
  });

  it("points bindings between the Workers at their installed names", async () => {
    const { manifest } = await app();
    const workers = entryWorkers(manifest, "links");
    const hooks = workers.find((w) => w.name === "hooks");
    const primary = workers.find((w) => w.primary);
    if (hooks === undefined || primary === undefined) throw new Error("missing Worker");
    const names = { app: "links", jobs: "links-jobs", hooks: "links-hooks" };
    const created = [
      { binding: "CUT_KV", type: "kv_namespace" as const, name: "links-cut-kv", cfId: "kv-9" },
    ];
    const hooksMeta = buildScriptMetadata({
      manifest: hooks.manifest,
      workerName: hooks.scriptName,
      resources: created,
      vars: [],
      assetsJwt: null,
      entryWorkers: names,
    });
    expect(hooksMeta.bindings).toContainEqual({ type: "service", name: "APP", service: "links" });
    const primaryMeta = buildScriptMetadata({
      manifest: primary.manifest,
      workerName: primary.scriptName,
      resources: created,
      vars: [],
      assetsJwt: null,
      entryWorkers: names,
    });
    expect(primaryMeta.bindings).toContainEqual({
      type: "durable_object_namespace",
      name: "ROOM",
      class_name: "Room",
      script_name: "links-jobs",
    });
    // A binding to a Worker the app does not have never reaches an upload.
    expect(() =>
      buildScriptMetadata({
        manifest: primary.manifest,
        workerName: primary.scriptName,
        resources: created,
        vars: [],
        assetsJwt: null,
        entryWorkers: {},
      }),
    ).toThrow(/names a Worker the app does not have/);
  });

  it("gives every Worker the app's URL for {{workerUrl}} and its own for {{workerUrl:<name>}}", async () => {
    const { manifest } = await app();
    const jobs = entryWorkers(manifest, "links").find((w) => w.name === "jobs");
    if (jobs === undefined) throw new Error("no jobs Worker");
    const vars = installVars(
      {
        ...jobs.manifest,
        catalog: {
          ...jobs.manifest.catalog,
          vars: [
            {
              name: "APP_URL",
              label: "App URL",
              default: "{{workerUrl}} {{workerUrl:hooks}}",
              required: false,
            },
          ],
        },
      },
      {},
      {
        workerName: "links",
        subdomain: "acme",
        accountId: "acc",
        entryWorkers: entryPlaceholders(manifest, "links", "acme"),
      },
    );
    expect(vars.vars).toContainEqual({
      type: "plain_text",
      name: "APP_URL",
      text: "https://links.acme.workers.dev https://links-hooks.acme.workers.dev",
    });
  });

  it("refuses Worker names longer than Cloudflare allows", async () => {
    const { manifest } = await app();
    // 58 + "-jobs" fits in 63 characters; 58 + "-hooks" does not.
    const problems = entryNameProblems(manifest, "a".repeat(58));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"hooks"');
    expect(entryNameProblems(manifest, "links")).toEqual([]);
  });

  it("reads stored manifests and snapshot versions defensively", async () => {
    const { manifest } = await app();
    expect(storedOtherWorkers(JSON.stringify(manifest), "links").map((w) => w.scriptName)).toEqual([
      "links-jobs",
      "links-hooks",
    ]);
    expect(storedOtherWorkers("{", "links")).toEqual([]);
    expect(storedOtherWorkers(null, "links")).toEqual([]);
    expect(parseWorkerVersions('{"links-jobs":"v1"}')).toEqual({ "links-jobs": "v1" });
    expect(parseWorkerVersions("[1]")).toEqual({});
    expect(parseWorkerVersions(null)).toEqual({});
  });

  it("caps the Workers of an app on Workers Free only", () => {
    expect(workerCountProblem(MAX_FREE_PLAN_WORKERS, false)).toBeNull();
    expect(workerCountProblem(MAX_FREE_PLAN_WORKERS + 1, false)).toContain(
      `more than ${MAX_FREE_PLAN_WORKERS} Workers exceed the free plan's request budget`,
    );
    expect(workerCountProblem(5, true)).toBeNull();
  });

  it("tells whether the other Workers serve a snapshot's versions", () => {
    const snapshot = JSON.stringify({ "links-jobs": "v1" });
    expect(otherWorkersMatch(snapshot, JSON.stringify({ "links-jobs": "v1", x: "y" }))).toBe(true);
    expect(otherWorkersMatch(snapshot, JSON.stringify({ "links-jobs": "v2" }))).toBe(false);
    // Not known counts as serving something else.
    expect(otherWorkersMatch(snapshot, null)).toBe(false);
    expect(otherWorkersMatch(null, null)).toBe(true);
  });

  it("sees a Durable Object change in any other Worker", async () => {
    const before = await buildArtifactFixture({
      otherWorkers: [{ name: "jobs", migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }] }],
    });
    const after = await buildArtifactFixture({
      otherWorkers: [
        {
          name: "jobs",
          migrations: [
            { tag: "v1", new_sqlite_classes: ["Room"] },
            { tag: "v2", new_sqlite_classes: ["Lobby"] },
          ],
        },
      ],
    });
    const a = JSON.stringify(before.manifest);
    const b = JSON.stringify(after.manifest);
    expect(otherDoTagsDiffer(a, b, "links")).toBe(true);
    expect(otherDoTagsDiffer(a, a, "links")).toBe(false);
  });
});
