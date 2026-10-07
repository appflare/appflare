import { NonRetryableError } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { AccessToggleError, checkAccessMove } from "../access/toggle.server";
import { requireConnection } from "../cloudflare/connection.server";
import { createDb } from "../db/client";
import { jobs } from "../db/schema";
import { readSettings, SETTING } from "../db/settings";
import { handoffHashOf } from "../handoff/handoff-proof";
import { detachMessage } from "../installs/custom-domains.server";
import type { JobContext, StepConfig, StepRunner } from "../jobs/run-job";
import { StepLog } from "../jobs/step-log";
import { createJobSteps, errorMessage, JobError, type JobSteps } from "../jobs/steps";
import {
  completeAddressMove,
  detachQuietly,
  readAttachedBy,
  readManagerDomain,
} from "./manager-address.server";
import { identityVerdict } from "./manager-identity";
import { MOVE_FAILURES, MOVE_LINES, MOVE_STEPS, MOVE_WAIT_MS } from "./move-address-lines";

/**
 * The `move_address` job: Appflare moves to a custom domain that the
 * request starting it has checked and attached to the manager's own Worker
 * (manager-address.server.ts). Until the switch, the address people use
 * keeps serving.
 *
 * 1. Wait for the certificate and the new address, until it answers as this
 *    Appflare (`identityVerdict`: its health report with this version, and on a
 *    manager installed from the browser its handoff proof). A new domain's
 *    certificate commonly takes one to several minutes, so the job probes
 *    with a growing wait between probes (`step.sleep`) for up to 15 minutes,
 *    and logs a line about once a minute while it waits.
 * 2. Moving Cloudflare Access (when it is on): checked again, since the
 *    token or the applications may have changed during the wait.
 * 3. Switching the address: the rows, Access, the passkeys and the
 *    remembered manager URL, in one go (`completeAddressMove`).
 * 4. Detaching the old domain, after a change from one domain to another.
 *
 * A move that fails leaves the new domain attached to the manager's Worker:
 * detaching it would not bring back DNS records it replaced, and the admin
 * starts the move again from the Domains settings, which uses it.
 *
 * Subrequests, all in this job's invocation (no sleep reaches the 5 minutes
 * that start a fresh one): at most 24 probes, 1 Access check, up to 4 Access
 * updates and 1 workers.dev subdomain read in the switch, up to 2 calls to
 * detach, and the notification call: 33 fetches. D1: the start, a log write
 * at most once a minute of the wait (16), the switch, the end. D1 binding
 * calls did not count toward the limit when it was measured.
 */

export const moveAddressJobParams = z.object({
  kind: z.literal("move_address"),
  jobId: z.string().min(1),
  /** The custom domain Appflare moves to, attached by the request. */
  hostname: z.string().min(1),
  zoneId: z.string().min(1),
  /** Cloudflare's id of the attached domain. */
  domainId: z.string().min(1),
  /** The version the new address must report: the one running when the move started. */
  version: z.string().min(1),
  /** A change: the custom domain Appflare leaves, detached once it has switched. */
  from: z.object({ hostname: z.string().min(1), domainId: z.string().nullable() }).nullable(),
});
export type MoveAddressJobParams = z.infer<typeof moveAddressJobParams>;

/**
 * Waits after each probe, in seconds: quick at first, while a certificate is
 * most likely to arrive, then once a minute. 24 probes fit the 15 minutes.
 */
const PROBE_DELAYS_SECONDS = [5, 5, 10, 10, 15, 15, 20, 20, 30, 30, 30, 30] as const;
const LATE_DELAY_SECONDS = 60;

/** The wait in seconds after the `attempt`th probe (1-based). */
export function moveProbeDelaySeconds(attempt: number): number {
  return PROBE_DELAYS_SECONDS[attempt - 1] ?? LATE_DELAY_SECONDS;
}

/** The waits scheduled before the `attempt`th probe, in milliseconds. */
function scheduledMs(attempt: number): number {
  let total = 0;
  for (let a = 1; a < attempt; a++) total += moveProbeDelaySeconds(a) * 1000;
  return total;
}

/**
 * The wait before the next probe, or null when it would pass the 15
 * minutes. `elapsedMs` (since the first probe) never counts less than the
 * waits already scheduled, so the wait also ends when the clock stands still.
 */
export function nextProbeDelaySeconds(attempt: number, elapsedMs: number): number | null {
  const delay = moveProbeDelaySeconds(attempt);
  const elapsed = Math.max(elapsedMs, scheduledMs(attempt));
  return elapsed + delay * 1000 > MOVE_WAIT_MS ? null : delay;
}

/** A "not answering yet" line at most this often. */
const LOG_EVERY_MS = 60_000;

/** One probe: its time, and what the answer was when it was not this Appflare. */
interface ProbeResult {
  at: number;
  /** Null when the new address answered as this Appflare. */
  last: string | null;
  logged: boolean;
}

/** A probe is one fetch that never throws; a failed log write is its only retry. */
const PROBE_STEP: StepConfig = { retries: { limit: 1, delay: "2 seconds" } };

