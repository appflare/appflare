import { z } from "zod";
import {
  CHANNEL_KINDS,
  type ChannelKind,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
} from "./schema";

/**
 * Notification channels as the UI and the server functions share them:
 * the kinds, the events, their labels, and the validated inputs. Client-safe
 * (no bindings, no crypto).
 */

export { CHANNEL_KINDS, type ChannelKind, NOTIFICATION_EVENTS, type NotificationEvent };

export const CHANNEL_KIND_LABELS: Record<ChannelKind, string> = {
  telegram: "Telegram",
  slack: "Slack",
  discord: "Discord",
  webhook: "Webhook",
};

/** One line under each kind where a new channel's kind is chosen. */
export const CHANNEL_KIND_DESCRIPTIONS: Record<ChannelKind, string> = {
  telegram: "A bot posts to a chat, a group, or a channel.",
  slack: "An incoming webhook posts to a channel.",
  discord: "A channel's webhook posts the messages.",
  webhook: "Signed JSON posted to a URL you run.",
};

export const EVENT_LABELS: Record<NotificationEvent, string> = {
  update_available: "Update available",
  update_applied: "Update applied",
  update_failed: "Update failed",
  install_finished: "Install finished",
  uninstall_finished: "Uninstall finished",
  health_failing: "Health check failing",
  manager_update_available: "Appflare update available",
  domain_active: "Domain active",
  domain_failed: "Domain failed",
};

export const EVENT_DESCRIPTIONS: Record<NotificationEvent, string> = {
  update_available: "Once per app and version, when the catalog lists a newer version.",
  update_applied: "When an update job finishes.",
  update_failed: "When an update job fails.",
  install_finished: "When an install job succeeds or fails.",
  uninstall_finished: "When an uninstall job succeeds or fails.",
  health_failing:
    "Once each time an installed app starts answering its health check with a server error. Turning this on makes the scheduled check probe every installed app every 30 minutes.",
  manager_update_available: "Once per release, when a newer Appflare release is published.",
  domain_active:
    "When an external domain starts serving its app: Cloudflare validated it and issued its certificate.",
  domain_failed:
    "When an external domain stops serving or cannot be validated, for example its custom hostname was deleted in the dashboard or its certificate timed out or expired.",
};

/** Events a new channel starts with. */
export const DEFAULT_EVENTS: readonly NotificationEvent[] = NOTIFICATION_EVENTS;

const LABEL_MAX = 80;

export const channelLabelSchema = z
  .string()
  .trim()
  .min(1, "Give the channel a name.")
  .max(LABEL_MAX, `Use at most ${LABEL_MAX} characters.`);

export const channelEventsSchema = z
  .array(z.enum(NOTIFICATION_EVENTS))
  .max(NOTIFICATION_EVENTS.length)
  .transform((events) => NOTIFICATION_EVENTS.filter((e) => events.includes(e)));

/** A bot token as BotFather issues it: `<bot id>:<secret>`. */
export const TELEGRAM_BOT_TOKEN = /^\d{3,20}:[A-Za-z0-9_-]{30,64}$/;
/** A numeric chat id (negative for groups and channels) or a public `@channelname`. */
export const TELEGRAM_CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;

const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

export function isSlackWebhookUrl(value: string): boolean {
  const url = httpsUrl(value);
  return url !== null && SLACK_HOSTS.has(url.hostname) && url.pathname.startsWith("/services/");
}

export function isDiscordWebhookUrl(value: string): boolean {
  const url = httpsUrl(value);
  return (
    url !== null &&
    DISCORD_HOSTS.has(url.hostname) &&
    /^\/api\/(v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
  );
}

/** Any `https:` URL without credentials in it. */
export function isWebhookUrl(value: string): boolean {
  return httpsUrl(value) !== null;
}

const trimmed = z.string().trim();

export const telegramSettingsSchema = z.object({
  botToken: trimmed.regex(TELEGRAM_BOT_TOKEN, "Paste the bot token BotFather gave you."),
  chatId: trimmed.regex(TELEGRAM_CHAT_ID, "Use a numeric chat id or a public @channel name."),
});

export const slackSettingsSchema = z.object({
  webhookUrl: trimmed.refine(isSlackWebhookUrl, "Paste a Slack incoming webhook URL."),
});

export const discordSettingsSchema = z.object({
  webhookUrl: trimmed.refine(isDiscordWebhookUrl, "Paste a Discord webhook URL."),
});

export const webhookSettingsSchema = z.object({
  url: trimmed.max(2048).refine(isWebhookUrl, "Use an https:// URL."),
});

/**
 * What an admin enters for each kind. A generic webhook's signing secret is
 * never entered: the manager generates it and shows it once.
 */
export const channelSettingsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("telegram"), ...telegramSettingsSchema.shape }),
  z.object({ kind: z.literal("slack"), ...slackSettingsSchema.shape }),
  z.object({ kind: z.literal("discord"), ...discordSettingsSchema.shape }),
  z.object({ kind: z.literal("webhook"), ...webhookSettingsSchema.shape }),
]);
export type ChannelSettings = z.infer<typeof channelSettingsSchema>;

export const createChannelInput = z.object({
  label: channelLabelSchema,
  events: channelEventsSchema,
  settings: channelSettingsSchema,
});
export type CreateChannelInput = z.input<typeof createChannelInput>;

export const updateChannelInput = z.object({
  id: z.string().min(1).max(64),
  label: channelLabelSchema,
  events: channelEventsSchema,
  /** New credentials; omitted to keep the stored ones. Must match the channel's kind. */
  settings: channelSettingsSchema.optional(),
});
export type UpdateChannelInput = z.input<typeof updateChannelInput>;

export const channelIdInput = z.object({ id: z.string().min(1).max(64) });

/** A channel as Settings lists it: nothing secret. */
export interface ChannelView {
  id: string;
  kind: ChannelKind;
  label: string;
  /** Where messages go, without credentials: a chat id, "Slack", a host name. */
  target: string;
  events: NotificationEvent[];
  /** Failed attempts since the last one that worked. */
  failureCount: number;
  lastError: string | null;
  /** ISO 8601 */
  lastFailureAt: string | null;
  /** ISO 8601 */
  lastSuccessAt: string | null;
  /** Deliveries waiting for a retry. */
  pending: number;
  /** False when the stored credentials cannot be read any more (the key changed). */
  readable: boolean;
  /** ISO 8601 */
  createdAt: string;
}

/** What creating a channel, or replacing a webhook's signing secret, returns. */
export interface ChannelSaved {
  channel: ChannelView;
  /** A generic webhook's new signing secret, shown once; null for other kinds. */
  signingSecret: string | null;
}

export interface TestResult {
  ok: boolean;
  /** "Delivered." or why it failed, without credentials. */
  detail: string;
}

/** The header a generic webhook's signature travels in. */
export const SIGNATURE_HEADER = "X-Appflare-Signature";

export const NOTIFICATION_COPY = {
  membersOnly: "Only admins can view and change notification channels.",
  empty: "No channels yet. Add one to hear about updates, finished jobs and failing health checks.",
  privacy:
    "Messages name the app, its version and Worker, and link to this manager. They never include secrets or tokens. Credentials you enter here are stored encrypted.",
  signingSecret:
    "Every request carries an X-Appflare-Signature header: sha256= followed by the hex HMAC-SHA256 of the raw request body, keyed with this secret. Copy the secret now; it is not shown again.",
  webhookAddress:
    "An https:// URL. Appflare does not follow redirects from it. The address itself is not checked against private ranges: a Worker cannot reach private networks, and only admins can add channels.",
} as const;
