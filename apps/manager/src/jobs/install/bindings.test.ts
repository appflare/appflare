import { describe, expect, it } from "vitest";
import { PASSTHROUGH_BINDING_TYPES, planBindings, resourceName } from "./bindings";

describe("resourceName", () => {
  it("is <workerName>-<binding lowercased, _ -> ->", () => {
    expect(resourceName("cut", "CUT_KV")).toBe("cut-cut-kv");
    expect(resourceName("my-app", "DB")).toBe("my-app-db");
    expect(resourceName("x", "Media_Bucket_2")).toBe("x-media-bucket-2");
  });

  it("drops characters no resource name allows", () => {
    expect(resourceName("cut", "$KV")).toBe("cut-kv");
  });
});

describe("planBindings", () => {
  it("plans resources, records Durable Objects, and passes the rest through", () => {
    const plan = planBindings("cut", [
      { type: "kv_namespace", name: "CUT_KV" },
      { type: "d1", name: "DB" },
      { type: "r2_bucket", name: "FILES" },
      { type: "queue", name: "JOBS_QUEUE" },
      { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
      { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "JobWorkflow" },
      { type: "plain_text", name: "MODE", text: "prod" },
      { type: "ai", name: "AI" },
      {
        type: "ratelimit",
        name: "LIMITER",
        namespace_id: "1001",
        simple: { limit: 1, period: 10 },
      },
      { type: "images", name: "IMAGES" },
    ]);
    expect(plan.problems).toEqual([]);
    expect(plan.resources.map((r) => [r.kind, r.binding, r.name])).toEqual([
      ["kv", "CUT_KV", "cut-cut-kv"],
      ["d1", "DB", "cut-db"],
      ["r2", "FILES", "cut-files"],
      ["queue", "JOBS_QUEUE", "cut-jobs-queue"],
    ]);
    expect(plan.durableObjects).toEqual([{ binding: "ROOMS", className: "Room" }]);
    // Workflow names are account-wide: renamed like resources.
    expect(plan.workflows).toEqual([
      { binding: "JOBS", name: "cut-jobs", className: "JobWorkflow" },
    ]);
  });

  it("refuses a Workflow that belongs to another script", () => {
    const plan = planBindings("cut", [
      { type: "workflow", name: "W", workflow_name: "w", class_name: "W", script_name: "other" },
    ]);
    expect(plan.problems[0]).toMatch(/Workflow binding W points at another Worker/);
  });

  it("plans a Vectorize index with the dimensions and metric the binding records", () => {
    const plan = planBindings("second-brain", [
      { type: "vectorize", name: "VECTORIZE", dimensions: 384, metric: "cosine" },
      { type: "ai", name: "AI" },
    ]);
    expect(plan.problems).toEqual([]);
    // Workers AI needs no resource; it passes through.
    expect(plan.resources).toEqual([
      {
        binding: "VECTORIZE",
        type: "vectorize",
        kind: "vectorize",
        name: "second-brain-vectorize",
        vectorize: { dimensions: 384, metric: "cosine" },
      },
    ]);
  });

  it("refuses a Vectorize index name longer than Vectorize allows", () => {
    const plan = planBindings("a".repeat(60), [
      { type: "vectorize", name: "VECTORS", dimensions: 768, metric: "euclidean" },
    ]);
    expect(plan.problems).toEqual([
      expect.stringMatching(/The vectorize name "a{60}-vectors" is longer than 64 characters/),
    ]);
  });

  it("refuses binding types it cannot install and names that are too long", () => {
    const plan = planBindings("a".repeat(54), [
      { type: "mtls_certificate", name: "CERT" },
      { type: "r2_bucket", name: "FILES_AND_MORE" },
      { type: "durable_object_namespace", name: "X", class_name: "X", script_name: "other" },
    ]);
    expect(plan.problems).toHaveLength(3);
    expect(plan.problems[0]).toMatch(/"mtls_certificate"/);
    expect(plan.problems[1]).toMatch(/longer than 63/);
    expect(plan.problems[2]).toMatch(/another Worker/);
  });

  it("plans a Hyperdrive configuration for each declared database, named like any resource", () => {
    const plan = planBindings(
      "feedlog",
      [
        { type: "hyperdrive", name: "HYPERDRIVE" },
        { type: "r2_bucket", name: "FILES" },
      ],
      [{ binding: "HYPERDRIVE", protocol: "postgres" }],
    );
    expect(plan.problems).toEqual([]);
    expect(plan.resources).toEqual([
      {
        binding: "HYPERDRIVE",
        type: "hyperdrive",
        kind: "hyperdrive",
        name: "feedlog-hyperdrive",
        protocol: "postgres",
      },
      { binding: "FILES", type: "r2_bucket", kind: "r2", name: "feedlog-files" },
    ]);
  });

  it("refuses a Hyperdrive binding the catalog manifest does not declare, and the reverse", () => {
    const undeclared = planBindings("app", [{ type: "hyperdrive", name: "PG" }]);
    expect(undeclared.resources).toEqual([]);
    expect(undeclared.problems).toEqual([
      expect.stringMatching(/Hyperdrive binding PG is not declared in the catalog manifest/),
    ]);
    const unbound = planBindings("app", [], [{ binding: "PG", protocol: "mysql" }]);
    expect(unbound.problems).toEqual([
      expect.stringMatching(/declares PG, but the Worker has no Hyperdrive binding/),
    ]);
  });
});

describe("service bindings in catalog apps", () => {
  // An app must never be able to bind to another Worker in the account, and
  // above all not to the manager: the manager serves its job units (which
  // act with its account-wide API token) on the `JobUnits` entrypoint, so a
  // `service` binding sent as recorded could point an app at them. Installs
  // and updates both plan through `planBindings`, so refusing it here
  // refuses it everywhere. Keep `service` out of the pass-through types: the
  // one service binding an app may have, to its own Worker, is rewritten at
  // upload to the install's Worker name, never sent as recorded.
  it("never passes a service binding through", () => {
    expect(PASSTHROUGH_BINDING_TYPES.has("service")).toBe(false);
  });

  it("passes a Worker Loader through with nothing to create", () => {
    const plan = planBindings("cut", [{ type: "worker_loader", name: "LOADER" }]);
    expect(plan.problems).toEqual([]);
    expect(plan.resources).toEqual([]);
  });

  it("refuses one aimed at the manager's job units", () => {
    const binding = { type: "service", name: "SELF", service: "appflare", entrypoint: "JobUnits" };
    const plan = planBindings("cut", [binding]);
    expect(plan.problems).toEqual([
      expect.stringMatching(
        /^Service binding SELF points at the Worker "appflare"; an app may bind only to its own Worker/,
      ),
    ]);
  });

  it("accepts a binding to the app's own Worker, whatever the install is called", () => {
    for (const workerName of ["mailflare", "mail-2"]) {
      const plan = planBindings(workerName, [
        { type: "service", name: "WORKER_SELF_REFERENCE", service: "self" },
        { type: "service", name: "JOBS", service: "self", entrypoint: "Jobs" },
      ]);
      expect(plan).toEqual({ resources: [], durableObjects: [], workflows: [], problems: [] });
    }
  });

  it("refuses every other target, even in an artifact edited by hand", () => {
    // The packer never records these; an edited artifact or a manifest from a
    // different packer could. The plan refuses them before anything is created.
    for (const binding of [
      { type: "service", name: "API", service: "other-worker" },
      // The install's own name is still not "self": the artifact cannot know it.
      { type: "service", name: "NAMED", service: "cut" },
      { type: "service", name: "NONE" },
      { type: "service", name: "ENV", service: "self", environment: "staging" },
      { type: "service", name: "PROPS", service: "self", props: { admin: true } },
    ]) {
      expect(planBindings("cut", [binding]).problems).toEqual([
        expect.stringMatching(new RegExp(`^Service binding ${binding.name} points at `)),
      ]);
    }
  });
});
