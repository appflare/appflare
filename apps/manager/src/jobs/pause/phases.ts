import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { createDb } from "../../db/client";
import { resources } from "../../db/schema";
import { findOpenPause } from "../../usage/store/pauses.server";
import type { JobSteps } from "../steps";
import {
  serveVersion,
  servingVersionOf,
  setContainerInstances,
  setInstanceStatus,
  setQueueDelivery,
} from "./cloudflare";
import {
  type PausedContainers,
  type PausedQueues,
  type PausedWorkflows,
  parsePausedQueues,
} from "./records";
import { isStandIn } from "./stand-in";

/**
 * Putting back what a pause changed, one step per change, as Resume does
 * and as a pause that failed does for what it had changed. Each step is
 * safe to repeat: it sets the recorded value again. `prefix` keeps the step
 * names of an undo apart from the pause's own.
 */

/**
 * Stand-ins uploaded side by side in one step: two requests each (the
 * Worker's Workers Logs setting, then the upload), within a step's planned
 * requests on Workers Free.
 */
export function standInsPerStep(accountPaid: boolean): number {
  return accountPaid ? 10 : 3;
}

/** Workflow instances per step: one call each, within a step's planned requests on Workers Free. */
export function instancesPerStep(accountPaid: boolean): number {
  return accountPaid ? 50 : 6;
}

/**
 * Why a pause or resume cannot go on: every Worker of the app is gone from
 * the account (deleted outside Appflare), so nothing of it can be paused or
 * run again, and what is left of it only goes with an uninstall.
 */
export function workersGoneMessage(workers: readonly string[], job: "pause" | "resume"): string {
  const outcome =
    job === "pause" ? "so there is nothing of it to pause" : "so the app cannot run again";
  const which =
    workers.length === 1
      ? `the app's Worker "${workers[0]}" is gone from the account (it was deleted outside Appflare)`
      : `every Worker of the app (${workers.map((w) => `"${w}"`).join(", ")}) is gone from the account (they were deleted outside Appflare)`;
  return `${which}, ${outcome}. Uninstall the app to remove what is left of it`;
}

/** A container application allows its recorded most instances again. */
export async function restoreContainerPhase(
  steps: JobSteps,
  container: PausedContainers[number],
  prefix = "",
): Promise<void> {
  await steps.run(
    `${prefix}allow container instances of ${container.name}`,
    async ({ log, cf }) => {
      const done = await setContainerInstances(cf(), container.id, container.maxInstances);
      log.info(
        done === "gone"
          ? `The container application "${container.name}" no longer exists.`
          : `The container application "${container.name}" may run up to ${container.maxInstances} instance${container.maxInstances === 1 ? "" : "s"} again.`,
      );
      return {};
    },
  );
}

/**
 * What a Worker serves now, against the version a pause recorded for it:
 * `gone` when it is no longer in the account; `stand-in` when it serves a
 * stand-in and gets its recorded version back; `kept` when it serves its
 * recorded version already, or another version someone deployed outside
 * Appflare while the app was paused, which is what they want to run.
 */
export type RecordedWorkerState = "gone" | "stand-in" | "kept";

/**
 * Reads one Worker in a step of its own (up to two requests), so the switch
 * that follows makes one request per Worker ({@link serveRecordedVersion})
 * and no step's requests grow with the app's Workers.
 */
export async function readRecordedWorker(
  steps: JobSteps,
  script: string,
  versionId: string,
  prefix = "",
): Promise<RecordedWorkerState> {
  const read = await steps.run(
    `${prefix}read what Worker ${script} serves`,
    async ({ log, cf }): Promise<{ state: RecordedWorkerState } | { standIn: boolean }> => {
      const api = cf();
      const serving = await servingVersionOf(api, script);
      if (serving === null) {
        log.warn(`Worker "${script}" no longer exists, so there is nothing of it to resume.`);
        return { state: "gone" };
      }
      if (serving.versionId === versionId) {
        log.info(`Worker "${script}" serves version ${versionId} already.`);
        return { state: "kept" };
      }
      if (!isStandIn(await api.versions.getVersion(script, serving.versionId))) {
        log.warn(
          `Worker "${script}" serves version ${serving.versionId}, deployed while the app was paused; it keeps serving it instead of version ${versionId}.`,
        );
        return { state: "kept" };
      }
      return { state: "stand-in" };
    },
  );
  return recordedWorkerStateOf(read);
}

