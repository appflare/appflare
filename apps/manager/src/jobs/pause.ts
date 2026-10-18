import { NonRetryableError } from "cloudflare:workflows";
import type { WorkerExports } from "@appflare/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { readAccountPlan } from "../account/plan.server";
import { requireConnection } from "../cloudflare/connection.server";
import { createDb } from "../db/client";
import { installs, jobs, resources } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { emitUsageEvent } from "../notifications/usage-events.server";
import { type PauseCause, parsePauseCause, pauseCauseSchema } from "../usage/attention-cause";
import { recordActivity } from "../usage/store/activity.server";
import {
  closePause,
  findOpenPause,
  openPause,
  recordPauseProgress,
} from "../usage/store/pauses.server";
import { entryWorkers, parseStoredManifest } from "./entry-workers";
import {
  activeInstancesOf,
  queueStateOf,
  readAppDurableObjects,
  serveVersion,
  servingFactsOf,
  servingVersionOf,
  setContainerInstances,
  setInstanceStatus,
  setQueueDelivery,
  uploadStandIn,
} from "./pause/cloudflare";
import { PAUSED_BY_TRIGGER, type PauseJobParams, pauseJobParams } from "./pause/params";
import {
  instancesPerStep,
  type RecordedPause,
  restorePhases,
  standInsPerStep,
  workersGoneMessage,
} from "./pause/phases";
import {
  containersJson,
  type PausedContainers,
  type PausedWorkflows,
  parsePausedContainers,
  parsePausedQueues,
  parsePausedWorkflows,
  queuesJson,
  workflowsJson,
} from "./pause/records";
import type { JobContext } from "./run-job";
import { StepLog } from "./step-log";
import { createJobSteps, errorMessage, JobError } from "./steps";

/**
 * The `pause` job: the app stops costing money within seconds, and what it
 * changes is recorded on the app's pause as it goes, so Resume puts back
 * exactly what ran.
 *
 * 1. Open the app's pause (`app_pauses`, one open per app). A pause an
 *    earlier job left open without finishing (its job failed or was
 *    stopped) is carried on: what it recorded is kept.
 * 2. Read the app's Durable Object classes and the container applications
 *    behind them, then each Worker's serving version, recorded on the pause
 *    before anything changes.
 * 3. Upload the stand-ins (./pause/stand-in.ts), side by side; nothing
 *    serves them yet.
 * 4. Pause the delivery of the app's queues (a message handed to the
 *    stand-in would only be retried), then the app's Workflow instances
 *    that run or wait to (one that started on the stand-in would fail for
 *    good, as an instance keeps the version it started on).
 * 5. Deploy every stand-in at 100%, back to back: requests get the paused
 *    page within seconds, alarms are put off, cron triggers do nothing.
 * 6. Let each container application run no instance (they stop within
 *    about 15 seconds).
 * 7. Record the pause in the app's activity, then tell the notification
 *    channels (`app_paused`). The job's own end tells them nothing more.
 *
 * Each queue, container application and Workflow instance is recorded
 * before it is changed. When a step fails, everything the pause records is
 * put back (what an earlier job of a pause carried on changed included) and
 * the pause is closed (`pause_failed`), so nothing blocks the next pause;
 * when something cannot be put back, the pause stays open, and Resume
 * finishes putting it back. Either way the channels hear that the pause
 * failed (`app_pause_failed`): the app may still be spending.
 */

const MESSAGE_PAUSED = "Appflare: paused";

/** The app's resources the pause works on, from the install's records. */
interface AppTargets {
  workers: string[];
  queues: Array<{ id: string | null; name: string }>;
  workflows: string[];
  /** Each Worker's declared exports, from the app's manifest. */
  exports: Record<string, WorkerExports>;
}

