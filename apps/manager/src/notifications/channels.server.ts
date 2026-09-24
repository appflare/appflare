import type { FetchLike } from "@appflare/cf-api";
import { ulid } from "ulidx";
import {
  type ChannelKind,
  type ChannelSaved,
  type ChannelSettings,
  type ChannelView,
  type CreateChannelInput,
  createChannelInput,
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type TestResult,
  type UpdateChannelInput,
  updateChannelInput,
} from "./channels";
import {
  channelKey,
  decryptConfig,
  encryptConfig,
  newSigningSecret,
  type StoredConfig,
} from "./crypto";
import { managerUrl, rememberManagerUrl } from "./outbox.server";
import { sendToChannel } from "./send";

/**
 * Adding, changing, removing and testing channels (Settings, Notification
 * channels; admins only, enforced by the server functions). Credentials go
 * in, are encrypted before they reach D1, and never come back out: the list
 * shows a non-secret target instead, and a generic webhook's signing secret
 * is returned exactly once, when it is made.
 */

export class ChannelError extends Error {
  override name = "ChannelError";
}

export interface ChannelsEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
}

export interface ChannelsDeps {
  now?: () => number;
  /** The origin the admin uses; remembered for links in messages. */
  origin?: string;
}

interface ChannelRecord {
  id: string;
  kind: ChannelKind;
  label: string;
  target: string;
  config: string;
  events_json: string;
  failure_count: number;
  last_error: string | null;
  last_failure_at: number | null;
  last_success_at: number | null;
  created_at: number;
}

/** Where messages go, without credentials. */
export function targetOf(settings: ChannelSettings): string {
  switch (settings.kind) {
    case "telegram":
      return `chat ${settings.chatId}`;
    case "slack":
      return new URL(settings.webhookUrl).hostname;
    case "discord": {
      // /api/webhooks/<id>/<token>: the id is not secret, the token is.
      const id = new URL(settings.webhookUrl).pathname.split("/").find((p) => /^\d+$/.test(p));
      return id === undefined ? "Discord webhook" : `webhook ${id}`;
    }
    case "webhook":
      return new URL(settings.url).host;
  }
}

