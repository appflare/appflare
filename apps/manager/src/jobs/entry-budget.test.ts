import {
  FREE_PLAN_WORKFLOW_STEPS,
  MAX_ENTRY_WORKERS,
  PAID_PLAN_SUBREQUESTS,
  PAID_PLAN_WORKFLOW_STEPS,
} from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { buildArtifactFixture } from "../test/artifact-fixture";
import {
  accountWorkersProblem,
  entryBudgetLine,
  entryBudgetProblem,
  entryJobCost,
  JOB_RESERVE,
  otherWorkerCost,
  PRIMARY_SUBREQUESTS,
} from "./entry-budget";
import { entryWorkers } from "./entry-workers";
import { SPEND_BEFORE_STEP } from "./invocation-budget";
import { CANARY_MAX_ATTEMPTS } from "./update";

/** An app of `count` Workers, each other one with `files` asset files, a cron and a queue consumer. */
async function appOf(count: number, files = 0) {
  const fixture = await buildArtifactFixture({
    otherWorkers: Array.from({ length: count - 1 }, (_, i) => ({
      name: `w-${i + 1}`,
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
      crons: ["*/5 * * * *"],
      queueConsumers: [{ queue: { name: `jobs-${i + 1}` } }],
      assets: Array.from({ length: files }, (_, f) => ({
        route: `/f-${f}.js`,
        content: `// ${i}-${f}`,
      })),
    })),
    catalog: {
      secrets: [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
        { name: "API_KEY", label: "API key", generate: "password" },
      ],
    },
  });
  return entryWorkers(fixture.manifest, "cut");
}

