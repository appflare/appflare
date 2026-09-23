import type {
  CloudflareClient,
  QueueConsumerInfo,
  QueueConsumerSettings,
  WorkerQueueConsumerBody,
} from "@appflare/cf-api";
import {
  type ArtifactWorker,
  describeQueueRef,
  type QueueConsumer,
  type QueueRef,
  queueConsumerProblems,
  queueConsumerSchema,
} from "@appflare/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { resources } from "../../db/schema";
import { QUEUE_CONSUMER_KIND } from "../../installs/resource-kinds";
import { isNotFound, JobError, type JobSteps, type StepTools } from "../steps";
import type { RecordedResource } from "../update/plan";
import { type ResourceBindingPlan, resourceName } from "./bindings";
import type { CreatedResource } from "./metadata";
import { resourceId } from "./phases";

/**
 * Queue consumers: the app's Worker receives a queue's messages in its
 * `queue()` handler once Cloudflare has a consumer that points the queue at
 * the Worker. A consumer belongs to the script, like a cron trigger, so the
 * install attaches it after the script upload, an update changes it after
 * the new version serves, and an uninstall removes it before the Worker and
 * before any queue it reads (a consumer holds no data, so it is never kept).
 *
 * The artifact names each queue by the producer binding that sends to it, or,
 * for a queue no binding sends to (typically a dead-letter queue), by its
 * upstream name. The install creates a queue of its own for the latter too,
 * `<workerName>-<name>`, recorded with no binding.
 *
 * Every consumer is recorded as a `queue_consumer` resource keyed by its
 * queue's key (the key of the queue resource it reads), named after that
 * queue, with the consumer's id as its Cloudflare id.
 */

/** R2 bucket and queue names allow at most 63 characters. */
const MAX_QUEUE_NAME_LENGTH = 63;

/** The key of a queue's resource: its producer binding, or its upstream name. */
export function queueKey(ref: QueueRef): string {
  return "binding" in ref ? ref.binding : ref.name;
}

/** One consumer the Worker should have. */
export interface ConsumerPlan {
  /** Key of the queue resource the consumer reads. */
  queueKey: string;
  /** Key of the dead-letter queue's resource, or null for none. */
  deadLetterKey: string | null;
  /** Settings in the API's names and units. */
  settings: QueueConsumerSettings;
  /** How logs name the queue ("the queue of binding JOBS"). */
  label: string;
}

/** Wrangler's consumer settings in the API's names and units (seconds become ms). */
export function consumerSettings(consumer: QueueConsumer): QueueConsumerSettings {
  const settings: QueueConsumerSettings = {};
  if (consumer.max_batch_size !== undefined) settings.batch_size = consumer.max_batch_size;
  if (consumer.max_retries !== undefined) settings.max_retries = consumer.max_retries;
  if (consumer.max_batch_timeout !== undefined) {
    settings.max_wait_time_ms = Math.round(consumer.max_batch_timeout * 1000);
  }
  if (consumer.max_concurrency !== undefined) settings.max_concurrency = consumer.max_concurrency;
  if (consumer.retry_delay !== undefined) settings.retry_delay = consumer.retry_delay;
  return settings;
}

/** The consumers an artifact records, as plans. */
export function consumerPlans(consumers: readonly QueueConsumer[] | undefined): ConsumerPlan[] {
  return (consumers ?? []).map((c) => ({
    queueKey: queueKey(c.queue),
    deadLetterKey: c.dead_letter_queue === undefined ? null : queueKey(c.dead_letter_queue),
    settings: consumerSettings(c),
    label: describeQueueRef(c.queue),
  }));
}

export interface QueueConsumerPlan {
  /** Queues no binding sends to that the consumers need, to create like binding resources. */
  queues: ResourceBindingPlan[];
  consumers: ConsumerPlan[];
  /** Why the consumers cannot be set up; empty when they can. */
  problems: string[];
}

/**
 * Plans the Worker's consumers and the queues only they name. A queue named
 * by its upstream name must not share its name with a binding of the Worker
 * or with the queue a binding creates, since the two would be one resource.
 */
