import { DELIVERIES_PER_CALL } from "./deliver.server";
import { detectConditions, sweepFinishedJobs } from "./events.server";
import { HEALTH_CHECKS_PER_CALL, installsToCheck } from "./health-sweep.server";
import { pruneOutbox, readChannels, wants } from "./outbox.server";
import {
  createNotificationUnits,
  type NotificationUnitsApi,
  type NotificationUnitsDeps,
  selfNotificationUnits,
} from "./units";

/**
 * The scheduled run's notification pass, after the catalog and the release
 * feed were refreshed. With no channel it reads one table and stops.
 * Otherwise, in order:
 *
 * 1. while a channel wants "Health check failing": probe installed apps,
 *    least recently checked first, in batches through the health unit;
 * 2. record the conditions that hold (update available, Appflare update
 *    available, health failing) and any finished job without its event;
 * 3. deliver what is due through the delivery unit, a few calls at most;
 *    the rest waits for the next run;
 * 4. delete settled job events past their retention.
 *
 * Over `SELF` each unit call costs this invocation one subrequest; without
 * it the units run here, one call each, to stay inside the cron's own limit.
 */

/** Unit calls per run with `SELF` (each is one subrequest here). */
export const MAX_HEALTH_CALLS = 4;
export const MAX_DELIVERY_CALLS = 3;

export interface NotificationsCronEnv {
  DB: D1Database;
  KV: KVNamespace;
  APPFLARE_VERSION: string;
  BETTER_AUTH_SECRET?: string;
  SELF?: unknown;
}

export type NotificationsOutcome =
  | { status: "idle" }
  | {
      status: "ran";
      checked: number;
      queued: number;
      sent: number;
      retrying: number;
      failed: number;
    }
  | { status: "failed"; reason: string };

export async function runNotifications(
  env: NotificationsCronEnv,
  deps: NotificationUnitsDeps = {},
): Promise<NotificationsOutcome> {
  const now = deps.now ?? Date.now;
  try {
    const channels = await readChannels(env.DB);
    if (channels.length === 0) return { status: "idle" };
    const self = selfNotificationUnits(env);
    const units: NotificationUnitsApi = self ?? createNotificationUnits(env, deps);
    const healthCalls = self === undefined ? 1 : MAX_HEALTH_CALLS;
    const deliveryCalls = self === undefined ? 1 : MAX_DELIVERY_CALLS;
    const out = { status: "ran" as const, checked: 0, queued: 0, sent: 0, retrying: 0, failed: 0 };

    const failing = new Set<string>();
    if (wants(channels, "health_failing")) {
      const ids = await installsToCheck(env.DB, HEALTH_CHECKS_PER_CALL * healthCalls);
      for (let i = 0; i < ids.length; i += HEALTH_CHECKS_PER_CALL) {
        const result = await units.checkInstallsHealth({
          installIds: ids.slice(i, i + HEALTH_CHECKS_PER_CALL),
        });
        if (result.ok) {
          out.checked += result.value.checked;
          for (const id of result.value.unhealthyIds) failing.add(id);
        } else console.warn("scheduled health check failed", { error: result.error });
      }
    }

    out.queued += await detectConditions(env, channels, now(), failing);
    out.queued += await sweepFinishedJobs(env.DB, channels, now());

    for (let call = 0; call < deliveryCalls; call++) {
      const result = await units.deliverNotifications({});
      if (!result.ok) {
        console.warn("notification delivery failed", { error: result.error });
        break;
      }
      out.sent += result.value.sent;
      out.retrying += result.value.retrying;
      out.failed += result.value.failed;
      if (result.value.claimed < DELIVERIES_PER_CALL) break;
    }

    await pruneOutbox(env.DB, now());
    return out;
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The scheduled handler's call: runs the pass and logs one line. Never throws. */
export async function scheduledNotifications(env: NotificationsCronEnv): Promise<void> {
  const outcome = await runNotifications(env);
  if (outcome.status === "failed") {
    console.error("notifications failed", { reason: outcome.reason });
  } else if (outcome.status === "ran" && outcome.sent + outcome.retrying + outcome.failed > 0) {
    console.log(
      `notifications: ${outcome.sent} sent, ${outcome.retrying} to retry, ${outcome.failed} failed`,
    );
  }
}