describe("entry job budget", () => {
  it("counts each other Worker's steps: install and update", async () => {
    const workers = await appOf(2, 1);
    const primary = workers.find((w) => w.primary);
    const other = workers.find((w) => !w.primary);
    if (primary === undefined || other === undefined) throw new Error("no Workers");
    // Assets (session + one part), record name, upload, record script, route,
    // two secrets, the read of the version they left serving, the cron
    // triggers and one consumer.
    expect(otherWorkerCost(other, "install", 0).steps).toBe(2 + 3 + 1 + 2 + 1 + 1 + 1);
    // The update's canary adds a probe and a sleep per attempt.
    const update = otherWorkerCost(other, "update", CANARY_MAX_ATTEMPTS);
    expect(update.steps).toBe(otherWorkerCost(other, "update", 0).steps + 2 * CANARY_MAX_ATTEMPTS);
    // Only the other Workers add to the reserve.
    expect(entryJobCost([primary], "update", CANARY_MAX_ATTEMPTS)).toEqual(JOB_RESERVE);
  });

  it("counts the Workflows a Worker defines, and nothing for one it runs from another", async () => {
    const workflow = {
      type: "workflow",
      name: "SITE_AUDIT",
      workflow_name: "site-audit",
      class_name: "SiteAudit",
    };
    const fixture = await buildArtifactFixture({
      bindings: [{ ...workflow, script_name: "{{workerName:audit}}" }],
      otherWorkers: [{ name: "audit", bindings: [workflow] }],
    });
    const plain = await buildArtifactFixture({ otherWorkers: [{ name: "audit" }] });
    const other = (manifest: typeof fixture.manifest) => {
      const w = entryWorkers(manifest, "cut").find((e) => !e.primary);
      if (w === undefined) throw new Error("no other Worker");
      return w;
    };
    const install = otherWorkerCost(other(fixture.manifest), "install", 0);
    const without = otherWorkerCost(other(plain.manifest), "install", 0);
    // The name check and the call that creates the Workflow: a step each,
    // with its call (D1 writes are no subrequests).
    expect(install.steps - without.steps).toBe(2);
    expect(install.subrequests - without.subrequests).toBe(2);
    const update = otherWorkerCost(other(fixture.manifest), "update", 0);
    const plainUpdate = otherWorkerCost(other(plain.manifest), "update", 0);
    expect(update.steps - plainUpdate.steps).toBe(2);
    expect(update.subrequests - plainUpdate.subrequests).toBe(2);
  });

  it(`fits ${MAX_ENTRY_WORKERS} Workers in one job on Workers Paid, with assets, crons and consumers`, async () => {
    const workers = await appOf(MAX_ENTRY_WORKERS, 40);
    for (const kind of ["install", "update"] as const) {
      const cost = entryJobCost(workers, kind, CANARY_MAX_ATTEMPTS);
      expect(cost.steps).toBeLessThan(PAID_PLAN_WORKFLOW_STEPS / 4);
      expect(cost.subrequests).toBeLessThan(PAID_PLAN_SUBREQUESTS / 2);
      expect(entryBudgetProblem(cost, true, workers.length)).toBeNull();
    }
  });

  it(`fits ${MAX_ENTRY_WORKERS} Workers in one job on Workers Free, spread over invocations`, async () => {
    const workers = await appOf(MAX_ENTRY_WORKERS, 1);
    for (const kind of ["install", "update"] as const) {
      const cost = entryJobCost(workers, kind, CANARY_MAX_ATTEMPTS, true);
      expect(cost.steps).toBeLessThan(FREE_PLAN_WORKFLOW_STEPS);
      expect(entryBudgetProblem(cost, false, workers.length)).toBeNull();
    }
  });

  it("counts the waits for fresh invocations on Workers Free as steps", async () => {
    const workers = await appOf(18, 1);
    const paid = entryJobCost(workers, "update", CANARY_MAX_ATTEMPTS);
    const free = entryJobCost(workers, "update", CANARY_MAX_ATTEMPTS, true);
    expect(paid.waits).toBe(0);
    // A typical primary Worker's part, then the others' requests: a fresh
    // invocation every SPEND_BEFORE_STEP.
    const others = free.subrequests - JOB_RESERVE.subrequests;
    expect(free.waits).toBe(Math.ceil((PRIMARY_SUBREQUESTS + others) / SPEND_BEFORE_STEP) - 1);
    expect(free.waits).toBeGreaterThan(0);
    expect(free.steps).toBe(paid.steps + 2 * free.waits);
    // An app whose requests fit one invocation waits for none.
    const two = await appOf(2);
    expect(entryJobCost(two, "install", 0, true).waits).toBe(0);
  });

  it("refuses a job over the plan's steps, or over Workers Paid's subrequests", () => {
    const cost = (steps: number, subrequests: number) => ({
      steps,
      subrequests,
      unitCalls: 0,
      waits: 0,
    });
    expect(entryBudgetProblem(cost(1_025, 0), false, 3)).toBe(
      "This app has 3 Workers, and one job for them would run an estimated 1025 Workflow steps; Workers Free allows 1,024 per job.",
    );
    expect(entryBudgetProblem(cost(1_025, 0), true, 3)).toBeNull();
    expect(entryBudgetProblem(cost(10, 10_001), true, 30)).toBe(
      "This app has 30 Workers, and one job for them would make an estimated 10001 subrequests; Workers Paid allows 10,000 per job.",
    );
    // Workers Free spreads the subrequests over invocations instead.
    expect(entryBudgetProblem(cost(10, 10_001), false, 3)).toBeNull();
  });

  it("describes the estimate in the job log", () => {
    expect(
      entryBudgetLine({ steps: 700, subrequests: 2_000, unitCalls: 75, waits: 0 }, true, 18),
    ).toBe(
      "The app's 18 Workers: an estimated 700 Workflow steps of the 10,000 a job may run, 2000 subrequests of the 10,000 Workers Paid allows a job, and 75 unit calls.",
    );
    expect(
      entryBudgetLine({ steps: 500, subrequests: 40, unitCalls: 44, waits: 0 }, false, 2),
    ).toBe(
      "The app's 2 Workers: an estimated 500 Workflow steps of the 1,024 a job may run, and 44 unit calls.",
    );
    expect(
      entryBudgetLine({ steps: 600, subrequests: 300, unitCalls: 60, waits: 7 }, false, 18),
    ).toBe(
      "The app's 18 Workers: an estimated 600 Workflow steps of the 1,024 a job may run, about 7 waits of 5 minutes for a fresh allowance of the 50 requests Workers Free gives a job at a time, and 60 unit calls.",
    );
  });

  it("counts each other Worker's unit calls: its asset parts and its upload", async () => {
    const workers = await appOf(3, 1);
    const cost = entryJobCost(workers, "install", 0);
    expect(cost.unitCalls).toBe(JOB_RESERVE.unitCalls + 2 * (1 + 1));
  });
});

describe("account Workers", () => {
  it("allows up to 100 Workers per account on Workers Free and 500 otherwise", () => {
    expect(accountWorkersProblem(98, 2, "free")).toBeNull();
    expect(accountWorkersProblem(99, 2, "free")).toBe(
      "This app installs 2 Workers, and the account already has 99; Workers Free allows 100 Workers per account. Delete Workers you no longer use, or move the account to Workers Paid (500 Workers), then install again.",
    );
    // An account of unknown plan with 100 Workers or more is on Workers Paid.
    expect(accountWorkersProblem(150, 2, "paid")).toBeNull();
    expect(accountWorkersProblem(482, 18, "paid")).toBeNull();
    expect(accountWorkersProblem(483, 18, "paid")).toBe(
      "This app installs 18 Workers, and the account already has 483; Workers Paid allows 500 Workers per account. Delete Workers you no longer use, then install again.",
    );
  });
});