export function planQueueConsumers(
  workerName: string,
  worker: Pick<ArtifactWorker, "bindings" | "queueConsumers">,
): QueueConsumerPlan {
  const problems = queueConsumerProblems(worker);
  const bindingNames = new Set(worker.bindings.map((b) => b.name));
  const boundQueueNames = new Set(
    worker.bindings.filter((b) => b.type === "queue").map((b) => resourceName(workerName, b.name)),
  );
  const queues: ResourceBindingPlan[] = [];
  const planned = new Set<string>();
  for (const consumer of worker.queueConsumers ?? []) {
    for (const ref of [consumer.queue, consumer.dead_letter_queue]) {
      if (ref === undefined || "binding" in ref || planned.has(ref.name)) continue;
      planned.add(ref.name);
      const name = resourceName(workerName, ref.name);
      if (bindingNames.has(ref.name) || boundQueueNames.has(name)) {
        problems.push(
          `The queue "${ref.name}" would share its name with a binding's resource; Appflare cannot tell the two apart.`,
        );
        continue;
      }
      if (name.length > MAX_QUEUE_NAME_LENGTH) {
        problems.push(
          `The queue name "${name}" is longer than ${MAX_QUEUE_NAME_LENGTH} characters; choose a shorter Worker name.`,
        );
      }
      queues.push({ binding: ref.name, type: "queue", kind: "queue", name, unbound: true });
    }
  }
  return { queues, consumers: consumerPlans(worker.queueConsumers), problems };
}

/**
 * Splits the queues only consumers name into those an earlier install or
 * update recorded (matched by name among the install's queues with no
 * binding) and those to create now.
 */
export function diffConsumerQueues(
  queues: readonly ResourceBindingPlan[],
  recorded: readonly RecordedResource[],
): { existing: CreatedResource[]; toCreate: ResourceBindingPlan[]; problems: string[] } {
  const existing: CreatedResource[] = [];
  const toCreate: ResourceBindingPlan[] = [];
  const problems: string[] = [];
  for (const queue of queues) {
    const row = recorded.find(
      (r) => r.kind === "queue" && r.binding === null && r.name === queue.name,
    );
    if (row === undefined) toCreate.push(queue);
    else if (row.cfId === null) {
      problems.push(
        `The queue "${row.name}" is recorded without a Cloudflare id, so its consumer cannot be set up.`,
      );
    } else existing.push({ binding: queue.binding, type: "queue", name: row.name, cfId: row.cfId });
  }
  return { existing, toCreate, problems };
}

/**
 * The install's recorded queues as a job's resources, keyed like a plan keys
 * them (the key is the part of the row id after `<install>:queue:`). Queues
 * recorded without a Cloudflare id cannot be addressed and are left out.
 */
export function recordedQueues(
  installId: string,
  rows: readonly RecordedResource[],
): CreatedResource[] {
  const prefix = resourceId(installId, "queue", "");
  const out: CreatedResource[] = [];
  for (const row of rows) {
    if (row.kind !== "queue" || row.cfId === null || !row.id.startsWith(prefix)) continue;
    out.push({
      binding: row.id.slice(prefix.length),
      type: "queue",
      name: row.name,
      cfId: row.cfId,
    });
  }
  return out;
}

/** The install's queues by key, from the resources a job created or kept. */
function queueIndex(queues: readonly CreatedResource[]): Map<string, CreatedResource> {
  return new Map(queues.filter((q) => q.type === "queue").map((q) => [q.binding, q]));
}

function mustFind(index: Map<string, CreatedResource>, key: string): CreatedResource {
  const queue = index.get(key);
  if (queue === undefined) {
    throw new JobError(`no queue resource is known for "${key}", so its consumer cannot be set up`);
  }
  return queue;
}

/** The API body of a consumer: the Worker, its dead-letter queue by name, and its settings. */
export function consumerBody(
  workerName: string,
  plan: ConsumerPlan,
  queues: readonly CreatedResource[],
): WorkerQueueConsumerBody {
  const body: WorkerQueueConsumerBody = { type: "worker", script_name: workerName };
  if (plan.deadLetterKey !== null) {
    body.dead_letter_queue = mustFind(queueIndex(queues), plan.deadLetterKey).name;
  }
  if (Object.keys(plan.settings).length > 0) body.settings = { ...plan.settings };
  return body;
}

/** Whether a consumer's dead-letter queue or settings differ between two versions. */
export function consumerChanged(before: ConsumerPlan | undefined, after: ConsumerPlan): boolean {
  if (before === undefined) return true;
  const shape = (p: ConsumerPlan) =>
    JSON.stringify([
      p.deadLetterKey,
      p.settings.batch_size,
      p.settings.max_retries,
      p.settings.max_wait_time_ms,
      p.settings.max_concurrency,
      p.settings.retry_delay,
    ]);
  return shape(before) !== shape(after);
}