async function waitForAddress(
  steps: JobSteps,
  step: StepRunner,
  target: { hostname: string; version: string; handoffHash: string | null },
): Promise<{ ok: true } | { ok: false; last: string }> {
  let firstAt: number | null = null;
  let loggedAt: number | null = null;
  for (let attempt = 1; ; attempt++) {
    const probed = await steps.run(
      `${MOVE_STEPS.wait} (check ${attempt})`,
      async ({ log, fetch }): Promise<ProbeResult> => {
        const at = steps.now();
        if (attempt === 1) log.info(MOVE_LINES.waiting(target.hostname, target.version));
        // "Answers as this Appflare": see identityVerdict for exactly what is checked.
        const last = await identityVerdict(fetch, target.hostname, target);
        if (last === null) {
          log.info(MOVE_LINES.answers(target.hostname));
          return { at, last, logged: true };
        }
        const due = loggedAt !== null && at - loggedAt >= LOG_EVERY_MS;
        if (due) log.info(MOVE_LINES.notYet(last));
        return { at, last, logged: attempt === 1 || due };
      },
      PROBE_STEP,
    );
    firstAt ??= probed.at;
    if (probed.logged) loggedAt = probed.at;
    if (probed.last === null) return { ok: true };
    const delay = nextProbeDelaySeconds(attempt, probed.at - firstAt);
    if (delay === null) return { ok: false, last: probed.last };
    await step.sleep(`${MOVE_STEPS.wait} (wait ${attempt})`, `${delay} seconds`);
  }
}

export async function runMoveAddress(ctx: JobContext): Promise<void> {
  const parsed = moveAddressJobParams.safeParse(ctx.params);
  if (!parsed.success) throw new NonRetryableError("invalid move job payload");
  const params = parsed.data;
  const { step, env, deps } = ctx;
  const now = deps.now ?? Date.now;
  const steps = createJobSteps(ctx, params.jobId);
  const { run } = steps;
  const { hostname } = params;
  /** Whether the new domain replaced DNS records, for the failure message. */
  let replacedRecords = false;
  let switched = false;
  let reason: string;

  try {
    const started = await run("start", async ({ log, orm }) => {
      await orm
        .update(jobs)
        .set({ status: "running", started_at: new Date(now()) })
        .where(eq(jobs.id, params.jobId));
      const settings = await readSettings(orm, [SETTING.accountId, SETTING.workerName]);
      if (!settings.account_id) throw new JobError("the Cloudflare account is not known yet");
      if (!settings.worker_name) throw new JobError("Appflare does not know its own Worker yet");
      // An API token, or a stored grant that does not need reconnecting.
      await requireConnection(env);
      log.info(MOVE_LINES.start(hostname, params.from?.hostname ?? null));
      return {
        accountId: settings.account_id,
        workerName: settings.worker_name,
        replacedRecords: (await readAttachedBy(env.DB, hostname)) === "appflare-replaced-records",
      };
    });
    steps.setAccountId(started.accountId);
    replacedRecords = started.replacedRecords;

    // 1. The new address answers as this Appflare.
    const waited = await waitForAddress(steps, step, {
      hostname,
      version: params.version,
      handoffHash: handoffHashOf(env.APPFLARE_HANDOFF),
    });
    if (!waited.ok) {
      reason = MOVE_FAILURES.neverAnswered(hostname, waited.last, replacedRecords);
    } else {
      // 2. Access, checked again before anything changes.
      await run(MOVE_STEPS.access, async ({ log, cf }) => {
        const access = await asJobError(() =>
          checkAccessMove({ db: env.DB, client: cf() }, hostname),
        );
        // Protection of the new hostname already (it was the address people used) moves nothing.
        const moves = access !== null && access.domain.toLowerCase() !== hostname;
        if (moves) log.info(MOVE_LINES.access(hostname));
        return { moves };
      });

      // 3. The switch.
      await run(MOVE_STEPS.switch, async ({ log, cf }) => {
        const done = await asJobError(() =>
          completeAddressMove(
            { db: env.DB, api: cf(), now: () => new Date(now()) },
            {
              hostname,
              domainId: params.domainId,
              zoneId: params.zoneId,
              workerName: started.workerName,
            },
          ),
        );
        if (done.accessMoved) log.info(MOVE_LINES.accessMoved(hostname));
        log.info(MOVE_LINES.switched(hostname, done.from));
        return { from: done.from };
      });
      switched = true;

      // 4. The domain a change leaves.
      const left = params.from;
      if (left !== null && left.hostname !== hostname) {
        await run(MOVE_STEPS.detach, async ({ log, cf }) => {
          log.info(MOVE_LINES.detach(left.hostname));
          const outcome = await detachQuietly(cf(), {
            hostname: left.hostname,
            cfId: left.domainId,
            workerName: started.workerName,
          });
          if (outcome === "failed") log.warn(MOVE_LINES.detachFailed(left.hostname));
          else log.info(detachMessage(left.hostname, outcome));
          return { outcome };
        });
      }

      await run("finish", async ({ log, orm }) => {
        await orm
          .update(jobs)
          .set({ status: "succeeded", finished_at: new Date(now()), error: null })
          .where(eq(jobs.id, params.jobId));
        log.info(MOVE_LINES.done(hostname));
        return {};
      });
      return;
    }
  } catch (error) {
    // A step can fail after its switch committed (a write that follows it
    // failed on every attempt): the rows then already name the new address.
    if (!switched) {
      const domain = await readManagerDomain(env.DB).catch(() => null);
      switched = domain?.hostname === hostname;
    }
    reason = switched
      ? MOVE_FAILURES.afterSwitch(steps.current, errorMessage(error), hostname)
      : MOVE_FAILURES.stopped(steps.current, errorMessage(error), hostname, replacedRecords);
  }

  const failure = reason;
  await step.do("mark move failed", async () => {
    await createDb(env.DB)
      .update(jobs)
      .set({ status: "failed", error: failure, finished_at: new Date(now()) })
      .where(eq(jobs.id, params.jobId));
    const log = new StepLog(now);
    log.error(failure);
    await log.flush(env.DB, params.jobId);
    return {};
  });
  throw new NonRetryableError(failure);
}

/** An Access refusal ends the job in Access's own words; nothing retries it. */
async function asJobError<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof AccessToggleError) throw new JobError(error.message);
    throw error;
  }
}
