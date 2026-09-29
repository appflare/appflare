import type { WorkerBinding } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import type { RecordedResource } from "../update/plan";
import {
  type ConsumerPlan,
  consumerBody,
  consumerChanged,
  consumerPlansOf,
  consumerSettings,
  consumerTargets,
  diffConsumerQueues,
  planQueueConsumers,
  recordedQueues,
} from "./queue-consumers";

const bindings: WorkerBinding[] = [
  { type: "queue", name: "JOBS" },
  { type: "queue", name: "EXPORT" },
  { type: "kv_namespace", name: "CACHE" },
];

describe("consumerSettings", () => {
  it("renames wrangler's settings for the API and turns seconds into milliseconds", () => {
    expect(
      consumerSettings({
        queue: { binding: "JOBS" },
        max_batch_size: 10,
        max_batch_timeout: 2.5,
        max_retries: 5,
        max_concurrency: null,
        retry_delay: 30,
      }),
    ).toEqual({
      batch_size: 10,
      max_wait_time_ms: 2500,
      max_retries: 5,
      max_concurrency: null,
      retry_delay: 30,
    });
    expect(consumerSettings({ queue: { binding: "JOBS" } })).toEqual({});
  });
});

describe("planQueueConsumers", () => {
  it("plans consumers and creates queues that only consumers name", () => {
    const plan = planQueueConsumers("flaremo", {
      bindings,
      queueConsumers: [
        { queue: { binding: "JOBS" }, max_retries: 3, dead_letter_queue: { name: "jobs-dlq" } },
        { queue: { binding: "EXPORT" }, dead_letter_queue: { name: "jobs-dlq" } },
        { queue: { name: "jobs-dlq" } },
      ],
    });
    expect(plan.problems).toEqual([]);
    expect(plan.queues).toEqual([
      {
        binding: "jobs-dlq",
        type: "queue",
        kind: "queue",
        name: "flaremo-jobs-dlq",
        unbound: true,
      },
    ]);
    expect(plan.consumers).toEqual([
      {
        queueKey: "JOBS",
        deadLetterKey: "jobs-dlq",
        settings: { max_retries: 3 },
        label: "the queue of binding JOBS",
      },
      {
        queueKey: "EXPORT",
        deadLetterKey: "jobs-dlq",
        settings: {},
        label: "the queue of binding EXPORT",
      },
      { queueKey: "jobs-dlq", deadLetterKey: null, settings: {}, label: 'the queue "jobs-dlq"' },
    ]);
  });

  it("has nothing to do for an artifact without consumers", () => {
    expect(planQueueConsumers("cut", { bindings, queueConsumers: [] })).toEqual({
      queues: [],
      consumers: [],
      problems: [],
    });
  });

  it("refuses a queue name that collides with a binding, a missing binding, and long names", () => {
    const plan = planQueueConsumers("app", {
      bindings,
      queueConsumers: [
        { queue: { binding: "NOPE" } },
        { queue: { name: "jobs" } },
        { queue: { name: "CACHE" } },
        { queue: { name: "x".repeat(60) } },
      ],
    });
    expect(plan.problems).toEqual([
      "A queue consumer names the queue binding NOPE, but the Worker has no queue binding by that name.",
      'The queue "jobs" would share its name with a binding\'s resource; Appflare cannot tell the two apart.',
      'The queue "CACHE" would share its name with a binding\'s resource; Appflare cannot tell the two apart.',
      `The queue name "app-${"x".repeat(60)}" is longer than 63 characters; choose a shorter Worker name.`,
    ]);
  });
});

const plan = (over: Partial<ConsumerPlan> = {}): ConsumerPlan => ({
  queueKey: "JOBS",
  deadLetterKey: null,
  settings: { batch_size: 10 },
  label: "the queue of binding JOBS",
  ...over,
});

