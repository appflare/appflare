import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Notification tables, re-exported by db/schema.ts so drizzle-kit sees them.
 * Timestamps are integer epoch milliseconds, like every other table.
 *
 * - `notification_channels`: where messages go. `config` holds the channel's
 *   credentials (a Telegram bot token, a webhook URL, a signing secret)
 *   encrypted with AES-GCM (notifications/crypto.ts); nothing else in the
 *   row is secret.
 * - `notification_events`: one row per thing worth telling (an update
 *   became available, a job ended, ...). `dedupe_key` makes each one happen
 *   once: per install and version, per health episode, per job.
 * - `notification_deliveries`: one row per event and channel, the outbox the
 *   delivery unit works through, with retries. A channel hears about each
 *   event at most once.
 */

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const CHANNEL_KINDS = ["telegram", "slack", "discord", "webhook"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const NOTIFICATION_EVENTS = [
  "update_available",
  "update_applied",
  "update_failed",
  "install_finished",
  "uninstall_finished",
  "health_failing",
  "manager_update_available",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const DELIVERY_STATUSES = ["pending", "sending", "sent", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const notification_channels = sqliteTable("notification_channels", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: CHANNEL_KINDS }).notNull(),
  label: text("label").notNull(),
  /** A non-secret summary of where messages go (a chat id, a host name). */
  target: text("target").notNull(),
  /** The channel's credentials, encrypted (`v1.<iv>.<ciphertext>`, base64url). */
  config: text("config").notNull(),
  /** JSON array of the `NOTIFICATION_EVENTS` this channel receives. */
  events_json: text("events_json").notNull(),
  /** Failed delivery attempts since the last one that worked. */
  failure_count: integer("failure_count").notNull().default(0),
  /** Why the last attempt failed; never contains a credential. */
  last_error: text("last_error"),
  last_failure_at: timestamp("last_failure_at"),
  last_success_at: timestamp("last_success_at"),
  created_at: timestamp("created_at").notNull(),
  updated_at: timestamp("updated_at").notNull(),
});

export const notification_events = sqliteTable("notification_events", {
  id: text("id").primaryKey(),
  type: text("type", { enum: NOTIFICATION_EVENTS }).notNull(),
  /** `update_available:<install>:<version>`, `health_failing:<install>:<since>`, `job:<id>`, ... */
  dedupe_key: text("dedupe_key").notNull().unique(),
  /** The message's facts (`NotificationFacts`): names and versions, never secrets. */
  facts_json: text("facts_json").notNull(),
  occurred_at: timestamp("occurred_at").notNull(),
});

export const notification_deliveries = sqliteTable(
  "notification_deliveries",
  {
    event_id: text("event_id")
      .notNull()
      .references(() => notification_events.id),
    channel_id: text("channel_id")
      .notNull()
      .references(() => notification_channels.id),
    status: text("status", { enum: DELIVERY_STATUSES }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Not attempted before this time; for `sending`, when the claim lapses. */
    next_attempt_at: timestamp("next_attempt_at").notNull(),
    last_error: text("last_error"),
    sent_at: timestamp("sent_at"),
    created_at: timestamp("created_at").notNull(),
    updated_at: timestamp("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.event_id, t.channel_id] }),
    index("notification_deliveries_due_idx").on(t.status, t.next_attempt_at),
    index("notification_deliveries_channel_idx").on(t.channel_id),
  ],
);
