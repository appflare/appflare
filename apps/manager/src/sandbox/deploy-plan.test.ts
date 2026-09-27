import { SANDBOX_CONTAINERS } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { sandboxRelease } from "../test/fake-sandbox-account";
import {
  type ContainerWait,
  containerChange,
  containerNamespaces,
  containerProgress,
  isSandboxWorker,
  migrationsToUpload,
  rolloutSteps,
  runsConfiguration,
  sandboxScriptMetadata,
  sandboxVersionOf,
} from "./deploy-plan";
import { sandboxPreflightProblems } from "./preflight";

const [SMALL, LARGE] = SANDBOX_CONTAINERS;
if (SMALL === undefined || LARGE === undefined) throw new Error("two containers");
const IMAGE = "docker.io/mendylanda/appflare-sandbox:0.2.0";
const V1 = [{ tag: "v1", new_sqlite_classes: ["Sandbox", "LargeSandbox"] }];

describe("migrationsToUpload", () => {
  it("follows wrangler: every step for a new Worker, the rest after its tag, none when current", () => {
    const v2 = [...V1, { tag: "v2", renamed_classes: [{ from: "A", to: "B" }] }];
    expect(migrationsToUpload(V1, null)).toEqual({
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["Sandbox", "LargeSandbox"] }],
    });
    expect(migrationsToUpload(v2, "v1")).toEqual({
      old_tag: "v1",
      new_tag: "v2",
      steps: [{ renamed_classes: [{ from: "A", to: "B" }] }],
    });
    expect(migrationsToUpload(V1, "v1")).toBeUndefined();
    expect(migrationsToUpload(V1, "v0")).toMatchObject({ old_tag: "v0", new_tag: "v1" });
    expect(migrationsToUpload([], null)).toBeUndefined();
  });
});

describe("sandboxScriptMetadata", () => {
  it("names the release's main module, and refuses a release without one", async () => {
    const release = await sandboxRelease("0.1.2");
    expect(sandboxScriptMetadata(release.manifest, null).main_module).toBe("worker.js");
    const noCode = structuredClone(release.manifest);
    delete noCode.worker.mainModule;
    expect(() => sandboxScriptMetadata(noCode, null)).toThrow(
      "the sandbox Worker release has no Worker code (it serves static assets only)",
    );
  });
});

describe("containerNamespaces", () => {
  it("reads each class's namespace from the version, then from the account's list", () => {
    expect(
      containerNamespaces(
        [
          {
            type: "durable_object_namespace",
            name: "Sandbox",
            class_name: "Sandbox",
            namespace_id: "ns-1",
          },
          { type: "r2_bucket", name: "BUILDS" },
        ],
        [
          { id: "ns-2", script: "appflare-sandbox", class: "LargeSandbox" },
          { id: "ns-x", script: "someone-else", class: "Sandbox" },
        ],
      ),
    ).toEqual({ Sandbox: "ns-1", LargeSandbox: "ns-2" });
    expect(containerNamespaces(undefined)).toEqual({ Sandbox: null, LargeSandbox: null });
  });
});

describe("sandbox Worker identity", () => {
  it("recognises an Appflare sandbox Worker and its version by its bindings", () => {
    const bindings = [
      { type: "durable_object_namespace", name: "Sandbox" },
      { type: "r2_bucket", name: "BUILDS" },
      { type: "plain_text", name: "APPFLARE_VERSION", text: "0.1.2" },
    ];
    expect(isSandboxWorker(bindings)).toBe(true);
    expect(sandboxVersionOf(bindings)).toBe("0.1.2");
    expect(isSandboxWorker(bindings.slice(1))).toBe(false);
    expect(isSandboxWorker(null)).toBe(false);
    expect(sandboxVersionOf([])).toBeNull();
  });
});

