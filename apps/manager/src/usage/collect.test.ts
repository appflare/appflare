import { createClient, type UsageRow } from "@appflare/cf-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DAY_PRODUCTS } from "./account-day";
import {
  ACCOUNT_DAY_DATASETS,
  ACCOUNT_DAY_READ,
  accountDayFrom,
  type CollectedHour,
  type CollectTarget,
  collectUsage,
  HOUR,
  productOf,
} from "./collect";
import { changedHours, sameValue, storedIndex } from "./collect.server";
import {
  type AnswerRow,
  answerRow,
  fakeGraphQL,
  RECORDED,
  RECORDED_IDS,
  RECORDED_NOW,
} from "./collect-fixtures";

const HOUR_NOW = Math.floor(RECORDED_NOW / HOUR) * HOUR; // 16:00 UTC

// cf-api's usage reads start no earlier than each dataset's retention back
// from `Date.now` (31 or 32 days for some), so the answers recorded on
// 2026-10-12 are read as of then, not dropped as too old once that has passed.
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(RECORDED_NOW * 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function target(over: Partial<CollectTarget> & { installId: string }): CollectTarget {
  return {
    workers: [],
    durableObjects: [],
    d1: [],
    kv: [],
    r2: [],
    queues: [],
    workflows: [],
    vectorize: [],
    analyticsEngine: [],
    containers: [],
    ai: false,
    browser: false,
    from: HOUR_NOW - 2 * HOUR,
    ...over,
  };
}

function reader(
  answers: Readonly<Record<string, readonly AnswerRow[]>>,
  refuse?: Parameters<typeof fakeGraphQL>[2],
) {
  const graphql = fakeGraphQL(answers, undefined, refuse);
  const api = createClient({ accountId: "acc", token: "t", fetch: graphql.fetch });
  return { usage: api.usage, sent: graphql.sent, requests: graphql.requests };
}

const of = (hours: CollectedHour[], product: string) =>
  hours
    .filter((h) => h.product === product)
    .map((h) => [h.installId, h.hour - HOUR_NOW, Math.round(h.value * 1e12) / 1e12]);

const row = (over: Partial<UsageRow>): UsageRow => ({
  dataset: "workersInvocationsAdaptive",
  metric: "requests",
  resourceId: "x",
  hour: 0,
  value: 1,
  ...over,
});

describe("productOf", () => {
  it("maps metrics to products in the math's units", () => {
    expect(productOf(row({ metric: "cpuTimeUs", value: 2500 }))).toEqual(["workers_cpu_ms", 2.5]);
    expect(
      productOf(row({ dataset: "d1StorageAdaptiveGroups", metric: "storedBytes", value: 2e9 })),
    ).toEqual(["d1_storage", 2]);
    expect(
      productOf(row({ dataset: "r2OperationsAdaptiveGroups", metric: "PutObject", value: 3 })),
    ).toEqual(["r2_class_a", 3]);
    expect(
      productOf(row({ dataset: "r2OperationsAdaptiveGroups", metric: "GetObject", value: 3 })),
    ).toEqual(["r2_class_b", 3]);
    expect(
      productOf(row({ dataset: "r2OperationsAdaptiveGroups", metric: "DeleteObject" })),
    ).toBeNull();
    expect(
      productOf(
        row({
          dataset: "containersUsageAdaptiveGroups",
          metric: "allocatedMemoryByteSeconds",
          value: 2 ** 31,
        }),
      ),
    ).toEqual(["containers_memory", 2]);
    expect(
      productOf(
        row({
          dataset: "browserRenderingBrowserTimeUsageAdaptiveGroups",
          metric: "sessionDurationMs",
          value: 1_800_000,
        }),
      ),
    ).toEqual(["browser_hours", 0.5]);
    expect(productOf(row({ metric: "errors" }))).toBeNull();
  });
});

describe("collectUsage (recorded answers)", () => {
  const app = target({
    installId: "notes",
    workers: [RECORDED_IDS.worker],
    d1: [RECORDED_IDS.d1],
    kv: [RECORDED_IDS.kv],
    durableObjects: [RECORDED_IDS.durableObject],
  });

  it("reads each dataset once and maps the hours from the app's first hour on", async () => {
    const { usage, sent } = reader(RECORDED);
    const collected = await collectUsage(usage, [app], RECORDED_NOW);

    expect(sent.map((s) => s.dataset).sort()).toEqual(
      [
        "alarms",
        "d1AnalyticsAdaptiveGroups",
        "d1StorageAdaptiveGroups",
        "durableObjectsInvocationsAdaptiveGroups",
        "durableObjectsPeriodicGroups",
        "durableObjectsSqlStorageGroups",
        "kvOperationsAdaptiveGroups",
        "kvStorageAdaptiveGroups",
        "workersInvocationsAdaptive",
      ].sort(),
    );
    // Every request carries now as a unique bound (Cloudflare caches answers otherwise).
    expect(sent.every((s) => typeof s.filter.datetime_leq === "string")).toBe(true);

    expect(of(collected.hours, "workers_requests")).toEqual([
      ["notes", -2 * HOUR, 2],
      ["notes", -HOUR, 2],
      ["notes", 0, 1],
    ]);
    expect(of(collected.hours, "workers_cpu_ms")).toEqual([
      ["notes", -2 * HOUR, 262.806],
      ["notes", -HOUR, 262.411],
      ["notes", 0, 136.516],
    ]);
    expect(of(collected.hours, "d1_rows_read")).toContainEqual(["notes", 0, 138]);
    expect(of(collected.hours, "d1_storage")).toEqual([
      ["notes", -2 * HOUR, 0.000679936],
      ["notes", -HOUR, 0.000679936],
      ["notes", 0, 0.000679936],
    ]);
    // Storage has a point for every hour held.
    expect(of(collected.hours, "do_storage")).toHaveLength(3);
    expect(of(collected.hours, "kv_storage")).toHaveLength(3);
    // No hour before the app's first hour.
    expect(collected.hours.every((h) => h.hour >= app.from)).toBe(true);
    expect(collected.alarms.size).toBe(0);
  });

  it("reads every app's ids in the same request", async () => {
    const { usage, sent } = reader(RECORDED);
    const other = target({ installId: "other", workers: ["other"], d1: ["other-db"] });
    await collectUsage(usage, [app, other], RECORDED_NOW);
    const workers = sent.filter((s) => s.dataset === "workersInvocationsAdaptive");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.filter.scriptName_in).toEqual(["notes", "other"]);
    expect(sent.filter((s) => s.dataset === "d1AnalyticsAdaptiveGroups")).toHaveLength(1);
  });

  it("reads nothing for an app without resources of a kind", async () => {
    const { usage, sent } = reader(RECORDED);
    await collectUsage(usage, [target({ installId: "w", workers: ["notes"] })], RECORDED_NOW);
    expect(sent.map((s) => s.dataset)).toEqual(["workersInvocationsAdaptive"]);
  });
});

