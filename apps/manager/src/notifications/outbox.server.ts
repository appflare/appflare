import { ulid } from "ulidx";
import { createDb } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import { workersDevUrl } from "../installs/post-install";
import { type NotificationFacts, notificationFactsSchema } from "./messages";
import type { ChannelKind, NotificationEvent } from "./schema";
import type { SendOutcome } from "./send";

/**
 * The notification outbox in D1. An event is written once (its dedupe key);
 * each channel that wants it gets one delivery row, which the delivery unit
 * claims, attempts, and settles: sent, retried later with backoff, or failed
 * for good. Claims are leases (a `sending` row whose time ran out is due
 * again), so two runs never send the same delivery at once and a run that
 * died mid-way does not strand one.
 */

/** Attempts per delivery before it is given up. */
export const MAX_ATTEMPTS = 5;
/** Wait after the 1st, 2nd, ... failed attempt; the cron runs every 30 minutes. */
export const RETRY_BACKOFF_MS = [60_000, 10 * 60_000, 30 * 60_000, 2 * 3_600_000] as const;
/** How long a claim holds a delivery. */
export const CLAIM_LEASE_MS = 2 * 60_000;
/** A delivery still not sent after this long is given up. */
export const DELIVERY_EXPIRY_MS = 24 * 3_600_000;
/** Settled job events older than this are deleted. */
export const JOB_EVENT_RETENTION_MS = 30 * 86_400_000;

/**
 * `settings` rows this module owns (like the lock rows other modules own,
 * they are not in `SETTING`): the manager's URL as an admin last used it,
 * and the cursor of the finished-jobs sweep.
 */
export const MANAGER_URL_KEY = "notification_manager_url";
export const JOBS_CURSOR_KEY = "notification_jobs_cursor";
/** `notification_health:<installId>`: when the install's current failing episode began (epoch ms). */
export const HEALTH_EPISODE_PREFIX = "notification_health:";

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  events: NotificationEvent[];
  createdAt: number;
}

function parseEvents(json: string): NotificationEvent[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? (value.filter((e) => typeof e === "string") as NotificationEvent[])
      : [];
  } catch {
    return [];
  }
}

export async function readChannels(db: D1Database): Promise<ChannelRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, kind, events_json, created_at FROM notification_channels ORDER BY created_at",
    )
    .all<{ id: string; kind: ChannelKind; events_json: string; created_at: number }>();
  return results.map((r) => ({
    id: r.id,
    kind: r.kind,
    events: parseEvents(r.events_json),
    createdAt: r.created_at,
  }));
}

/** Whether any channel receives this event. */
export function wants(channels: readonly ChannelRow[], type: NotificationEvent): boolean {
  return channels.some((c) => c.events.includes(type));
}

/**
 * The manager's URL for links: the origin an admin last managed channels
 * from, else the Cloudflare Access hostname, else its workers.dev URL.
 */
export async function managerUrl(db: D1Database): Promise<string | null> {
  const stored = await db
    .prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(MANAGER_URL_KEY)
    .first<{ value: string }>();
  if (stored !== null) return stored.value;
  const s = await readSettings(createDb(db), [
    SETTING.accessDomain,
    SETTING.workerName,
    SETTING.accountSubdomain,
  ]);
  if (s.access_domain) return `https://${s.access_domain}`;
  return s.worker_name ? workersDevUrl(s.worker_name, s.account_subdomain) : null;
}

