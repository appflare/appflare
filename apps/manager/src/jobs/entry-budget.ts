import {
  definesWorkflow,
  FREE_PLAN_ACCOUNT_WORKERS,
  FREE_PLAN_SUBREQUESTS,
  FREE_PLAN_WORKFLOW_STEPS,
  isSeedOnly,
  PAID_PLAN_ACCOUNT_WORKERS,
  PAID_PLAN_SUBREQUESTS,
  PAID_PLAN_WORKFLOW_STEPS,
} from "@appflare/schema";
import type { EntryWorker } from "./entry-workers";
import { planAssetParts } from "./install/asset-parts";
import { SPEND_BEFORE_STEP } from "./invocation-budget";

/**
 * What the Workers of an app of several (./entry-workers.ts) cost one install
 * or update job, so the job can refuse an app it could not finish before it
 * changes anything.
 *
 * A job is one Workflow instance. Its steps are limited per instance (1,024
 * on Workers Free, 10,000 by default on Workers Paid), and its subrequests
 * per Worker invocation (50 on Workers Free, 10,000 by default on Workers
 * Paid; developers.cloudflare.com/workflows/reference/limits). The instance
 * runs its steps in one invocation until a sleep of 5 minutes resumes it in a
 * fresh one (measured in ./invocation-budget.ts). Nothing heavy runs in the
 * job itself: each Worker's upload is a job unit in an invocation of its own
 * (over `SELF`, see ./units/client.ts), checked against its own budget per
 * Worker (`workerUploadProblem`), and each asset part is another. The job
 * spends a fixed handful of steps and subrequests per Worker, counted here.
 *
 * On Workers Free a job of several Workers spreads its steps over as many
 * invocations as its requests need, waiting 5 minutes for each fresh one
 * (`JobSteps.spreadOverInvocations`), so only its steps bound it; the waits
 * are steps too and are counted. On Workers Paid the job runs in one
 * invocation, so its requests must fit that invocation's 10,000.
 *
 * Unit calls are counted and logged, not limited. Cloudflare documents "a
 * maximum of 32 Worker invocations" per request through service bindings,
 * but sequential calls are not held to it. Measured 2026-09-27 with a
 * Workflow calling its own Worker's entrypoint over a service binding, all
 * calls in one step and one call per step: on Workers Free the 33rd to 50th
 * calls succeeded and the 51st failed on the subrequest limit; on Workers
 * Paid all 120 calls succeeded, each callee making a fetch of its own. The
 * count is logged so a job that ever fails there can be matched against it.
 *
 * The primary Worker's part is a fixed reserve, not counted from the app, so
 * every total is an estimate.
 */

/** Steps, subrequests and unit calls a job spends. */
export interface JobCost {
  /** Workflow steps, sleeps included (the waits for fresh invocations too). */
  steps: number;
  /**
   * Subrequests in the job's own invocations: Cloudflare API calls, unit
   * calls and probes. Not D1 calls, which do not count (measured in
   * ./invocation-budget.ts).
   */
  subrequests: number;
  /** Calls to job units over `SELF` (each also one of `subrequests`). */
  unitCalls: number;
  /**
   * Waits of 5 minutes for a fresh invocation, on Workers Free; each is two
   * of `steps` (its log line and its sleep). Zero on Workers Paid.
   */
  waits: number;
}

export type EntryJobKind = "install" | "update";

/**
 * What the primary Worker and the app's resources typically make in
 * subrequests, health check included: about 21 before it and 1 to 12 for it
 * (the typical app in ./units/client.ts). Only the estimate of the waits
 * uses it; the job counts what it really spends.
 */
export const PRIMARY_SUBREQUESTS = 25;

