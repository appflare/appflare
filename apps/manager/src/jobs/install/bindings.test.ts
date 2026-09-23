import { describe, expect, it } from "vitest";
import { planBindings, resourceName } from "./bindings";

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

  it("needs Vectorize dimensions and metric from the recorded binding", () => {
    expect(planBindings("a", [{ type: "vectorize", name: "IDX" }]).problems[0]).toMatch(
      /does not record the index's dimensions and metric \(@appflare\/pack does not capture them yet\)/,
    );
    const ok = planBindings("a", [
      { type: "vectorize", name: "IDX", dimensions: 768, metric: "cosine" },
    ]);
    expect(ok.problems).toEqual([]);
    expect(ok.resources[0]?.vectorize).toEqual({ dimensions: 768, metric: "cosine" });
  });

  it("refuses binding types it cannot install and names that are too long", () => {
    const plan = planBindings("a".repeat(54), [
      { type: "hyperdrive", name: "PG" },
      { type: "r2_bucket", name: "FILES_AND_MORE" },
      { type: "durable_object_namespace", name: "X", class_name: "X", script_name: "other" },
    ]);
    expect(plan.problems).toHaveLength(3);
    expect(plan.problems[0]).toMatch(/"hyperdrive"/);
    expect(plan.problems[1]).toMatch(/longer than 63/);
    expect(plan.problems[2]).toMatch(/another Worker/);
  });
});