/** Remembers the origin an admin uses, so cron and job messages link to the same place. */
export async function rememberManagerUrl(
  db: D1Database,
  origin: string,
  now: number,
): Promise<void> {
  const url = new URL(origin);
  if (url.protocol !== "https:" && url.hostname !== "localhost") return;
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE settings.value <> excluded.value`,
    )
    .bind(MANAGER_URL_KEY, url.origin, now)
    .run();
}

export interface EmitInput {
  type: NotificationEvent;
  dedupeKey: string;
  facts: NotificationFacts;
  occurredAt: number;
  /** Only channels created at or before this time get it (a finished job's end). */
  channelsCreatedBy?: number;
}

/**
 * Records an event and a delivery for every channel that receives it and
 * does not have one yet. Nothing is written when no channel wants it, so a
 * channel added later still hears about a condition that holds then.
 * Returns the event id, or null when no channel wants it.
 */
export async function emitEvent(
  db: D1Database,
  channels: readonly ChannelRow[],
  input: EmitInput,
  now: number,
): Promise<{ eventId: string | null; queued: number }> {
  const targets = channels.filter(
    (c) =>
      c.events.includes(input.type) &&
      (input.channelsCreatedBy === undefined || c.createdAt <= input.channelsCreatedBy),
  );
  if (targets.length === 0) return { eventId: null, queued: 0 };
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO notification_events (id, type, dedupe_key, facts_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(dedupe_key) DO NOTHING`,
      )
      .bind(ulid(now), input.type, input.dedupeKey, JSON.stringify(input.facts), input.occurredAt),
    ...targets.map((c) =>
      db
        .prepare(
          `INSERT INTO notification_deliveries
             (event_id, channel_id, status, attempts, next_attempt_at, created_at, updated_at)
           SELECT e.id, ?2, 'pending', 0, ?3, ?3, ?3 FROM notification_events e
           WHERE e.dedupe_key = ?1
           ON CONFLICT(event_id, channel_id) DO NOTHING`,
        )
        .bind(input.dedupeKey, c.id, now),
    ),
    db.prepare("SELECT id FROM notification_events WHERE dedupe_key = ?1").bind(input.dedupeKey),
  ]);
  const queued = results.slice(1, -1).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  const row = (results.at(-1)?.results ?? [])[0] as { id: string } | undefined;
  return { eventId: row?.id ?? null, queued };
}

export interface ClaimedDelivery {
  eventId: string;
  channelId: string;
  /** Attempts before this one. */
  attempts: number;
  facts: NotificationFacts | null;
  occurredAt: number;
  channel: { kind: ChannelKind; config: string } | null;
}

/**
 * Claims up to `limit` due deliveries (optionally of one event) for
 * `CLAIM_LEASE_MS`, oldest first, and returns them with their event and
 * channel. Deliveries older than `DELIVERY_EXPIRY_MS` are given up first.
 */
export async function claimDue(
  db: D1Database,
  opts: { now: number; limit: number; eventId?: string },
): Promise<ClaimedDelivery[]> {
  const { now, limit } = opts;
  await db
    .prepare(
      `UPDATE notification_deliveries
       SET status = 'failed', last_error = 'not delivered within 24 hours', updated_at = ?1
       WHERE status IN ('pending', 'sending') AND created_at < ?2`,
    )
    .bind(now, now - DELIVERY_EXPIRY_MS)
    .run();
  const eventFilter = opts.eventId === undefined ? "" : "AND event_id = ?4";
  const claim = db.prepare(
    `UPDATE notification_deliveries
     SET status = 'sending', next_attempt_at = ?2, updated_at = ?1
     WHERE rowid IN (
       SELECT rowid FROM notification_deliveries
       WHERE status IN ('pending', 'sending') AND next_attempt_at <= ?1 ${eventFilter}
       ORDER BY next_attempt_at LIMIT ?3)
     RETURNING event_id, channel_id, attempts`,
  );
  const bound =
    opts.eventId === undefined
      ? claim.bind(now, now + CLAIM_LEASE_MS, limit)
      : claim.bind(now, now + CLAIM_LEASE_MS, limit, opts.eventId);
  const { results: claimed } = await bound.all<{
    event_id: string;
    channel_id: string;
    attempts: number;
  }>();
  if (claimed.length === 0) return [];
  const eventIds = [...new Set(claimed.map((c) => c.event_id))];
  const channelIds = [...new Set(claimed.map((c) => c.channel_id))];
  const [events, channels] = await db.batch([
    db
      .prepare(
        `SELECT id, facts_json, occurred_at FROM notification_events
         WHERE id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(eventIds)),
    db
      .prepare(
        `SELECT id, kind, config FROM notification_channels
         WHERE id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(channelIds)),
  ]);
  const eventById = new Map(
    ((events?.results ?? []) as { id: string; facts_json: string; occurred_at: number }[]).map(
      (e) => [e.id, e],
    ),
  );
  const channelById = new Map(
    ((channels?.results ?? []) as { id: string; kind: ChannelKind; config: string }[]).map((c) => [
      c.id,
      c,
    ]),
  );
  return claimed.map((c) => {
    const event = eventById.get(c.event_id);
    const channel = channelById.get(c.channel_id);
    let facts: NotificationFacts | null = null;
    if (event !== undefined) {
      try {
        const parsed = notificationFactsSchema.safeParse(JSON.parse(event.facts_json));
        facts = parsed.success ? parsed.data : null;
      } catch {
        facts = null;
      }
    }
    return {
      eventId: c.event_id,
      channelId: c.channel_id,
      attempts: c.attempts,
      facts,
      occurredAt: event?.occurred_at ?? now,
      channel: channel === undefined ? null : { kind: channel.kind, config: channel.config },
    };
  });
}