function eventsOf(json: string): NotificationEvent[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? NOTIFICATION_EVENTS.filter((e) => value.includes(e)) : [];
  } catch {
    return [];
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

async function readable(env: ChannelsEnv, row: ChannelRecord): Promise<boolean> {
  try {
    return (
      (await decryptConfig(await channelKey(env.BETTER_AUTH_SECRET), row.id, row.config)) !== null
    );
  } catch {
    return false;
  }
}

async function viewOf(env: ChannelsEnv, row: ChannelRecord, pending: number): Promise<ChannelView> {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    target: row.target,
    events: eventsOf(row.events_json),
    failureCount: row.failure_count,
    lastError: row.last_error,
    lastFailureAt: iso(row.last_failure_at),
    lastSuccessAt: iso(row.last_success_at),
    pending,
    readable: await readable(env, row),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const SELECT_CHANNEL = `SELECT id, kind, label, target, config, events_json, failure_count,
  last_error, last_failure_at, last_success_at, created_at FROM notification_channels`;

async function readChannel(db: D1Database, id: string): Promise<ChannelRecord> {
  const row = await db.prepare(`${SELECT_CHANNEL} WHERE id = ?1`).bind(id).first<ChannelRecord>();
  if (row === null) throw new ChannelError("There is no such channel.");
  return row;
}

async function pendingOf(db: D1Database, id: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM notification_deliveries
       WHERE channel_id = ?1 AND status IN ('pending', 'sending')`,
    )
    .bind(id)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listChannels(env: ChannelsEnv): Promise<ChannelView[]> {
  const [channels, pending] = await env.DB.batch([
    env.DB.prepare(`${SELECT_CHANNEL} ORDER BY created_at`),
    env.DB.prepare(
      `SELECT channel_id, count(*) AS n FROM notification_deliveries
       WHERE status IN ('pending', 'sending') GROUP BY channel_id`,
    ),
  ]);
  const pendingBy = new Map(
    ((pending?.results ?? []) as { channel_id: string; n: number }[]).map((r) => [
      r.channel_id,
      r.n,
    ]),
  );
  return Promise.all(
    ((channels?.results ?? []) as ChannelRecord[]).map((row) =>
      viewOf(env, row, pendingBy.get(row.id) ?? 0),
    ),
  );
}

async function remember(env: ChannelsEnv, deps: ChannelsDeps, now: number): Promise<void> {
  if (deps.origin !== undefined) await rememberManagerUrl(env.DB, deps.origin, now);
}

async function key(env: ChannelsEnv): Promise<CryptoKey> {
  try {
    return await channelKey(env.BETTER_AUTH_SECRET);
  } catch {
    throw new ChannelError(
      "This manager has no BETTER_AUTH_SECRET, so it cannot store credentials.",
    );
  }
}

export async function createChannel(
  env: ChannelsEnv,
  raw: CreateChannelInput,
  deps: ChannelsDeps = {},
): Promise<ChannelSaved> {
  const input = createChannelInput.parse(raw);
  const now = (deps.now ?? Date.now)();
  const id = ulid(now);
  const signingSecret = input.settings.kind === "webhook" ? newSigningSecret() : null;
  const stored: StoredConfig =
    input.settings.kind === "webhook"
      ? { ...input.settings, secret: signingSecret ?? newSigningSecret() }
      : input.settings;
  const sealed = await encryptConfig(await key(env), id, stored);
  await env.DB.prepare(
    `INSERT INTO notification_channels
       (id, kind, label, target, config, events_json, failure_count, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)`,
  )
    .bind(
      id,
      input.settings.kind,
      input.label,
      targetOf(input.settings),
      sealed,
      JSON.stringify(input.events),
      now,
    )
    .run();
  await remember(env, deps, now);
  return { channel: await viewOf(env, await readChannel(env.DB, id), 0), signingSecret };
}

/**
 * Renames a channel, changes its events, and optionally replaces its
 * credentials (same kind only). A generic webhook keeps its signing secret
 * when its URL changes; replacing the secret is its own action. When the
 * stored credentials cannot be read any more (the key they were sealed with
 * changed), entering them again repairs the channel: a webhook then gets a
 * fresh signing secret, returned here once, since the old one is lost.
 */
export async function updateChannel(
  env: ChannelsEnv,
  raw: UpdateChannelInput,
  deps: ChannelsDeps = {},
): Promise<ChannelSaved> {
  const input = updateChannelInput.parse(raw);
  const now = (deps.now ?? Date.now)();
  const row = await readChannel(env.DB, input.id);
  let sealed = row.config;
  let target = row.target;
  let signingSecret: string | null = null;
  if (input.settings !== undefined) {
    if (input.settings.kind !== row.kind) {
      throw new ChannelError("A channel's kind cannot change; add a new channel instead.");
    }
    const k = await key(env);
    let stored: StoredConfig;
    if (input.settings.kind === "webhook") {
      const previous = await decryptConfig(k, row.id, row.config);
      const kept = previous?.kind === "webhook" ? previous.secret : null;
      if (kept === null) signingSecret = newSigningSecret();
      stored = { ...input.settings, secret: kept ?? signingSecret ?? newSigningSecret() };
    } else {
      stored = input.settings;
    }
    sealed = await encryptConfig(k, row.id, stored);
    target = targetOf(input.settings);
  }
  await env.DB.prepare(
    `UPDATE notification_channels
     SET label = ?2, events_json = ?3, config = ?4, target = ?5, updated_at = ?6
     WHERE id = ?1`,
  )
    .bind(row.id, input.label, JSON.stringify(input.events), sealed, target, now)
    .run();
  await remember(env, deps, now);
  return {
    channel: await viewOf(env, await readChannel(env.DB, row.id), await pendingOf(env.DB, row.id)),
    signingSecret,
  };
}

/**
 * A generic webhook's new signing secret, returned once. A webhook whose
 * credentials cannot be read any more is repaired by editing it instead,
 * which takes its URL again and makes a new secret.
 */
export async function replaceSigningSecret(
  env: ChannelsEnv,
  id: string,
  deps: ChannelsDeps = {},
): Promise<ChannelSaved> {
  const now = (deps.now ?? Date.now)();
  const row = await readChannel(env.DB, id);
  if (row.kind !== "webhook")
    throw new ChannelError("Only a webhook channel has a signing secret.");
  const k = await key(env);
  const previous = await decryptConfig(k, row.id, row.config);
  if (previous?.kind !== "webhook") {
    throw new ChannelError(
      "The stored URL cannot be read. Edit the channel and enter its details again.",
    );
  }
  const signingSecret = newSigningSecret();
  const sealed = await encryptConfig(k, row.id, { ...previous, secret: signingSecret });
  await env.DB.prepare(
    "UPDATE notification_channels SET config = ?2, updated_at = ?3 WHERE id = ?1",
  )
    .bind(row.id, sealed, now)
    .run();
  await remember(env, deps, now);
  return {
    channel: await viewOf(env, await readChannel(env.DB, row.id), await pendingOf(env.DB, row.id)),
    signingSecret,
  };
}

/** Removes a channel and its deliveries; events stay, so nothing is sent twice. */
export async function deleteChannel(env: ChannelsEnv, id: string): Promise<void> {
  await readChannel(env.DB, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM notification_deliveries WHERE channel_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM notification_channels WHERE id = ?1").bind(id),
  ]);
}

/**
 * "Send test": one message, sent now from this request, recorded on the
 * channel like any delivery (a success resets its failure count).
 */
export async function sendTest(
  env: ChannelsEnv,
  id: string,
  deps: ChannelsDeps & { fetch?: FetchLike } = {},
): Promise<TestResult> {
  const now = deps.now ?? Date.now;
  const row = await readChannel(env.DB, id);
  await remember(env, deps, now());
  const config = await decryptConfig(await key(env), row.id, row.config);
  if (config === null) {
    return {
      ok: false,
      detail:
        "The stored credentials cannot be read. Edit the channel and enter its details again.",
    };
  }
  const outcome = await sendToChannel(
    config,
    {
      id: `test-${ulid(now())}`,
      facts: { type: "test" },
      occurredAt: now(),
      managerUrl: await managerUrl(env.DB),
    },
    { fetch: deps.fetch ?? ((input, init) => fetch(input, init)), now },
  );
  const at = now();
  if (outcome.ok) {
    await env.DB.prepare(
      "UPDATE notification_channels SET failure_count = 0, last_success_at = ?2 WHERE id = ?1",
    )
      .bind(row.id, at)
      .run();
    return { ok: true, detail: "Delivered." };
  }
  await env.DB.prepare(
    `UPDATE notification_channels
     SET failure_count = failure_count + 1, last_error = ?2, last_failure_at = ?3 WHERE id = ?1`,
  )
    .bind(row.id, outcome.error, at)
    .run();
  return { ok: false, detail: `Not delivered: ${outcome.error}.` };
}

/** Channel counts by kind (for the usage-data heartbeat's `notification_channels`). */
export async function channelCounts(db: D1Database): Promise<Record<ChannelKind, number>> {
  const { results } = await db
    .prepare("SELECT kind, count(*) AS n FROM notification_channels GROUP BY kind")
    .all<{ kind: ChannelKind; n: number }>();
  const counts: Record<ChannelKind, number> = { telegram: 0, slack: 0, discord: 0, webhook: 0 };
  for (const r of results) if (r.kind in counts) counts[r.kind] = r.n;
  return counts;
}