/** The consumers a stored artifact manifest records; none when it records none or does not parse. */
export function consumerPlansOf(manifestJson: string | null): ConsumerPlan[] {
  if (manifestJson === null) return [];
  try {
    const worker = (JSON.parse(manifestJson) as { worker?: { queueConsumers?: unknown } }).worker;
    const parsed = z.array(queueConsumerSchema).safeParse(worker?.queueConsumers ?? []);
    return parsed.success ? consumerPlans(parsed.data) : [];
  } catch {
    return [];
  }
}

/** This Worker's consumer of a queue, or undefined when it has none. */
async function findConsumer(
  api: CloudflareClient,
  queueId: string,
  workerName: string,
): Promise<QueueConsumerInfo | undefined> {
  return (await api.queues.listConsumers(queueId)).find(
    (c) =>
      (c.type === undefined || c.type === "worker") &&
      // The API names the Worker in any of these, depending on the consumer's age.
      [c.script_name, c.script, c.service].includes(workerName),
  );
}

/**
 * One step: points the queue at the Worker and records the consumer. On a
 * retry it first looks for the consumer an earlier attempt created.
 */
async function attachConsumer(
  steps: JobSteps,
  installId: string,
  workerName: string,
  plan: ConsumerPlan,
  queues: readonly CreatedResource[],
): Promise<void> {
  const queue = mustFind(queueIndex(queues), plan.queueKey);
  const body = consumerBody(workerName, plan, queues);
  await steps.run(`attach consumer to queue ${queue.name}`, async ({ log, cf, orm, attempt }) => {
    const api = cf();
    let consumerId: string | null = null;
    if (attempt > 1) {
      consumerId = (await findConsumer(api, queue.cfId, workerName))?.consumer_id ?? null;
    }
    if (consumerId === null) {
      consumerId = (await api.queues.createConsumer(queue.cfId, body)).consumer_id ?? null;
    }
    // An earlier version may have had this consumer and an update removed it:
    // its row comes back to life with the new id.
    await orm
      .insert(resources)
      .values({
        id: resourceId(installId, QUEUE_CONSUMER_KIND, plan.queueKey),
        install_id: installId,
        kind: QUEUE_CONSUMER_KIND,
        binding: null,
        name: queue.name,
        cf_id: consumerId,
        created_at: new Date(steps.now()),
      })
      .onConflictDoUpdate({
        target: resources.id,
        set: { name: queue.name, cf_id: consumerId, deleted_at: null },
      });
    log.info(
      `Worker "${workerName}" now consumes ${plan.label} ("${queue.name}")` +
        (body.dead_letter_queue === undefined
          ? "."
          : `; failed messages go to "${body.dead_letter_queue}".`),
      { settings: body.settings ?? {} },
    );
    return {};
  });
}

/** Install: attach every consumer the artifact records, after the script upload. */
export async function attachQueueConsumersPhase(
  steps: JobSteps,
  installId: string,
  workerName: string,
  plans: readonly ConsumerPlan[],
  queues: readonly CreatedResource[],
): Promise<void> {
  for (const plan of plans) await attachConsumer(steps, installId, workerName, plan, queues);
}

/** A recorded consumer to remove, with the id of the queue it reads when that is known. */
export interface ConsumerTarget {
  /** `resources.id` of the consumer. */
  id: string;
  queueName: string;
  queueId: string | null;
  consumerId: string | null;
}

/**
 * The live consumers among an install's resource rows, each with its queue's
 * id (looked up by the key both rows share).
 */
export function consumerTargets(
  installId: string,
  rows: ReadonlyArray<Pick<RecordedResource, "id" | "kind" | "name" | "cfId">>,
): ConsumerTarget[] {
  const prefix = resourceId(installId, QUEUE_CONSUMER_KIND, "");
  const byId = new Map(rows.map((r) => [r.id, r]));
  return rows
    .filter((r) => r.kind === QUEUE_CONSUMER_KIND)
    .map((r) => {
      const key = r.id.startsWith(prefix) ? r.id.slice(prefix.length) : null;
      const queue = key === null ? undefined : byId.get(resourceId(installId, "queue", key));
      return { id: r.id, queueName: r.name, queueId: queue?.cfId ?? null, consumerId: r.cfId };
    });
}

/**
 * Removes one consumer: by its recorded id, else by finding this Worker's
 * consumer on the queue. A consumer (or queue) that is already gone counts as
 * removed. Returns what happened, for the log.
 */
