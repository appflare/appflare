import { CloudflareApiError, type CloudflareClient } from "@appflare/cf-api";
import {
  cronTriggersPhrase,
  FREE_PLAN_CRON_TRIGGERS,
  PAID_PLAN_CRON_TRIGGERS,
} from "../../catalog/cron-triggers";
import { messageLink } from "../../components/message-links";
import { settingsLink } from "../../components/settings-links";
import { errorMessage, isNotFound, JobError } from "../errors";
import type { JobSteps } from "../steps";
import { settleUnit } from "../units/result";

/**
 * The account-wide cron trigger limit (5 on Workers Free), checked twice:
 *
 * 1. Before anything is created, the install job (and an update whose new
 *    version sets more cron triggers than the Worker has) counts the
 *    triggers the account's other Workers use and stops when the app's own
 *    would take the account past 5. The count lists the account's Workers
 *    once and reads their schedules in the job unit `countCronTriggers`
 *    (its own invocation, one subrequest for the job): first every Worker
 *    that exports a `scheduled` handler, then, as far as
 *    {@link CRON_SCAN_MAX_WORKERS} reads go, the others, since a Worker
 *    keeps its cron triggers when a deploy drops its handler and Cloudflare
 *    counts them all the same. An account with more Workers with a
 *    `scheduled` handler than that is not counted: that many reads are not
 *    worth it for a check that step 2 backs up.
 * 2. When Cloudflare refuses the schedule anyway (the count could not read
 *    every Worker, another tool added triggers in between, or the count was
 *    skipped), the "set cron triggers" step turns the refusal into a
 *    message that says what to do. An install fails there at once, and
 *    removes what it created (../install.ts). An update or rollback, whose
 *    version already serves, logs it as a warning and goes on: the Worker
 *    keeps the triggers it had and the job still checks the Worker's health
 *    and finishes.
 *
 * The count treats the account as on Workers Free unless there is evidence
 * otherwise: the plan detected or set as Workers Paid, the admin confirmed
 * Workers Paid for this job while Appflare does not know the plan
 * (`freeLimitsApply`), the app itself needs Workers Paid (installing it
 * asked for that confirmation), or the other Workers already use more than
 * 5 triggers, which a free account cannot have.
 */

const PAID_LIMIT = PAID_PLAN_CRON_TRIGGERS.toLocaleString("en-US");

/** Cloudflare's error code for "This account has reached the Workers Free limit of 5 cron triggers per account". */
export const CRON_LIMIT_ERROR_CODE = 10072;

/**
 * Workers whose schedule the count reads, at most, in the unit's own
 * invocation: the Worker list and 40 reads fit its 50 subrequests.
 */
export const CRON_SCAN_MAX_WORKERS = 40;

/** The same, when the unit runs in the job's own invocation (no `SELF` binding) and spends its budget. */
export const CRON_SCAN_MAX_WORKERS_LOCAL = 5;

/** What the count found: a total, or why it did not count. Plain data, so it crosses an RPC call. */
export type CronTriggerScan =
  | {
      kind: "counted";
      /** Cron triggers of every Worker read, the excluded one aside. */
      total: number;
      /** Workers with at least one trigger, most first. */
      byWorker: Array<{ worker: string; count: number }>;
      /** Workers whose schedule was read. */
      read: number;
      /**
       * Workers without a `scheduled` handler whose schedule was not read
       * (past the reads one count makes); 0 when every Worker was read.
       */
      unread?: number;
    }
  | { kind: "skipped"; reason: string };

/**
 * Counts the cron triggers of the account's Workers other than `exclude`:
 * one list call, then one schedule read per Worker, at most `maxWorkers` of
 * them: first each Worker that exports a `scheduled` handler (every Worker
 * when the list does not say), then the others as far as the reads go. A
 * Worker deleted between the two calls counts 0.
 */
