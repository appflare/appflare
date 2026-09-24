import type { FetchLike } from "@appflare/cf-api";
import { ChannelKeyError, channelKey, decryptConfig } from "./crypto";
import {
  type ClaimedDelivery,
  claimDue,
  managerUrl,
  type Settled,
  settleAttempt,
} from "./outbox.server";
import { type SendOutcome, sendToChannel } from "./send";

/**
 * Works through due deliveries: claims a batch, reads each channel's
 * credentials, sends, and settles every attempt. One attempt is one request,
 * plus one quick retry in the same call when the service failed in a way a
 * retry may fix and did not ask for a long wait; later retries happen on
 * later calls, with backoff (outbox.server.ts).
 *
 * Runs as the `deliverNotifications` job unit, so its requests use a fresh
 * invocation's subrequest limit instead of the job's or the cron's. Per
 * delivery: at most two requests and one D1 batch; with the claim and the
 * lookups, `DELIVERIES_PER_CALL` deliveries stay under 50 even if D1 calls
 * counted toward the limit.
 */

export const DELIVERIES_PER_CALL = 12;
/** The quick retry waits this long, or as long as the service asked if that is shorter than the cap. */
export const QUICK_RETRY_MS = 2_000;
const QUICK_RETRY_CAP_MS = 5_000;

export interface DeliverEnv {
  DB: D1Database;
  /** The secret the credentials key is derived from (crypto.ts). */
  BETTER_AUTH_SECRET?: string;
}

export interface DeliverDeps {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryReport {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
}

export interface DeliverOptions {
  /** Only this event's deliveries (a job's end). */
  eventId?: string;
  limit?: number;
}

const UNREADABLE: SendOutcome = {
  ok: false,
  retryable: false,
  error: "the stored credentials cannot be read; enter them again",
};

export async function deliverDue(
  env: DeliverEnv,
  deps: DeliverDeps = {},
  opts: DeliverOptions = {},
): Promise<DeliveryReport> {
  const now = deps.now ?? Date.now;
  const fetchFn: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const claimed = await claimDue(env.DB, {
    now: now(),
    limit: Math.min(opts.limit ?? DELIVERIES_PER_CALL, DELIVERIES_PER_CALL),
    ...(opts.eventId === undefined ? {} : { eventId: opts.eventId }),
  });
  const report: DeliveryReport = { claimed: claimed.length, sent: 0, retrying: 0, failed: 0 };
  if (claimed.length === 0) return report;

  let key: CryptoKey | null;
  try {
    key = await channelKey(env.BETTER_AUTH_SECRET);
  } catch (error) {
    if (!(error instanceof ChannelKeyError)) throw error;
    key = null;
  }
  const url = await managerUrl(env.DB);

  async function attempt(delivery: ClaimedDelivery): Promise<SendOutcome> {
    if (delivery.facts === null || delivery.channel === null || key === null) return UNREADABLE;
    const config = await decryptConfig(key, delivery.channelId, delivery.channel.config);
    if (config === null) return UNREADABLE;
    const message = {
      id: delivery.eventId,
      facts: delivery.facts,
      occurredAt: delivery.occurredAt,
      managerUrl: url,
    };
    const first = await sendToChannel(config, message, { fetch: fetchFn, now });
    if (first.ok || !first.retryable || (first.retryAfterMs ?? 0) > QUICK_RETRY_CAP_MS) {
      return first;
    }
    await sleep(Math.max(QUICK_RETRY_MS, first.retryAfterMs ?? 0));
    return sendToChannel(config, message, { fetch: fetchFn, now });
  }

  const settled = await Promise.all(
    claimed.map(async (delivery): Promise<Settled> => {
      const outcome = await attempt(delivery);
      return settleAttempt(env.DB, delivery, outcome, now());
    }),
  );
  for (const s of settled) {
    if (s === "sent") report.sent++;
    else if (s === "retrying") report.retrying++;
    else report.failed++;
  }
  return report;
}