async function removeConsumer(
  api: CloudflareClient,
  workerName: string,
  target: ConsumerTarget,
): Promise<"removed" | "gone" | "unknown queue"> {
  if (target.queueId === null) return "unknown queue";
  try {
    const consumerId =
      target.consumerId ??
      (await findConsumer(api, target.queueId, workerName))?.consumer_id ??
      null;
    if (consumerId === null) return "gone";
    await api.queues.deleteConsumer(target.queueId, consumerId);
    return "removed";
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return "gone";
  }
}

async function removeConsumerStep(
  steps: JobSteps,
  workerName: string,
  target: ConsumerTarget,
): Promise<void> {
  await steps.run(`remove consumer of queue ${target.queueName}`, async ({ log, cf, orm }) => {
    const outcome = await removeConsumer(cf(), workerName, target);
    if (outcome === "removed") {
      log.info(`Worker "${workerName}" no longer consumes the queue "${target.queueName}".`);
    } else if (outcome === "gone") {
      log.info(`The consumer of the queue "${target.queueName}" was already gone.`);
    } else {
      log.warn(
        `The queue "${target.queueName}" is not recorded with a Cloudflare id, so its consumer cannot be addressed; marked removed without a call. Check the queue in the Cloudflare dashboard.`,
      );
    }
    await markDeleted(orm, target.id, new Date(steps.now()));
    return {};
  });
}

async function markDeleted(orm: StepTools["orm"], id: string, at: Date): Promise<void> {
  await orm.update(resources).set({ deleted_at: at }).where(eq(resources.id, id));
}

/** Uninstall: remove every recorded consumer, before the Worker and its queues are deleted. */
export async function removeQueueConsumersPhase(
  steps: JobSteps,
  workerName: string,
  targets: readonly ConsumerTarget[],
): Promise<void> {
  for (const target of targets) await removeConsumerStep(steps, workerName, target);
}

/**
 * Update: once the new version serves, give the Worker exactly the consumers
 * it records. A new consumer is attached; one whose dead-letter queue or
 * settings changed is replaced with the new settings; one the version no
 * longer records is removed. Unchanged consumers make no call.
 */
export async function syncQueueConsumersPhase(
  steps: JobSteps,
  input: {
    installId: string;
    workerName: string;
    wanted: readonly ConsumerPlan[];
    /** The consumers of the version that served before. */
    previous: readonly ConsumerPlan[];
    /** The queues the new version uses, by key (bound and consumer-only). */
    queues: readonly CreatedResource[];
    /** The install's live resource rows before the update. */
    recorded: readonly RecordedResource[];
  },
): Promise<void> {
  const { installId, workerName, wanted, previous, queues, recorded } = input;
  const targets = consumerTargets(installId, recorded);
  const targetOf = (key: string) =>
    targets.find((t) => t.id === resourceId(installId, QUEUE_CONSUMER_KIND, key));
  for (const plan of wanted) {
    const target = targetOf(plan.queueKey);
    if (target === undefined) {
      await attachConsumer(steps, installId, workerName, plan, queues);
      continue;
    }
    const before = previous.find((p) => p.queueKey === plan.queueKey);
    if (!consumerChanged(before, plan)) continue;
    const queue = mustFind(queueIndex(queues), plan.queueKey);
    const body = consumerBody(workerName, plan, queues);
    await steps.run(`update consumer of queue ${queue.name}`, async ({ log, cf, orm }) => {
      const api = cf();
      const consumerId =
        target.consumerId ?? (await findConsumer(api, queue.cfId, workerName))?.consumer_id ?? null;
      let id = consumerId;
      if (consumerId === null) {
        id = (await api.queues.createConsumer(queue.cfId, body)).consumer_id ?? null;
      } else {
        await api.queues.updateConsumer(queue.cfId, consumerId, body);
      }
      if (id !== target.consumerId) {
        await orm.update(resources).set({ cf_id: id }).where(eq(resources.id, target.id));
      }
      log.info(`Updated the consumer of the queue "${queue.name}".`, {
        settings: body.settings ?? {},
      });
      return {};
    });
  }
  const keep = new Set(wanted.map((p) => resourceId(installId, QUEUE_CONSUMER_KIND, p.queueKey)));
  for (const target of targets) {
    if (!keep.has(target.id)) await removeConsumerStep(steps, workerName, target);
  }
}
