import type { JobContext, StepConfig } from "../jobs/run-job";
import { StepLog } from "../jobs/step-log";
import { jobEventOf, NOTIFIED_JOB_KINDS } from "./events.server";
import { emitEvent, readChannels } from "./outbox.server";
import { selfNotificationUnits } from "./units";

/**
 * A job's last step: tell the channels that want it that the job ended.
 * Runs after the job's own handler settled the job row, whether it
 * succeeded or failed, and never changes the job's outcome.
 *
 * It records the event and its deliveries, then asks the delivery unit over
 * `SELF` to send them: one subrequest for the job, the sends themselves in
 * the unit's own invocation. What the unit could not send is retried by the
 * scheduled run. A manager without `SELF` only records them and leaves the
 * sending to the scheduled run, so a job never spends its own subrequests on
 * notifications.
 *
 * A self-update never gets here: nothing may run after its promotion but its
 * own last step, and no event is about it.
 */

export const NOTIFY_STEP_NAME = "notify channels";
const NOTIFY_STEP: StepConfig = { retries: { limit: 2, delay: "5 seconds", backoff: "constant" } };

interface NotifyResult {
  queued: number;
  sent: number;
  retrying: number;
  failed: number;
  remote: boolean;
}

export async function notifyJobEnd(ctx: JobContext): Promise<void> {
  const { params, step, env, deps } = ctx;
  if (!NOTIFIED_JOB_KINDS.has(params.kind)) return;
  const now = deps.now ?? Date.now;
  try {
    // Outside a step, and repeated by every replay: no step is recorded
    // unless a channel exists and the job row is settled. If the engine
    // unwinds the run early (a suspension, an error thrown mid-job), the job
    // is still running here, so no "notify channels" step result is cached
    // before the real end; the one that runs at the end is the only one.
    // Even run twice, it cannot send twice: the event is keyed `job:<id>` and
    // each channel gets one delivery per event (outbox.server.ts).
    const gate = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM notification_channels) AS channels,
              (SELECT status FROM jobs WHERE id = ?1) AS status`,
    )
      .bind(params.jobId)
      .first<{ channels: number; status: string | null }>();
    if (gate === null || gate.channels === 0) return;
    if (gate.status !== "succeeded" && gate.status !== "failed") return;
    await step.do(NOTIFY_STEP_NAME, NOTIFY_STEP, async (): Promise<NotifyResult> => {
      const result: NotifyResult = { queued: 0, sent: 0, retrying: 0, failed: 0, remote: false };
      const event = await jobEventOf(env.DB, params.jobId);
      if (event === null) return result;
      const channels = await readChannels(env.DB);
      const { eventId, queued } = await emitEvent(env.DB, channels, event, now());
      result.queued = queued;
      if (eventId === null || queued === 0) return result;
      const log = new StepLog(now);
      const units = selfNotificationUnits(env);
      if (units === undefined) {
        log.info(
          `Queued ${queued} notification${queued === 1 ? "" : "s"}; the next scheduled run sends ${queued === 1 ? "it" : "them"}.`,
        );
      } else {
        result.remote = true;
        let sent: Awaited<ReturnType<typeof units.deliverNotifications>>;
        try {
          sent = await units.deliverNotifications({ eventId });
        } catch (error) {
          sent = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (sent.ok) {
          result.sent = sent.value.sent;
          result.retrying = sent.value.retrying;
          result.failed = sent.value.failed;
          const parts = [
            `Notified ${sent.value.sent} of ${queued} channel${queued === 1 ? "" : "s"}.`,
          ];
          if (sent.value.retrying > 0) parts.push(`${sent.value.retrying} will be retried.`);
          if (sent.value.failed > 0) {
            parts.push(`${sent.value.failed} failed; Settings, Notification channels says why.`);
          }
          log.log(sent.value.failed > 0 ? "warn" : "info", parts.join(" "));
        } else {
          log.warn("Notifications could not be sent now; the next scheduled run retries them.");
        }
      }
      await log.flush(env.DB, params.jobId);
      return result;
    });
  } catch (error) {
    // Notifications never fail a job; the scheduled run's sweep catches up.
    console.warn("job-end notifications failed", {
      jobId: params.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
