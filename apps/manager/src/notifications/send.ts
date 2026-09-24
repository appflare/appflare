import type { FetchLike } from "@appflare/cf-api";
import { SIGNATURE_HEADER } from "./channels";
import { type StoredConfig, secretsOf, signBody } from "./crypto";
import {
  discordText,
  type Message,
  type NotificationFacts,
  plainText,
  renderMessage,
  slackText,
} from "./messages";

/**
 * One message to one channel: one HTTPS request, no redirects followed (a
 * signed body must not travel to a host the admin did not name), a 10 s
 * timeout. The outcome says whether a later attempt may work; its error text
 * is built here from the status and the service's own short reason, and every
 * credential of the channel is scrubbed from it before it is stored or shown.
 */

export const SEND_TIMEOUT_MS = 10_000;
const DISCORD_MAX = 2000;
const TELEGRAM_MAX = 4096;
const DETAIL_MAX = 160;

export type SendOutcome =
  | { ok: true }
  | {
      ok: false;
      /** A later attempt may work (a 5xx, a 429, a network error). */
      retryable: boolean;
      error: string;
      /** How long the service asked us to wait, when it said. */
      retryAfterMs?: number;
    };

export interface Delivery {
  /** The event's id (a test has its own); webhook receivers can dedupe on it. */
  id: string;
  facts: NotificationFacts;
  /** When the event happened (epoch ms). */
  occurredAt: number;
  managerUrl: string | null;
}

export interface SendDeps {
  fetch: FetchLike;
  now: () => number;
}

interface Built {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The generic webhook's JSON body. */
export function webhookBody(delivery: Delivery, message: Message, sentAt: number): string {
  const { type, ...data } = delivery.facts;
  return JSON.stringify({
    id: delivery.id,
    event: type,
    test: type === "test",
    occurredAt: new Date(delivery.occurredAt).toISOString(),
    sentAt: new Date(sentAt).toISOString(),
    title: message.title,
    text: message.lines.join("\n"),
    url: message.url,
    managerUrl: delivery.managerUrl,
    data,
  });
}

async function build(config: StoredConfig, delivery: Delivery, now: number): Promise<Built> {
  const message = renderMessage(delivery.facts, delivery.managerUrl);
  const json = { "content-type": "application/json", "user-agent": "Appflare" };
  switch (config.kind) {
    case "telegram":
      return {
        url: `https://api.telegram.org/bot${config.botToken}/sendMessage`,
        headers: json,
        body: JSON.stringify({
          chat_id: config.chatId,
          text: truncate(plainText(message), TELEGRAM_MAX),
          link_preview_options: { is_disabled: true },
        }),
      };
    case "slack":
      return {
        url: config.webhookUrl,
        headers: json,
        body: JSON.stringify({ text: slackText(message) }),
      };
    case "discord": {
      // Without `wait=true` Discord answers 204 even when it did not save the message.
      const url = new URL(config.webhookUrl);
      url.searchParams.set("wait", "true");
      return {
        url: url.toString(),
        headers: json,
        body: JSON.stringify({
          content: truncate(discordText(message), DISCORD_MAX),
          // Names come from the catalog and from admins: never ping anyone.
          allowed_mentions: { parse: [] },
        }),
      };
    }
    case "webhook": {
      const body = webhookBody(delivery, message, now);
      return {
        url: config.url,
        headers: {
          ...json,
          "x-appflare-event": delivery.facts.type,
          "x-appflare-delivery": delivery.id,
          [SIGNATURE_HEADER.toLowerCase()]: await signBody(config.secret, body),
        },
        body,
      };
    }
  }
}

/** Removes every credential of the channel from a text (long enough ones only). */
export function scrub(text: string, config: StoredConfig): string {
  let out = text;
  for (const secret of secretsOf(config)) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/** The service's own short reason for a refusal, when it gives one. */
async function reasonOf(config: StoredConfig, response: Response): Promise<string | null> {
  if (config.kind === "webhook") {
    await response.body?.cancel();
    return null;
  }
  try {
    const text = (await response.text()).trim();
    if (config.kind === "slack") return /^[a-z_]{1,80}$/.test(text) ? text : null;
    const body = JSON.parse(text) as { description?: unknown; message?: unknown };
    const reason = config.kind === "telegram" ? body.description : body.message;
    return typeof reason === "string" ? truncate(reason, DETAIL_MAX) : null;
  } catch {
    return null;
  }
}

function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

export async function sendToChannel(
  config: StoredConfig,
  delivery: Delivery,
  deps: SendDeps,
): Promise<SendOutcome> {
  const request = await build(config, delivery, deps.now());
  let response: Response;
  try {
    response = await deps.fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      retryable: true,
      error: timedOut ? `no answer within ${SEND_TIMEOUT_MS / 1000} seconds` : "could not connect",
    };
  }
  if (response.status >= 200 && response.status < 300) {
    await response.body?.cancel();
    return { ok: true };
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return {
      ok: false,
      retryable: false,
      error: `HTTP ${response.status}: redirects are not followed; use the final URL`,
    };
  }
  const reason = await reasonOf(config, response);
  const error = scrub(`HTTP ${response.status}${reason === null ? "" : `: ${reason}`}`, config);
  const retryable = response.status === 429 || response.status >= 500;
  const wait = retryAfter(response);
  return { ok: false, retryable, error, ...(wait === undefined ? {} : { retryAfterMs: wait }) };
}