/**
 * The state a read step recorded. A job that ran an earlier version of the
 * step recorded `{ standIn }` instead, and the engine hands that back when
 * it runs the job again: `standIn: true` is `stand-in`; `false` was both a
 * Worker that serves its own version and one that is gone (that job had
 * checked for gone Workers before it read them), and either way nothing of
 * it was put back, as `kept` does.
 */
export function recordedWorkerStateOf(
  read: { state: RecordedWorkerState } | { standIn: boolean },
): RecordedWorkerState {
  if ("state" in read) return read.state;
  return read.standIn ? "stand-in" : "kept";
}

/** A Worker serves its recorded version again, at 100% of its traffic: one request. */
export async function serveRecordedVersion(
  steps: JobSteps,
  script: string,
  versionId: string,
  prefix = "",
): Promise<void> {
  await steps.run(`${prefix}serve the app's version of Worker ${script}`, async ({ log, cf }) => {
    await serveVersion(cf(), script, versionId, "Appflare: resumed");
    log.info(`Version ${versionId} of Worker "${script}" serves all traffic again.`);
    return {};
  });
}

/** A queue the pause paused delivers its messages again. */
export async function resumeQueuePhase(
  steps: JobSteps,
  queue: PausedQueues[number],
  prefix = "",
): Promise<void> {
  await steps.run(`${prefix}resume delivery of queue ${queue.name}`, async ({ log, cf }) => {
    const done = await setQueueDelivery(cf(), queue, false);
    log.info(
      done === "gone"
        ? `The queue "${queue.name}" no longer exists.`
        : `The queue "${queue.name}" delivers its messages again.`,
    );
    return {};
  });
}

/** The Workflow instances a pause paused carry on, a batch per step. */
export async function resumeWorkflowPhase(
  steps: JobSteps,
  workflow: string,
  ids: readonly string[],
  perStep: number,
  prefix = "",
): Promise<void> {
  for (let at = 0; at < ids.length; at += perStep) {
    const batch = ids.slice(at, at + perStep);
    const label = ids.length <= perStep ? "" : ` (${at + 1}-${at + batch.length} of ${ids.length})`;
    await steps.run(
      `${prefix}resume instances of Workflow ${workflow}${label}`,
      async ({ log, cf }) => {
        const api = cf();
        let resumed = 0;
        for (const id of batch) {
          if ((await setInstanceStatus(api, workflow, id, "resume")) === "done") resumed++;
        }
        log.info(
          `Resumed ${resumed} of ${batch.length} instance${batch.length === 1 ? "" : "s"} of Workflow "${workflow}"${resumed < batch.length ? "; the others had ended or were not paused" : ""}.`,
        );
        return { resumed };
      },
    );
  }
}

/** What a pause recorded, as Resume and an undo read it. */
export interface RecordedPause {
  workerVersions: Record<string, string>;
  containers: PausedContainers;
  queues: PausedQueues;
  workflows: PausedWorkflows;
}

/**
 * Puts back everything a pause recorded, in the order that lets the app
 * start cleanly: container applications first (a Durable Object of the
 * app's own code starts its container at once), then the Workers, then the
 * queues (only the app's own code may receive their messages), then the
 * Workflow instances. Every recorded Worker is checked: one that serves a
 * stand-in serves its recorded version again ({@link readRecordedWorker}).
 *
 * Throws at the first change that fails; with `left`, each change is tried
 * on its own and what could not be put back is named there instead (the
 * undo of a pause that failed).
 */