async function readTargets(
  orm: ReturnType<typeof createDb>,
  installId: string,
  workerName: string,
  manifestJson: string | null,
): Promise<AppTargets> {
  const live = await orm
    .select({ kind: resources.kind, name: resources.name, cfId: resources.cf_id })
    .from(resources)
    .where(
      and(
        eq(resources.install_id, installId),
        isNull(resources.deleted_at),
        inArray(resources.kind, ["worker", "queue", "workflow"]),
      ),
    )
    .orderBy(sql`rowid`);
  const workers = [...new Set(live.filter((r) => r.kind === "worker").map((r) => r.name))];
  // An install recorded before its Worker was, or whose Worker the app's
  // own installer deployed under the install's name.
  if (workers.length === 0) workers.push(workerName);
  const manifest = parseStoredManifest(manifestJson);
  const exports: Record<string, WorkerExports> = {};
  if (manifest !== null) {
    for (const w of entryWorkers(manifest, workerName)) {
      const declared = w.manifest.worker.exports;
      if (declared !== undefined && Object.keys(declared).length > 0) {
        exports[w.scriptName] = declared;
      }
    }
  }
  return {
    workers,
    queues: live.filter((r) => r.kind === "queue").map((r) => ({ id: r.cfId, name: r.name })),
    workflows: [...new Set(live.filter((r) => r.kind === "workflow").map((r) => r.name))],
    exports,
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** What a pause records, read back from the pause. */
function recordedOf(pause: {
  workerVersions: Record<string, string> | null;
  containersJson: string | null;
  queuesJson: string | null;
  workflowsJson: string | null;
}): RecordedPause {
  return {
    workerVersions: pause.workerVersions ?? {},
    containers: parsePausedContainers(pause.containersJson),
    queues: parsePausedQueues(pause.queuesJson),
    workflows: parsePausedWorkflows(pause.workflowsJson),
  };
}

export async function runPause(ctx: JobContext): Promise<void> {
  const parsed = pauseJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid pause job payload");
  const params: PauseJobParams = parsed.data;
  const { step, env } = ctx;
  const steps = createJobSteps(ctx, params.jobId);
  const { run, now } = steps;

  /** What is recorded on the pause so far, as this run goes. */
  const recorded: RecordedPause = { workerVersions: {}, containers: [], queues: [], workflows: {} };
  let accountPaid = false;
  /**
   * The app was paused already, or being paused: this job changed nothing
   * and its failure is no news. Set from a step's recorded result, so a
   * replay decides the same.
   */
  let alreadyPaused = false;
  let finished: { pauseId: string; pausedBy: string; cause: PauseCause } | null = null;

  try {
    const started = await steps.start(async ({ log, orm }) => {
      const [install] = await orm
        .select({
          status: installs.status,
          workerName: installs.worker_name,
          manifestJson: installs.manifest_json,
        })
        .from(installs)
        .where(eq(installs.id, params.installId))
        .limit(1);
      if (install === undefined) throw new JobError("the install no longer exists");
      if (install.status !== "installed") {
        throw new JobError(`only an installed app can be paused; this one is ${install.status}`);
      }
      const settings = await readSettings(orm, [SETTING.accountId]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      // An API token, or a stored grant that does not need reconnecting.
      await requireConnection(env);
      const cause = pauseCauseSchema.safeParse({ ...(params.detail ?? {}), reason: params.reason });
      if (!cause.success) throw new JobError("the reason for the pause does not read as one");
      const { reason: _reason, ...detail } = cause.data;
      const targets = await readTargets(
        orm,
        params.installId,
        install.workerName,
        install.manifestJson,
      );
      const paid = (await readAccountPlan(orm)) === "paid";
      // Opened last: nothing after it in this step can fail and leave it open unseen.
      const opened = await openPause(orm, {
        installId: params.installId,
        pausedBy: params.by ?? PAUSED_BY_TRIGGER,
        reason: params.reason,
        detailJson: Object.keys(detail).length === 0 ? null : JSON.stringify(detail),
        jobId: params.jobId,
      });
      let pause = opened.pause;
      if (!opened.opened && pause.jobId !== params.jobId) {
        const [earlier] =
          pause.jobId === null
            ? []
            : await orm
                .select({ status: jobs.status })
                .from(jobs)
                .where(eq(jobs.id, pause.jobId))
                .limit(1);
        if (earlier?.status === "succeeded") return { refused: "the app is already paused" };
        if (earlier?.status === "queued" || earlier?.status === "running") {
          return { refused: "another pause of the app is still running" };
        }
        // Its job failed or was stopped before it could finish or undo it.
        const adopted = await recordPauseProgress(orm, pause.id, { jobId: params.jobId });
        if (adopted === null) throw new JobError("the app's pause closed while this one started");
        pause = adopted;
        log.info(
          "An earlier pause of the app did not finish. This one carries on from what it recorded.",
        );
      }
      log.info(
        `Pausing the app: ${plural(targets.workers.length, "Worker")}` +
          (targets.queues.length > 0 ? `, ${plural(targets.queues.length, "queue")}` : "") +
          (targets.workflows.length > 0
            ? `, ${plural(targets.workflows.length, "Workflow")}`
            : "") +
          ".",
      );
      return {
        refused: null,
        pauseId: pause.id,
        startedAt: now(),
        accountId: settings.account_id,
        accountPaid: paid,
        targets,
        recorded: recordedOf(pause),
      };
    });
    if (started === null) return;
    if (started.refused !== null) {
      alreadyPaused = true;
      throw new JobError(started.refused);
    }
    accountPaid = started.accountPaid;
    Object.assign(recorded, started.recorded);
    steps.setAccountId(started.accountId);
    // An app of many parts may need more requests than one invocation
    // makes on Workers Free: its steps then spread over invocations.
    if (!accountPaid) steps.spreadOverInvocations();
    const { targets } = started;
    const id = started.pauseId;

    // 2. What runs now.
    const durableObjects = await run("read the app's Durable Objects", async ({ log, cf }) => {
      const found = await readAppDurableObjects(cf(), targets.workers);
      const classes = Object.values(found.classes).flat();
      if (classes.length > 0) log.info(`Durable Object classes: ${classes.join(", ")}.`);
      if (found.containers.length > 0) {
        log.info(
          `Container applications: ${found.containers.map((c) => `${c.name} (up to ${c.maxInstances})`).join(", ")}.`,
        );
      } else if (found.containersUnread === "refused") {
        log.warn(
          "Appflare's API token cannot read Containers (Account > Containers), so a container application behind the app's Durable Objects keeps the instances it runs. The stand-in serves its Durable Objects, which stops them from starting new ones.",
        );
      }
      return found;
    });

    const reads: Array<{ script: string; facts: Awaited<ReturnType<typeof servingFactsOf>> }> = [];
    for (const script of targets.workers) {
      const read = await run(`read Worker ${script}`, async ({ log, cf, orm }) => {
        const api = cf();
        const serving = await servingVersionOf(api, script);
        if (serving === null) {
          log.warn(`Worker "${script}" is not in the account, so there is nothing of it to pause.`);
          return { gone: true as const };
        }
        // A pause carried on keeps the version it recorded: the Worker may
        // serve that pause's stand-in by now.
        const versionId = recorded.workerVersions[script] ?? serving.versionId;
        const facts = await servingFactsOf(api, script, versionId);
        if (facts.standIn) {
          throw new JobError(
            `Worker "${script}" serves a stand-in of an earlier pause that Appflare has no record of; deploy the app's own version from the Cloudflare dashboard (Workers > ${script} > Deployments), then pause again`,
          );
        }
        if (serving.percentage < 100) {
          log.warn(
            `Worker "${script}" serves version ${serving.versionId} to ${serving.percentage}% of its traffic during a gradual deployment; Resume brings that version back for all of it.`,
          );
        }
        // Recorded before anything changes, so Resume and an undo know it.
        await recordPauseProgress(orm, id, {
          workerVersions: { ...recorded.workerVersions, [script]: versionId },
        });
        log.info(`Worker "${script}" serves version ${versionId}.`);
        return { gone: false as const, versionId, facts };
      });
      if (read.gone) continue;
      recorded.workerVersions = { ...recorded.workerVersions, [script]: read.versionId };
      reads.push({ script, facts: read.facts });
    }
    // Every Worker was deleted outside Appflare: nothing has changed yet,
    // and nothing would stop the app from spending, so the pause stops here.
    if (reads.length === 0) throw new JobError(workersGoneMessage(targets.workers, "pause"));

    // 3. The stand-ins, uploaded side by side (each takes seconds), a few per
    // step so a step stays within its planned requests; uploading one again
    // when a step is retried only leaves a version nobody deploys.
    const standIns: Record<string, string> = {};
    const perUploadStep = standInsPerStep(accountPaid);
    for (let at = 0; at < reads.length; at += perUploadStep) {
      const batch = reads.slice(at, at + perUploadStep);
      const name =
        batch.length === 1
          ? `upload the stand-in of Worker ${batch[0]?.script}`
          : `upload the stand-ins of Workers ${batch.map((b) => b.script).join(", ")}`;
      const uploaded = await run(name, async ({ log, cf }) => {
        const api = cf();
        const results = await Promise.all(
          batch.map(async ({ script, facts }) => ({
            script,
            ...(await uploadStandIn(api, script, {
              serving: facts,
              durableObjects,
              exports: targets.exports[script] ?? null,
            })),
          })),
        );
        for (const { script, versionId, observability } of results) {
          log.info(`Uploaded the stand-in of Worker "${script}" as version ${versionId}.`);
          if (observability === "unread") {
            log.warn(
              `Could not read whether Workers Logs are on for "${script}"; a version upload leaves that setting as it is, so the stand-in went without it.`,
            );
          }
        }
        return {
          versions: Object.fromEntries(results.map((r) => [r.script, r.versionId])),
        };
      });
      Object.assign(standIns, uploaded.versions);
    }

    // 4. Queues and Workflow instances, before the Workers switch.
    let queueIds: Record<string, string> = {};
    if (targets.queues.some((q) => q.id === null)) {
      queueIds = await run("find the app's queues", async ({ cf }) => {
        const all = await cf().queues.listQueues();
        return Object.fromEntries(all.map((q) => [q.queue_name, q.queue_id]));
      });
    }
    for (const queue of targets.queues) {
      const queueId = queue.id ?? queueIds[queue.name];
      if (queueId === undefined) continue;
      const result = await run(
        `pause delivery of queue ${queue.name}`,
        async ({ log, cf, orm }) => {
          const api = cf();
          const ours = recorded.queues.some((q) => q.id === queueId);
          const state = await queueStateOf(api, queueId);
          if (state === null) {
            log.warn(`The queue "${queue.name}" no longer exists.`);
            return { entry: null };
          }
          if (state.paused && !ours) {
            log.info(`The queue "${queue.name}" was paused already; Resume leaves it paused.`);
            return { entry: null };
          }
          const entry = { id: queueId, name: state.name || queue.name };
          if (!ours) {
            await recordPauseProgress(orm, id, {
              queuesJson: queuesJson([...recorded.queues, entry]),
            });
          }
          await setQueueDelivery(api, entry, true);
          log.info(`Paused the delivery of queue "${entry.name}"; its messages wait in the queue.`);
          return { entry };
        },
      );
      const entry = result.entry;
      if (entry !== null && !recorded.queues.some((q) => q.id === entry.id)) {
        recorded.queues = [...recorded.queues, entry];
      }
    }

    const perStep = instancesPerStep(accountPaid);
    for (const workflow of targets.workflows) {
      const listed = await run(
        `list running instances of Workflow ${workflow}`,
        async ({ log, cf, orm }) => {
          const found = await activeInstancesOf(cf(), workflow);
          if (found === null) {
            log.warn(`The Workflow "${workflow}" no longer exists.`);
            return { ids: [] as string[] };
          }
          const ids = [...new Set([...(recorded.workflows[workflow] ?? []), ...found.ids])];
          if (ids.length > 0) {
            const next: PausedWorkflows = { ...recorded.workflows, [workflow]: ids };
            await recordPauseProgress(orm, id, { workflowsJson: workflowsJson(next) });
          }
          log.info(
            ids.length === 0
              ? `No instance of Workflow "${workflow}" is running.`
              : `Pausing ${plural(ids.length, "instance")} of Workflow "${workflow}".`,
          );
          if (found.capped) {
            log.warn(
              `Workflow "${workflow}" has more instances running than one pause pauses; the others carry on.`,
            );
          }
          return { ids };
        },
      );
      if (listed.ids.length === 0) continue;
      recorded.workflows = { ...recorded.workflows, [workflow]: listed.ids };
      for (let at = 0; at < listed.ids.length; at += perStep) {
        const batch = listed.ids.slice(at, at + perStep);
        const label =
          listed.ids.length <= perStep
            ? ""
            : ` (${at + 1}-${at + batch.length} of ${listed.ids.length})`;
        await run(`pause instances of Workflow ${workflow}${label}`, async ({ log, cf }) => {
          const api = cf();
          let paused = 0;
          for (const instance of batch) {
            if ((await setInstanceStatus(api, workflow, instance, "pause")) === "done") paused++;
          }
          log.info(
            `Paused ${paused} of ${plural(batch.length, "instance")} of Workflow "${workflow}"${paused < batch.length ? "; the others had ended or were paused already" : ""}.`,
          );
          return { paused };
        });
      }
    }

    // 5. Every Worker switches to its stand-in, back to back.
    const scripts = Object.keys(standIns);
    const switchedAt = await steps.reserve("the stand-ins", scripts.length, async () => {
      let at = started.startedAt;
      for (const script of scripts) {
        const versionId = standIns[script] as string;
        const served = await run(`serve the stand-in of Worker ${script}`, async ({ log, cf }) => {
          await serveVersion(cf(), script, versionId, MESSAGE_PAUSED);
          log.info(`Worker "${script}" serves its stand-in: requests get the paused page.`);
          return { at: now() };
        });
        at = served.at;
      }
      return at;
    });

    // 6. Containers.
    for (const container of durableObjects.containers) {
      const earlier = recorded.containers.find((c) => c.id === container.id);
      if (earlier === undefined && container.maxInstances === 0) continue;
      const entry: PausedContainers[number] = earlier ?? {
        id: container.id,
        name: container.name,
        maxInstances: container.maxInstances,
      };
      await run(`stop container instances of ${container.name}`, async ({ log, cf, orm }) => {
        if (earlier === undefined) {
          await recordPauseProgress(orm, id, {
            containersJson: containersJson([...recorded.containers, entry]),
          });
        }
        const done = await setContainerInstances(cf(), container.id, 0);
        log.info(
          done === "gone"
            ? `The container application "${container.name}" no longer exists.`
            : `The container application "${container.name}" runs no instances now; those running stop within about 15 seconds.`,
        );
        return {};
      });
      if (earlier === undefined) recorded.containers = [...recorded.containers, entry];
    }

    // 7. Done.
    const done = await run("finish", async ({ log, orm }) => {
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "succeeded", finished_at: at, error: null })
        .where(eq(jobs.id, params.jobId));
      const pause = await findOpenPause(orm, params.installId);
      const seconds = Math.max(0, Math.round((switchedAt - started.startedAt) / 1000));
      log.info(
        `The app is paused: its Workers serve the paused page (${seconds} s after the pause started), and nothing of it runs until it is resumed.`,
      );
      if (pause !== null) {
        await recordActivity(orm, {
          installId: params.installId,
          kind: "paused",
          facts: { pauseId: id, reason: pause.reason, jobId: params.jobId },
          by: params.by,
          at,
        });
      }
      return {
        pausedBy: pause?.pausedBy ?? params.by ?? PAUSED_BY_TRIGGER,
        cause: pause === null ? null : parsePauseCause(pause.reason, pause.detailJson),
      };
    });
    finished = {
      pauseId: id,
      pausedBy: done.pausedBy,
      cause: done.cause ?? { reason: "manual" },
    };
  } catch (error) {
    await failPause(error);
  }

  // Outside the job's own work: a notification that cannot be recorded
  // never undoes a finished pause, nor fails its job.
  if (finished !== null) {
    const notice = finished;
    try {
      await step.do("tell notification channels", async () => {
        const outcome = await emitUsageEvent(env, {
          type: "app_paused",
          installId: params.installId,
          pauseId: notice.pauseId,
          pausedBy: notice.pausedBy,
          cause: notice.cause,
        });
        return { status: outcome.status };
      });
    } catch (error) {
      console.warn("pause notification failed", {
        jobId: params.jobId,
        error: errorMessage(error),
      });
    }
  }

  async function failPause(error: unknown): Promise<never> {
    const reason = `${steps.current}: ${errorMessage(error)}`;
    const failedAt = steps.current;
    // Whether the app's open pause is this job's, and what it records, read
    // back from the pause itself: a pause carried on from an earlier job has
    // that job's changes to put back too, and a start that failed after
    // taking a pause over has nothing of them in this run.
    const owned = await step.do("undo: read what the pause changed", async () => {
      if (alreadyPaused) return null;
      const orm = createDb(env.DB);
      const open = await findOpenPause(orm, params.installId);
      if (open === null || open.jobId !== params.jobId) return null;
      const settings = await readSettings(orm, [SETTING.accountId]);
      return {
        pauseId: open.id,
        accountId: settings.account_id ?? null,
        recorded: recordedOf(open),
      };
    });
    // Put back what was recorded, each change on its own, so one that
    // cannot be put back does not keep the others from it.
    const left: string[] = [];
    if (owned !== null) {
      const changed = owned.recorded;
      const anything =
        Object.keys(changed.workerVersions).length > 0 ||
        changed.containers.length > 0 ||
        changed.queues.length > 0 ||
        Object.keys(changed.workflows).length > 0;
      if (anything && owned.accountId === null) {
        left.push("what the pause recorded (the Cloudflare account is not known)");
      } else if (anything && owned.accountId !== null) {
        steps.setAccountId(owned.accountId);
        await restorePhases(steps, changed, {
          perStep: instancesPerStep(accountPaid),
          prefix: "undo: ",
          left,
        });
      }
    }
    await step.do("mark pause failed", async () => {
      const orm = createDb(env.DB);
      const at = new Date(now());
      await orm
        .update(jobs)
        .set({ status: "failed", error: reason, finished_at: at })
        .where(eq(jobs.id, params.jobId));
      const log = new StepLog(now);
      if (owned === null) {
        log.error(`Pause failed at "${failedAt}". Nothing was changed.`);
      } else {
        // Closed only once everything is back, so nothing blocks the next pause;
        // what could not be put back stays recorded for Resume.
        if (left.length === 0) {
          await closePause(orm, params.installId, { resumedBy: null, resumedAt: at });
        }
        await recordActivity(orm, {
          installId: params.installId,
          kind: "pause_failed",
          facts: { reason: params.reason, jobId: params.jobId, error: reason },
          by: params.by,
          at,
        });
        log.error(
          left.length === 0
            ? `Pause failed at "${failedAt}". Everything it had changed is back as it was, and the app runs as before.`
            : `Pause failed at "${failedAt}", and Appflare could not put back: ${left.join(", ")}. The app shows as paused; Resume it to put the rest back.`,
          left.length === 0 ? undefined : { left },
        );
      }
      await log.flush(env.DB, params.jobId);
      return {};
    });
    // A pause that did not happen is news: the app may still be spending.
    // Not when the app turned out to be paused already.
    if (!alreadyPaused) {
      await step.do("tell notification channels the pause failed", async () => {
        const cause = pauseCauseSchema.safeParse({
          ...(params.detail ?? {}),
          reason: params.reason,
        });
        const outcome = await emitUsageEvent(env, {
          type: "app_pause_failed",
          installId: params.installId,
          pauseId: owned?.pauseId ?? null,
          jobId: params.jobId,
          pausedBy: params.by ?? PAUSED_BY_TRIGGER,
          cause: cause.success ? cause.data : { reason: "manual" },
          left,
        });
        return { status: outcome.status };
      });
    }
    throw new NonRetryableError(reason);
  }
}