describe("consumerBody", () => {
  const queues = [
    { binding: "JOBS", type: "queue" as const, name: "app-jobs", cfId: "q-jobs" },
    { binding: "jobs-dlq", type: "queue" as const, name: "app-jobs-dlq", cfId: "q-dlq" },
  ];

  it("names the Worker and the dead-letter queue by name", () => {
    expect(consumerBody("app", plan({ deadLetterKey: "jobs-dlq" }), queues)).toEqual({
      type: "worker",
      script_name: "app",
      dead_letter_queue: "app-jobs-dlq",
      settings: { batch_size: 10 },
    });
    expect(consumerBody("app", plan({ settings: {} }), queues)).toEqual({
      type: "worker",
      script_name: "app",
    });
  });

  it("fails when a queue it needs is not known", () => {
    expect(() => consumerBody("app", plan({ deadLetterKey: "gone" }), queues)).toThrow(/"gone"/);
  });
});

describe("consumerChanged", () => {
  it("compares the dead-letter queue and every setting", () => {
    expect(consumerChanged(undefined, plan())).toBe(true);
    expect(consumerChanged(plan(), plan({ label: "other words" }))).toBe(false);
    expect(consumerChanged(plan(), plan({ settings: { batch_size: 5 } }))).toBe(true);
    expect(consumerChanged(plan(), plan({ deadLetterKey: "dlq" }))).toBe(true);
    expect(consumerChanged(plan(), plan({ settings: { batch_size: 10, retry_delay: 1 } }))).toBe(
      true,
    );
  });
});

describe("consumerPlansOf", () => {
  it("reads the consumers of a stored manifest, and nothing from anything else", () => {
    const json = JSON.stringify({
      worker: { queueConsumers: [{ queue: { binding: "JOBS" }, max_batch_size: 10 }] },
    });
    expect(consumerPlansOf(json)).toEqual([plan()]);
    expect(consumerPlansOf(null)).toEqual([]);
    expect(consumerPlansOf("{")).toEqual([]);
    expect(consumerPlansOf('{"worker":{}}')).toEqual([]);
    expect(consumerPlansOf('{"worker":{"queueConsumers":[{"queue":"x"}]}}')).toEqual([]);
  });
});

const rows: RecordedResource[] = [
  { id: "i1:queue:JOBS", kind: "queue", binding: "JOBS", name: "app-jobs", cfId: "q-jobs" },
  { id: "i1:queue:jobs-dlq", kind: "queue", binding: null, name: "app-jobs-dlq", cfId: "q-dlq" },
  { id: "i1:queue:OLD", kind: "queue", binding: "OLD", name: "app-old", cfId: null },
  {
    id: "i1:queue_consumer:JOBS",
    kind: "queue_consumer",
    binding: null,
    name: "app-jobs",
    cfId: "c1",
  },
  {
    id: "i1:queue_consumer:gone",
    kind: "queue_consumer",
    binding: null,
    name: "app-gone",
    cfId: null,
  },
  { id: "i1:kv:CACHE", kind: "kv", binding: "CACHE", name: "app-cache", cfId: "kv1" },
];

describe("recorded queues and consumers", () => {
  it("lists the queues with ids, keyed as plans key them", () => {
    expect(recordedQueues("i1", rows)).toEqual([
      { binding: "JOBS", type: "queue", name: "app-jobs", cfId: "q-jobs" },
      { binding: "jobs-dlq", type: "queue", name: "app-jobs-dlq", cfId: "q-dlq" },
    ]);
  });

  it("finds each consumer's queue by the key both rows share", () => {
    expect(consumerTargets("i1", rows)).toEqual([
      { id: "i1:queue_consumer:JOBS", queueName: "app-jobs", queueId: "q-jobs", consumerId: "c1" },
      { id: "i1:queue_consumer:gone", queueName: "app-gone", queueId: null, consumerId: null },
    ]);
  });

  it("matches consumer-only queues by name among queues with no binding", () => {
    const planned = planQueueConsumers("app", {
      bindings,
      queueConsumers: [
        { queue: { binding: "JOBS" }, dead_letter_queue: { name: "jobs-dlq" } },
        { queue: { binding: "EXPORT" }, dead_letter_queue: { name: "export-dlq" } },
      ],
    });
    expect(diffConsumerQueues(planned.queues, rows)).toEqual({
      existing: [{ binding: "jobs-dlq", type: "queue", name: "app-jobs-dlq", cfId: "q-dlq" }],
      toCreate: [
        {
          binding: "export-dlq",
          type: "queue",
          kind: "queue",
          name: "app-export-dlq",
          unbound: true,
        },
      ],
      problems: [],
    });
  });
});