/**
 * What the job spends besides the Workers other than the primary one: the
 * primary Worker with its canary and live health check (up to 10 probes and
 * their sleeps), the app's resources, D1 migrations, secrets, snapshots and
 * records, and for an install that replaces one that did not finish the
 * wait for its removal (at most 9 polls with their sleeps, each poll one D1
 * query and at most one log write). A large app of one Worker (a database
 * with 30 migrations, six resources, two secrets) spends under 50
 * subrequests on all of it (the worked example in ./units/client.ts); this
 * leaves room for many times that. The waits on Workers Free are estimated
 * from a typical app's part instead ({@link PRIMARY_SUBREQUESTS}).
 */
export const JOB_RESERVE: JobCost = { steps: 400, subrequests: 1_500, unitCalls: 40, waits: 0 };

function spend(steps: number, sleeps: number, calls: number, unitCalls: number): JobCost {
  return { steps: steps + sleeps, subrequests: calls, unitCalls, waits: 0 };
}

/**
 * Asset upload parts of one Worker, each a step and a unit call, planned for
 * the worst grouping Cloudflare may ask for (one upload request per file)
 * from every file; files Cloudflare already stores are skipped, so an update
 * usually spends less.
 */
function assetParts(worker: EntryWorker): number {
  const files = worker.manifest.assets.files;
  return files.length === 0 ? 0 : planAssetParts(files, true).length;
}

/**
 * The most one Worker other than the primary one adds to a job.
 *
 * Install: its assets (the session and the parts), the steps that record it,
 * its upload (a unit call), its workers.dev route, one step per secret it
 * gets, its cron triggers and one step per queue it consumes (a list and a
 * create each), and for each Workflow it defines a step that checks the name
 * is free and one that creates it after its upload (a call each).
 *
 * Update: the read of its deployment for the snapshot, its route taken off
 * workers.dev when the version keeps it private, its assets, its version
 * upload, previews and a canary of up to `canaryAttempts` probes with a sleep
 * after each, its promotion, its queue consumers, cron triggers and route,
 * and on failure its return to the snapshot's version with its route and
 * secrets put back; and for each Workflow it defines, a name check when the
 * version brings it, and the step that creates or updates it once it serves
 * (a call each).
 *
 * A Workflow binding that runs a Workflow another Worker defines costs
 * nothing of its own: the Worker that defines it creates it.
 */
export function otherWorkerCost(
  worker: EntryWorker,
  kind: EntryJobKind,
  canaryAttempts: number,
): JobCost {
  const parts = assetParts(worker);
  const assets = parts === 0 ? 0 : 1 + parts;
  const units = parts + 1;
  const secrets = worker.manifest.catalog.secrets.filter((s) => !isSeedOnly(s)).length;
  const crons = worker.manifest.worker.crons.length > 0 ? 1 : 0;
  const consumers = worker.manifest.worker.queueConsumers?.length ?? 0;
  const workflows = worker.manifest.worker.bindings.filter(definesWorkflow).length;
  if (kind === "install") {
    const steps = assets + 3 + 1 + secrets + crons + consumers + 2 * workflows;
    // Each Workflow: the name check's call and the call that creates it.
    const calls = assets + 1 + 1 + secrets + crons + 2 * consumers + 2 * workflows;
    return spend(steps, 0, calls, units);
  }
  const canary = 1 + canaryAttempts;
  const undo = 3;
  const steps = 1 + 1 + assets + 1 + canary + 1 + consumers + crons + 1 + undo + 2 * workflows;
  return spend(steps, canaryAttempts, steps + consumers, units);
}

/**
 * The job's estimated total: {@link JOB_RESERVE} plus each Worker other than
 * the primary one, and, when the job spreads over invocations (Workers
 * Free), the waits for fresh ones its requests take: a fresh invocation for
 * every {@link SPEND_BEFORE_STEP} subrequests after the first.
 */