export async function restorePhases(
  steps: JobSteps,
  recorded: RecordedPause,
  opts: {
    perStep: number;
    prefix?: string;
    left?: string[];
    /** Each recorded Worker's {@link readRecordedWorker}, when read already. */
    read?: Record<string, RecordedWorkerState>;
  },
): Promise<void> {
  const prefix = opts.prefix ?? "";
  const attempt = async (what: string, change: () => Promise<void>) => {
    if (opts.left === undefined) return change();
    try {
      await change();
    } catch {
      opts.left.push(what);
    }
  };
  for (const container of recorded.containers) {
    await attempt(`container application "${container.name}"`, () =>
      restoreContainerPhase(steps, container, prefix),
    );
  }
  // Each Worker read first, so the switch below makes one request per
  // Worker: on Workers Free, the switch of an app of many Workers then fits
  // one invocation's requests. Read once: Resume passes the reads it made
  // before anything changed.
  const read: Record<string, RecordedWorkerState> = { ...opts.read };
  if (opts.read === undefined) {
    for (const [script, versionId] of Object.entries(recorded.workerVersions)) {
      await attempt(`Worker "${script}"`, async () => {
        read[script] = await readRecordedWorker(steps, script, versionId, prefix);
      });
    }
  }
  const toServe = Object.entries(recorded.workerVersions)
    .filter(([script]) => read[script] === "stand-in")
    .map(([script, versionId]) => ({ script, versionId }));
  // Back to back, so the app's Workers switch together.
  if (toServe.length > 0) {
    await steps.reserve(`${prefix}the app's Workers`, toServe.length, async () => {
      for (const { script, versionId } of toServe) {
        await attempt(`Worker "${script}"`, () =>
          serveRecordedVersion(steps, script, versionId, prefix),
        );
      }
    });
  }
  for (const queue of recorded.queues) {
    await attempt(`queue "${queue.name}"`, () => resumeQueuePhase(steps, queue, prefix));
  }
  for (const [workflow, ids] of Object.entries(recorded.workflows)) {
    await attempt(`instances of Workflow "${workflow}"`, () =>
      resumeWorkflowPhase(steps, workflow, ids, opts.perStep, prefix),
    );
  }
}

/**
 * Uninstall of a paused app: the uninstall closes its pause, so a queue the
 * pause paused and the admin keeps would stay with its delivery paused, its
 * messages waiting for good. Its delivery resumes before the pause closes.
 * Nothing runs for an app that is not paused, or whose pause paused no queue.
 */
export async function resumeKeptQueuesPhase(
  steps: JobSteps,
  db: D1Database,
  installId: string,
): Promise<void> {
  const pause = await findOpenPause(createDb(db), installId);
  if (pause === null) return;
  const paused = parsePausedQueues(pause.queuesJson);
  if (paused.length === 0) return;
  await steps.run(
    "resume delivery of the kept queues the pause paused",
    async ({ log, cf, orm }) => {
      const kept = await orm
        .select({ cfId: resources.cf_id, name: resources.name })
        .from(resources)
        .where(
          and(
            eq(resources.install_id, installId),
            eq(resources.kind, "queue"),
            isNotNull(resources.retained_at),
            isNull(resources.deleted_at),
          ),
        );
      const api = cf();
      const resumed: string[] = [];
      for (const queue of paused) {
        if (!kept.some((k) => k.cfId === queue.id || k.name === queue.name)) continue;
        if ((await setQueueDelivery(api, queue, false)) === "set") resumed.push(queue.name);
      }
      if (resumed.length > 0) {
        log.info(
          `Resumed the delivery of the kept queue${resumed.length === 1 ? "" : "s"} ${resumed.map((n) => `"${n}"`).join(", ")}, paused with the app.`,
        );
      }
      return { resumed };
    },
  );
}