describe("collectUsage (shaped answers)", () => {
  it("splits the account's Workers AI evenly across the apps that bind it", async () => {
    const { usage } = reader({
      aiInferenceAdaptiveGroups: [
        answerRow("modelId", "@cf/meta/llama", HOUR_NOW, { count: 4, sum: { totalNeurons: 100 } }),
      ],
    });
    const collected = await collectUsage(
      usage,
      [
        target({ installId: "a", ai: true }),
        target({ installId: "b", ai: true }),
        target({ installId: "c" }),
      ],
      RECORDED_NOW,
    );
    expect(of(collected.hours, "ai_neurons")).toEqual([
      ["a", 0, 50],
      ["b", 0, 50],
    ]);
  });

  it("attributes Analytics Engine by dataset and R2 by bucket", async () => {
    const { usage } = reader({
      workersAnalyticsEngineAdaptiveGroups: [
        answerRow("dataset", "events", HOUR_NOW, { count: 1200 }),
      ],
      r2OperationsAdaptiveGroups: [
        answerRow(
          "bucketName",
          "media",
          HOUR_NOW,
          { sum: { requests: 7 } },
          { actionType: "PutObject" },
        ),
        answerRow(
          "bucketName",
          "media",
          HOUR_NOW,
          { sum: { requests: 9 } },
          { actionType: "GetObject" },
        ),
      ],
    });
    const collected = await collectUsage(
      usage,
      [
        target({ installId: "a", analyticsEngine: ["events"] }),
        target({ installId: "b", r2: ["media"] }),
      ],
      RECORDED_NOW,
    );
    expect(of(collected.hours, "analytics_engine_data_points")).toEqual([["a", 0, 1200]]);
    expect(of(collected.hours, "r2_class_a")).toEqual([["b", 0, 7]]);
    expect(of(collected.hours, "r2_class_b")).toEqual([["b", 0, 9]]);
  });

  it("counts a Workflow's steps, not its CPU time or starts (billed as its Worker's)", async () => {
    const { usage, sent } = reader({
      workflowsAdaptiveGroups: [
        answerRow(
          "workflowName",
          "sync-flow",
          HOUR_NOW,
          { count: 3, sum: { stepCount: 120, cpuTime: 900 } },
          { eventType: "WORKFLOW_START" },
        ),
        answerRow(
          "workflowName",
          "sync-flow",
          HOUR_NOW,
          { count: 9, sum: { stepCount: 30, cpuTime: 100 } },
          { eventType: "STEP_SUCCESS" },
        ),
      ],
    });
    const collected = await collectUsage(
      usage,
      [target({ installId: "a", workflows: ["sync-flow"] })],
      RECORDED_NOW,
    );
    expect(sent.map((s) => s.dataset)).toEqual(["workflowsAdaptiveGroups"]);
    expect(collected.hours).toEqual([
      { installId: "a", product: "workflow_steps", hour: HOUR_NOW, value: 150 },
    ]);
  });

  it("carries a storage sample into later hours, and the stored level when there is none", async () => {
    const { usage } = reader({
      // Only one sample, an hour before the app's first hour (within the look-back).
      d1StorageAdaptiveGroups: [
        answerRow("databaseId", "db", HOUR_NOW - 3 * HOUR, { max: { databaseSizeBytes: 5e9 } }),
      ],
    });
    const collected = await collectUsage(
      usage,
      [
        target({ installId: "a", d1: ["db"] }),
        target({ installId: "b", kv: ["kv-b"], levelsBefore: { kv_storage: 0.25 } }),
      ],
      RECORDED_NOW,
    );
    expect(of(collected.hours, "d1_storage")).toEqual([
      ["a", -2 * HOUR, 5],
      ["a", -HOUR, 5],
      ["a", 0, 5],
    ]);
    expect(of(collected.hours, "kv_storage")).toEqual([
      ["b", -2 * HOUR, 0.25],
      ["b", -HOUR, 0.25],
      ["b", 0, 0.25],
    ]);
  });

  it("estimates each namespace's busiest object over the last 60 minutes", async () => {
    const into = RECORDED_NOW - HOUR_NOW; // seconds into the current hour
    const { usage, sent } = reader({
      alarms: [
        answerRow(
          "namespaceId",
          "ns1",
          HOUR_NOW - HOUR,
          { sum: { requests: 6000 } },
          { objectId: "o1" },
        ),
        answerRow("namespaceId", "ns1", HOUR_NOW, { sum: { requests: 2000 } }, { objectId: "o1" }),
      ],
    });
    const collected = await collectUsage(
      usage,
      [target({ installId: "a", durableObjects: ["ns1"] })],
      RECORDED_NOW,
    );
    expect(sent.find((s) => s.dataset === "alarms")?.filter.type).toBe("alarm");
    expect(collected.alarms.get("a")).toEqual([
      { object: "ns1", alarms: Math.round(2000 + 6000 * (1 - into / HOUR)) },
    ]);
  });
});