export type Settled = "sent" | "retrying" | "failed";

/** When a failed attempt is tried again, or null when it is given up. */
export function nextAttempt(
  attemptsBefore: number,
  outcome: Extract<SendOutcome, { ok: false }>,
  now: number,
): number | null {
  const made = attemptsBefore + 1;
  if (!outcome.retryable || made >= MAX_ATTEMPTS) return null;
  const backoff = RETRY_BACKOFF_MS[Math.min(made - 1, RETRY_BACKOFF_MS.length - 1)] ?? 0;
  return now + Math.max(backoff, outcome.retryAfterMs ?? 0);
}

/**
 * Settles one attempt: the delivery's row, and the channel's failure counter
 * (reset by a success, raised by each failure).
 */
export async function settleAttempt(
  db: D1Database,
  delivery: Pick<ClaimedDelivery, "eventId" | "channelId" | "attempts">,
  outcome: SendOutcome,
  now: number,
): Promise<Settled> {
  const channelUpdate = outcome.ok
    ? db
        .prepare(
          `UPDATE notification_channels SET failure_count = 0, last_success_at = ?2
           WHERE id = ?1`,
        )
        .bind(delivery.channelId, now)
    : db
        .prepare(
          `UPDATE notification_channels
           SET failure_count = failure_count + 1, last_error = ?2, last_failure_at = ?3
           WHERE id = ?1`,
        )
        .bind(delivery.channelId, outcome.error, now);
  let settled: Settled;
  let deliveryUpdate: D1PreparedStatement;
  const key = [delivery.eventId, delivery.channelId];
  if (outcome.ok) {
    settled = "sent";
    deliveryUpdate = db
      .prepare(
        `UPDATE notification_deliveries
         SET status = 'sent', attempts = attempts + 1, sent_at = ?3, last_error = NULL, updated_at = ?3
         WHERE event_id = ?1 AND channel_id = ?2`,
      )
      .bind(...key, now);
  } else {
    const next = nextAttempt(delivery.attempts, outcome, now);
    settled = next === null ? "failed" : "retrying";
    deliveryUpdate = db
      .prepare(
        `UPDATE notification_deliveries
         SET status = ?3, attempts = attempts + 1, next_attempt_at = ?4, last_error = ?5, updated_at = ?6
         WHERE event_id = ?1 AND channel_id = ?2`,
      )
      .bind(...key, next === null ? "failed" : "pending", next ?? now, outcome.error, now);
  }
  await db.batch([deliveryUpdate, channelUpdate]);
  return settled;
}

/** Deletes job events (and their deliveries) that are settled and older than the retention. */
export async function pruneOutbox(db: D1Database, now: number): Promise<void> {
  const old = `SELECT id FROM notification_events
    WHERE dedupe_key LIKE 'job:%' AND occurred_at < ?1
      AND NOT EXISTS (SELECT 1 FROM notification_deliveries d
        WHERE d.event_id = notification_events.id AND d.status IN ('pending', 'sending'))`;
  await db.batch([
    db
      .prepare(`DELETE FROM notification_deliveries WHERE event_id IN (${old})`)
      .bind(now - JOB_EVENT_RETENTION_MS),
    db
      .prepare(`DELETE FROM notification_events WHERE id IN (${old})`)
      .bind(now - JOB_EVENT_RETENTION_MS),
  ]);
}