describe("containerChange", () => {
  const existing = (image: string, over: Record<string, unknown> = {}) => ({
    id: "app-1",
    name: SMALL.name,
    max_instances: 2,
    configuration: { image, instance_type: "standard-1" },
    durable_objects: { namespace_id: "ns-1" },
    ...over,
  });

  it("creates a missing application with wrangler's defaults", () => {
    expect(containerChange(SMALL, "0.2.0", "ns-1", false, null)).toEqual({
      kind: "create",
      body: {
        name: SMALL.name,
        scheduling_policy: "default",
        observability: { logs: { enabled: false } },
        configuration: { image: IMAGE, instance_type: "standard-1" },
        instances: 0,
        max_instances: 2,
        constraints: { tiers: [1, 2] },
        durable_objects: { namespace_id: "ns-1" },
        rollout_active_grace_period: 0,
      },
    });
  });

  it("leaves an application that runs the release, and patches only its size when that differs", () => {
    expect(containerChange(SMALL, "0.2.0", "ns-1", true, existing(IMAGE))).toEqual({
      kind: "none",
    });
    expect(
      containerChange(SMALL, "0.2.0", "ns-1", true, existing(IMAGE, { max_instances: 1 })),
    ).toEqual({ kind: "patch", modify: { max_instances: 2 } });
  });

  it("reads the size Cloudflare reports instead of the instance type it was created with", () => {
    const reported = (image: string, vcpu: number, memory: number, disk: number) => ({
      image,
      vcpu,
      memory_mib: memory,
      disk: { size_mb: disk, size: `${disk / 1000}GB` },
      runtime: "firecracker",
    });
    const target = { image: IMAGE, instance_type: "standard-1" };
    expect(runsConfiguration(reported(IMAGE, 0.5, 4096, 8000), target)).toBe(true);
    expect(runsConfiguration(reported(IMAGE, 1, 6144, 12000), target)).toBe(false);
    expect(runsConfiguration(reported("old", 0.5, 4096, 8000), target)).toBe(false);
    expect(runsConfiguration({ image: IMAGE }, target)).toBe(true);
    expect(
      containerChange(SMALL, "0.2.0", "ns-1", true, {
        ...existing(IMAGE),
        configuration: reported(IMAGE, 0.5, 4096, 8000),
      }),
    ).toEqual({ kind: "none" });
  });

  it("patches and rolls out an application on another image", () => {
    const change = containerChange(SMALL, "0.2.0", "ns-1", true, existing("old:0.1.0"));
    expect(change).toMatchObject({
      kind: "rollout",
      modify: { max_instances: 2, configuration: { image: IMAGE, instance_type: "standard-1" } },
      rollout: { strategy: "rolling", kind: "full_auto", target_configuration: { image: IMAGE } },
    });
  });

  it("waits for a rollout to the release already under way, and replaces one to another image", () => {
    const rolling = (image: string) => ({
      id: "r-1",
      status: "progressing",
      target_configuration: { image, instance_type: "standard-1" },
    });
    expect(containerChange(SMALL, "0.2.0", "ns-1", true, existing("old"), rolling(IMAGE))).toEqual({
      kind: "wait-rollout",
      rolloutId: "r-1",
    });
    expect(
      containerChange(SMALL, "0.2.0", "ns-1", true, existing("old"), rolling("other")).kind,
    ).toBe("rollout");
  });

  it("refuses an application that backs another namespace", () => {
    const change = containerChange(
      SMALL,
      "0.2.0",
      "ns-1",
      true,
      existing(IMAGE, {
        durable_objects: { namespace_id: "ns-other" },
      }),
    );
    expect(change.kind).toBe("conflict");
  });

  it("rolls one instance at once and more in two steps", () => {
    expect(rolloutSteps(1)).toEqual({ step_percentage: 100 });
    expect(rolloutSteps(2).steps?.map((s) => s.step_size.percentage)).toEqual([10, 100]);
    expect(
      containerChange(LARGE, "0.2.0", "ns-2", true, {
        id: "app-2",
        name: LARGE.name,
        max_instances: 1,
        configuration: { image: "old", instance_type: "standard-2" },
      }),
    ).toMatchObject({ kind: "rollout", rollout: { step_percentage: 100 } });
  });
});

describe("containerProgress", () => {
  const wait = (rolloutId: string | null = null): ContainerWait => ({
    id: "app-1",
    name: SMALL.name,
    maxInstances: 2,
    rolloutId,
  });
  const app = (instances: Record<string, number>) => ({
    id: "app-1",
    name: SMALL.name,
    health: { instances },
  });

  it("waits for a new application's prepared instances", () => {
    expect(containerProgress(wait(), app({}), null).settled).toBe(false);
    expect(containerProgress(wait(), app({ healthy: 1, starting: 1 }), null).settled).toBe(false);
    expect(containerProgress(wait(), app({ healthy: 2 }), null)).toMatchObject({
      settled: true,
      summary: `${SMALL.name}: 2 healthy, 0 starting, 0 scheduling, 0 failed of 2.`,
    });
    // One healthy and nothing else starting counts too.
    expect(containerProgress(wait(), app({ healthy: 1 }), null).settled).toBe(true);
  });

  it("waits for a rollout to complete, and gives up on a reverted one", () => {
    const rollout = (status: string) => ({ id: "r-1", status });
    expect(
      containerProgress(wait("r-1"), app({ healthy: 2 }), rollout("progressing")).settled,
    ).toBe(false);
    expect(containerProgress(wait("r-1"), app({}), rollout("completed")).settled).toBe(true);
    expect(containerProgress(wait("r-1"), app({}), rollout("reverted")).failure).toMatch(
      /was reverted/,
    );
  });
});

describe("sandboxPreflightProblems", () => {
  it("names each reason, and nothing for probes that could not tell", () => {
    expect(
      sandboxPreflightProblems({
        r2: { state: "not-enabled" },
        containers: { state: "unknown", reason: "no-permission", detail: "HTTP 403" },
        accountId: "acc1",
      }),
    ).toEqual([
      expect.stringMatching(/lacks Containers: Edit/),
      expect.stringMatching(/R2 is not enabled.*\?to=\/acc1\/r2\/overview/),
    ]);
    expect(
      sandboxPreflightProblems({
        r2: null,
        containers: { state: "needs-workers-paid" },
        accountId: "acc1",
      }),
    ).toEqual([expect.stringMatching(/need Workers Paid.*\?to=\/acc1\/workers\/plans/)]);
    expect(
      sandboxPreflightProblems({
        r2: { state: "unknown", reason: "error", detail: "HTTP 500" },
        containers: { state: "available" },
        accountId: null,
      }),
    ).toEqual([]);
    expect(
      sandboxPreflightProblems(
        { r2: { state: "not-enabled" }, containers: { state: "available" }, accountId: null },
        { containersOnly: true },
      ),
    ).toEqual([]);
  });
});