describe("collectUsage (a read that fails)", () => {
  const app = target({
    installId: "notes",
    workers: [RECORDED_IDS.worker],
    d1: [RECORDED_IDS.d1],
    kv: [RECORDED_IDS.kv],
    levelsBefore: { d1_storage: 0.5 },
  });

  it("leaves out only the products of the read that failed, for the apps it covers", async () => {
    const other = target({ installId: "other", workers: ["other"] });
    const { usage } = reader(RECORDED, {
      message: "timeout",
      datasets: ["d1StorageAdaptiveGroups"],
    });
    const collected = await collectUsage(usage, [app, other], RECORDED_NOW);
    expect(collected.failures.map((f) => [f.source, f.installIds])).toEqual([["d1", ["notes"]]]);
    expect(collected.incomplete).toEqual(new Set(["notes"]));
    expect(collected.succeeded).toBe(2);
    const products = new Set(collected.hours.map((h) => h.product));
    expect(products.has("workers_requests")).toBe(true);
    expect(products.has("kv_storage")).toBe(true);
    // Neither the read's counts nor its storage, not even the level carried from before.
    expect(products.has("d1_rows_read")).toBe(false);
    expect(products.has("d1_storage")).toBe(false);
  });

  it("asks for every dataset in one request, and on a refused one asks for it on its own", async () => {
    const calm = reader(RECORDED);
    await collectUsage(calm.usage, [app], RECORDED_NOW);
    expect(calm.requests.count).toBe(1);
    // Cloudflare answers a combined query with a refused field with no data at
    // all: the refused field is asked for on its own and the others together
    // again, so only the refused one fails.
    const refused = reader(RECORDED, { message: "timeout", datasets: ["d1StorageAdaptiveGroups"] });
    const collected = await collectUsage(refused.usage, [app], RECORDED_NOW);
    expect(refused.requests.count).toBe(3);
    expect(collected.failures.map((f) => f.source)).toEqual(["d1"]);
  });

  it("leaves out the products of a source the check could not prepare", async () => {
    const { usage } = reader(RECORDED);
    const collected = await collectUsage(usage, [{ ...app, unread: ["d1"] }], RECORDED_NOW);
    expect(collected.incomplete).toEqual(new Set(["notes"]));
    expect(collected.failures).toEqual([]);
    expect(collected.hours.some((h) => h.product.startsWith("d1_"))).toBe(false);
  });
});