export function entryJobCost(
  workers: readonly EntryWorker[],
  kind: EntryJobKind,
  canaryAttempts: number,
  spread = false,
): JobCost {
  const total = workers
    .filter((w) => !w.primary)
    .reduce(
      (sum, w) => {
        const one = otherWorkerCost(w, kind, canaryAttempts);
        return {
          steps: sum.steps + one.steps,
          subrequests: sum.subrequests + one.subrequests,
          unitCalls: sum.unitCalls + one.unitCalls,
          waits: 0,
        };
      },
      { ...JOB_RESERVE },
    );
  if (!spread) return total;
  const others = total.subrequests - JOB_RESERVE.subrequests;
  const waits = Math.max(0, Math.ceil((PRIMARY_SUBREQUESTS + others) / SPEND_BEFORE_STEP) - 1);
  return { ...total, steps: total.steps + 2 * waits, waits };
}

/**
 * Why one job cannot install or update these Workers on the account's plan,
 * or null. The steps are checked on both plans, the waits for fresh
 * invocations included; the subrequests only on Workers Paid, where the job
 * runs in one invocation. On Workers Free it spreads them over as many as
 * they need.
 */
export function entryBudgetProblem(cost: JobCost, paid: boolean, count: number): string | null {
  const maxSteps = paid ? PAID_PLAN_WORKFLOW_STEPS : FREE_PLAN_WORKFLOW_STEPS;
  const plan = paid ? "Workers Paid" : "Workers Free";
  if (cost.steps > maxSteps) {
    return `This app has ${count} Workers, and one job for them would run an estimated ${cost.steps} Workflow steps; ${plan} allows ${maxSteps.toLocaleString("en-US")} per job.`;
  }
  if (paid && cost.subrequests > PAID_PLAN_SUBREQUESTS) {
    return `This app has ${count} Workers, and one job for them would make an estimated ${cost.subrequests} subrequests; Workers Paid allows ${PAID_PLAN_SUBREQUESTS.toLocaleString("en-US")} per job.`;
  }
  return null;
}

/** One line for the job log: what the job is estimated to spend on the app's Workers. */
export function entryBudgetLine(cost: JobCost, paid: boolean, count: number): string {
  const maxSteps = paid ? PAID_PLAN_WORKFLOW_STEPS : FREE_PLAN_WORKFLOW_STEPS;
  const steps = `an estimated ${cost.steps} Workflow steps of the ${maxSteps.toLocaleString("en-US")} a job may run`;
  const units = `${cost.unitCalls} unit calls`;
  if (paid) {
    return `The app's ${count} Workers: ${steps}, ${cost.subrequests} subrequests of the ${PAID_PLAN_SUBREQUESTS.toLocaleString("en-US")} Workers Paid allows a job, and ${units}.`;
  }
  const waits =
    cost.waits === 0
      ? ""
      : `, about ${cost.waits} wait${cost.waits === 1 ? "" : "s"} of 5 minutes for a fresh allowance of the ${FREE_PLAN_SUBREQUESTS} requests Workers Free gives a job at a time`;
  return `The app's ${count} Workers: ${steps}${waits}, and ${units}.`;
}

/**
 * Why the account has no room for `adding` more Workers next to the
 * `existing` ones, or null. Cloudflare allows 100 Workers per account on
 * Workers Free and 500 on Workers Paid. `plan` is "free" only when the
 * account is known to be on Workers Free (detected, or set in Settings); an
 * account of unknown plan is held to Workers Paid's limit, since one with 100
 * Workers or more is on Workers Paid.
 */
export function accountWorkersProblem(
  existing: number,
  adding: number,
  plan: "free" | "paid",
): string | null {
  const free = plan === "free";
  const max = free ? FREE_PLAN_ACCOUNT_WORKERS : PAID_PLAN_ACCOUNT_WORKERS;
  if (existing + adding <= max) return null;
  const what = adding === 1 ? "one Worker" : `${adding} Workers`;
  return `This app installs ${what}, and the account already has ${existing}; ${free ? "Workers Free" : "Workers Paid"} allows ${max} Workers per account. Delete Workers you no longer use${free ? ", or move the account to Workers Paid (500 Workers)" : ""}, then install again.`;
}