export async function countAccountCronTriggers(
  api: CloudflareClient,
  opts: { exclude: string; maxWorkers: number },
): Promise<CronTriggerScan> {
  const scripts = (await api.workers.listScripts()).filter((s) => s.id !== opts.exclude);
  const scheduled = scripts.filter(
    (s) => s.handlers === undefined || s.handlers.includes("scheduled"),
  );
  if (scheduled.length > opts.maxWorkers) {
    return {
      kind: "skipped",
      reason: `the account has ${scheduled.length} Workers with scheduled handlers, more than the ${opts.maxWorkers} this check reads`,
    };
  }
  const rest = scripts.filter((s) => !scheduled.includes(s));
  const candidates = [...scheduled, ...rest.slice(0, opts.maxWorkers - scheduled.length)];
  const byWorker: Array<{ worker: string; count: number }> = [];
  let total = 0;
  for (const script of candidates) {
    let count = 0;
    try {
      count = (await api.workers.getSchedules(script.id)).schedules.length;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    total += count;
    if (count > 0) byWorker.push({ worker: script.id, count });
  }
  byWorker.sort((a, b) => b.count - a.count || a.worker.localeCompare(b.worker));
  return {
    kind: "counted",
    total,
    byWorker,
    read: candidates.length,
    unread: scripts.length - candidates.length,
  };
}

/** "second-brain: 2, appflare: 1", naming at most five Workers. */
function describeUsers(byWorker: ReadonlyArray<{ worker: string; count: number }>): string {
  const shown = byWorker.slice(0, 5).map((w) => `${w.worker}: ${w.count}`);
  const more = byWorker.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

export interface CronLimitCheck {
  /** Cron triggers the account's other Workers use. */
  others: Extract<CronTriggerScan, { kind: "counted" }>;
  /** Cron triggers the app's Worker will have. */
  wanted: number;
  /** "this app" or "this version", starting the message. */
  subject: string;
}

/**
 * The way out for an account that is on Workers Paid but not recorded as
 * such. It links to the Workers plan row on Your account rather than naming
 * a form field: a form shows the cron trigger confirmation only when it
 * knows the app's triggers, which a sandbox tier app's page does not before
 * the build.
 */
export const PAID_ALREADY = `If it is already on Workers Paid, choose that plan under ${messageLink("Workers plan in Your account", settingsLink("account", "capability-workers-plan"))}.`;

/**
 * Why the triggers would not fit a Workers Free account, or null when they
 * fit or the account evidently is not on the free limit.
 */
export function cronLimitRefusal(check: CronLimitCheck): string | null {
  const used = check.others.total;
  if (used > FREE_PLAN_CRON_TRIGGERS) return null;
  if (used + check.wanted <= FREE_PLAN_CRON_TRIGGERS) return null;
  const where = used === 0 ? "" : ` (${describeUsers(check.others.byWorker)})`;
  const total = used + check.wanted;
  const excess = total - FREE_PLAN_CRON_TRIGGERS;
  const remove =
    excess === 1
      ? "Remove a cron trigger from another Worker (for example by uninstalling an app that uses one)"
      : `Remove ${excess} cron triggers from other Workers (for example by uninstalling an app that uses them)`;
  return `${check.subject} needs ${cronTriggersPhrase(check.wanted)} and the account's other Workers already use ${used}${where}; Workers Free allows ${FREE_PLAN_CRON_TRIGGERS} per account, so this would make ${total}. ${remove}, or upgrade the account to Workers Paid (${PAID_LIMIT} per account). ${PAID_ALREADY} Then try again.`;
}

/** Whether Cloudflare refused a schedule because the account is at its cron trigger limit. */
export function isCronLimitError(error: unknown): error is CloudflareApiError {
  return (
    error instanceof CloudflareApiError &&
    error.errors.some(
      (e) => e.code === CRON_LIMIT_ERROR_CODE || /cron triggers per account/i.test(e.message),
    )
  );
}

/** Cloudflare refused a schedule at the account's cron trigger limit; never retried. */
export class CronLimitError extends JobError {
  override name = "CronLimitError";
}

/**
 * The job error for a refused schedule: the limit as Cloudflare stated it,
 * what to do, `after` (what state the Worker is left in) and `next` (how the
 * triggers get set once there is room). A `JobError`, so the step fails at
 * once: a retry meets the same limit.
 */
export function cronLimitError(
  error: CloudflareApiError,
  wanted: number,
  after: string,
  next = "then try again",
): CronLimitError {
  const stated = error.errors
    .map((e) => /limit of ([\d,]+) cron triggers/i.exec(e.message)?.[1]?.replaceAll(",", ""))
    .find((n) => n !== undefined);
  const limit = stated === undefined ? FREE_PLAN_CRON_TRIGGERS : Number(stated);
  const removeOne =
    "Remove a cron trigger from another Worker (for example by uninstalling an app that uses one)";
  // Workers Paid has a limit too, though a far higher one.
  if (limit > FREE_PLAN_CRON_TRIGGERS) {
    return new CronLimitError(
      `Cloudflare refused ${cronTriggersPhrase(wanted)}: this account has reached its limit of ${limit.toLocaleString("en-US")} cron triggers per account. ${after} ${removeOne}, ${next}.`,
    );
  }
  return new CronLimitError(
    `Cloudflare refused ${cronTriggersPhrase(wanted)}: this account has reached the Workers Free limit of ${limit} cron triggers per account. ${after} ${removeOne}, or upgrade the account to Workers Paid (${PAID_LIMIT} per account), ${next}.`,
  );
}

/**
 * Sets a Worker's whole schedule, turning Cloudflare's cron limit refusal
 * into {@link cronLimitError}. Any other error is passed on as is.
 */
export async function putSchedulesChecked(
  api: CloudflareClient,
  workerName: string,
  crons: readonly string[],
  after: string,
  next?: string,
): Promise<void> {
  try {
    await api.workers.putSchedules(
      workerName,
      crons.map((cron) => ({ cron })),
    );
  } catch (error) {
    if (isCronLimitError(error)) throw cronLimitError(error, crons.length, after, next);
    throw error;
  }
}

export interface CronLimitPhaseInput {
  /** The Worker whose schedule is set; its own current triggers are replaced, so not counted. */
  workerName: string;
  /** Distinct cron triggers the Worker will have. */
  wanted: number;
  /** Evidence the account is on Workers Paid: the check is skipped. */
  paid: boolean;
  subject: string;
}

/**
 * The step "check cron trigger limit". It refuses only on a count; when the
 * count cannot be made (a large account, an API error, a unit this version
 * of Appflare cannot reach) the job goes on and the "set cron triggers" step
 * reports Cloudflare's own refusal.
 */
export async function checkCronLimitPhase(
  steps: JobSteps,
  input: CronLimitPhaseInput,
): Promise<void> {
  if (input.wanted === 0 || input.paid) return;
  await steps.run("check cron trigger limit", async ({ log }) => {
    let scan: CronTriggerScan;
    try {
      scan = settleUnit(
        await steps.units.api.countCronTriggers({
          accountId: steps.accountId(),
          exclude: input.workerName,
          maxWorkers: steps.units.remote ? CRON_SCAN_MAX_WORKERS : CRON_SCAN_MAX_WORKERS_LOCAL,
        }),
        log,
      );
    } catch (error) {
      log.warn(
        `Could not count the account's cron triggers (${errorMessage(error)}); going on, and Cloudflare checks the limit when the cron triggers are set.`,
      );
      return {};
    }
    if (scan.kind === "skipped") {
      log.info(
        `Did not count the account's cron triggers: ${scan.reason}. Cloudflare checks the limit when the cron triggers are set.`,
      );
      return {};
    }
    const refusal = cronLimitRefusal({
      others: scan,
      wanted: input.wanted,
      subject: input.subject,
    });
    if (refusal !== null) throw new JobError(refusal);
    log.info(
      scan.total > FREE_PLAN_CRON_TRIGGERS
        ? `The account's other Workers use ${cronTriggersPhrase(scan.total)}, more than Workers Free allows, so the account is not on the free limit.`
        : `The account's other Workers use ${cronTriggersPhrase(scan.total)}; with ${input.wanted} more that is ${scan.total + input.wanted} of the ${FREE_PLAN_CRON_TRIGGERS} Workers Free allows.`,
    );
    const unread = scan.unread ?? 0;
    if (unread > 0 && scan.total <= FREE_PLAN_CRON_TRIGGERS) {
      log.info(
        `${unread} Worker(s) without a scheduled handler were not read; Cloudflare checks the limit when the cron triggers are set.`,
      );
    }
    return {};
  });
}