describe("changedHours", () => {
  const stored = storedIndex([
    { installId: "a", product: "workers_requests", t: 0, value: 10 },
    { installId: "a", product: "workers_requests", t: HOUR, value: 4 },
    { installId: "a", product: "d1_storage", t: 0, value: 0.1 },
  ]);

  it("writes only hours whose value changed, never a new zero", () => {
    expect(
      changedHours(
        [
          { installId: "a", product: "workers_requests", hour: 0, value: 10 },
          { installId: "a", product: "workers_requests", hour: HOUR, value: 6 },
          { installId: "a", product: "workers_requests", hour: 2 * HOUR, value: 1 },
          { installId: "a", product: "d1_storage", hour: 0, value: 0.1 + 1e-15 },
          { installId: "a", product: "kv_storage", hour: 0, value: 0 },
        ],
        stored,
      ),
    ).toEqual([
      { installId: "a", product: "workers_requests", hour: HOUR, value: 6 },
      { installId: "a", product: "workers_requests", hour: 2 * HOUR, value: 1 },
    ]);
  });

  it("compares readings that went through floating point", () => {
    expect(sameValue(0.1 + 0.2, 0.3)).toBe(true);
    expect(sameValue(1, 1.001)).toBe(false);
  });
});

describe("accountDayFrom", () => {
  it("knows the dataset of every product a reading holds", () => {
    expect(Object.keys(ACCOUNT_DAY_DATASETS).sort()).toEqual([...ACCOUNT_DAY_PRODUCTS].sort());
  });

  it("asks only for the datasets of products with a Free daily limit, Workers AI aside", () => {
    // Workers AI is already read for the whole account and shared by the apps that bind it.
    expect(ACCOUNT_DAY_PRODUCTS).not.toContain("ai_neurons");
    expect([...ACCOUNT_DAY_READ].sort()).toEqual([
      "browserRenderingBrowserTimeUsageAdaptiveGroups",
      "d1AnalyticsAdaptiveGroups",
      "durableObjectsInvocationsAdaptiveGroups",
      "durableObjectsPeriodicGroups",
      "kvOperationsAdaptiveGroups",
      "queueMessageOperationsAdaptiveGroups",
      "workersAnalyticsEngineAdaptiveGroups",
      "workersInvocationsAdaptive",
      "workflowsAdaptiveGroups",
    ]);
  });

  it("turns the account's totals into products, 0 for one read and not used", () => {
    const day = accountDayFrom(
      {
        totals: [
          { dataset: "workersInvocationsAdaptive", metric: "requests", value: 5731 },
          { dataset: "d1AnalyticsAdaptiveGroups", metric: "rowsWritten", value: 90152 },
          { dataset: "kvOperationsAdaptiveGroups", metric: "writes", value: 430 },
          { dataset: "durableObjectsPeriodicGroups", metric: "durationGbs", value: 12.5 },
          {
            dataset: "browserRenderingBrowserTimeUsageAdaptiveGroups",
            metric: "sessionDurationMs",
            value: 1_800_000,
          },
        ],
        failed: [],
      },
      RECORDED_NOW * 1000,
    );
    expect(day.at).toBe(RECORDED_NOW * 1000);
    expect(day.used).toMatchObject({
      workers_requests: 5731,
      d1_rows_written: 90152,
      kv_writes: 430,
      do_duration: 12.5,
      browser_hours: 0.5,
      d1_rows_read: 0,
      queues_operations: 0,
    });
    expect(Object.keys(day.used).sort()).toEqual([...ACCOUNT_DAY_PRODUCTS].sort());
  });

  it("leaves out the products of a dataset that could not be read", () => {
    const day = accountDayFrom(
      { totals: [], failed: [{ dataset: "kvOperationsAdaptiveGroups", error: new Error("x") }] },
      0,
    );
    expect(day.used.kv_writes).toBeUndefined();
    expect(day.used.kv_reads).toBeUndefined();
    expect(day.used.workers_requests).toBe(0);
  });
});

describe("collectUsage: the account's totals", () => {
  it("reads them in the same request as the apps' datasets, when asked", async () => {
    const graphql = fakeGraphQL(RECORDED);
    const client = createClient({ accountId: "acc", token: "t", fetch: graphql.fetch });
    const targets = [target({ installId: "notes", workers: [RECORDED_IDS.worker] })];
    const without = await collectUsage(client.usage, targets, RECORDED_NOW);
    expect(without.accountTotals).toBeNull();
    const before = graphql.requests.count;
    const withTotals = await collectUsage(client.usage, targets, RECORDED_NOW, {
      accountTotals: true,
    });
    expect(graphql.requests.count - before).toBe(1);
    expect(withTotals.accountTotals?.failed).toEqual([]);
    expect(withTotals.queries).toBe(1 + ACCOUNT_DAY_READ.length);
    // The account's totals are no app's: the app's hours are the same either way.
    expect(withTotals.hours).toEqual(without.hours);
  });
});
