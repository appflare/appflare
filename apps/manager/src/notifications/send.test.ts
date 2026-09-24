import { describe, expect, it } from "vitest";
import {
  BOT_TOKEN,
  CHAT_ID,
  DISCORD_URL,
  HOOK_URL,
  MANAGER,
  SLACK_URL,
  services,
} from "../test/notification-fixtures";
import { type StoredConfig, signBody } from "./crypto";
import { type Delivery, sendToChannel } from "./send";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const HOOK_SECRET = "afwhsec_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";

const delivery: Delivery = {
  id: "01EVENT",
  facts: {
    type: "update_failed",
    app: { installId: "i1", app: "Cut", instance: "Links", workerName: "my-links" },
    from: "1.0.0",
    to: "1.1.0",
    jobId: "j1",
  },
  occurredAt: NOW - 1000,
  managerUrl: MANAGER,
};

const telegram: StoredConfig = { kind: "telegram", botToken: BOT_TOKEN, chatId: CHAT_ID };
const slack: StoredConfig = { kind: "slack", webhookUrl: SLACK_URL };
const discord: StoredConfig = { kind: "discord", webhookUrl: DISCORD_URL };
const webhook: StoredConfig = { kind: "webhook", url: HOOK_URL, secret: HOOK_SECRET };

function send(config: StoredConfig, reply?: (url: string) => Response | number) {
  const svc = services(reply);
  return { svc, out: sendToChannel(config, delivery, { fetch: svc.fetch, now: () => NOW }) };
}

describe("requests per kind", () => {
  it("Telegram: sendMessage with the chat id and plain text, no link preview", async () => {
    const { svc, out } = send(telegram);
    expect(await out).toEqual({ ok: true });
    expect(svc.posted).toHaveLength(1);
    const [p] = svc.posted;
    expect(p?.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    const body = JSON.parse(p?.body ?? "");
    expect(body).toEqual({
      chat_id: CHAT_ID,
      text: `Update failed: Links\nUpdating Links (Worker my-links) from 1.0.0 to 1.1.0 failed. The job log says where.\n${MANAGER}/jobs/j1`,
      link_preview_options: { is_disabled: true },
    });
  });

  it("Slack: the incoming webhook gets mrkdwn text", async () => {
    const { svc, out } = send(slack);
    expect(await out).toEqual({ ok: true });
    expect(svc.posted[0]?.url).toBe(SLACK_URL);
    expect(JSON.parse(svc.posted[0]?.body ?? "").text).toContain(
      `<${MANAGER}/jobs/j1|Open in Appflare>`,
    );
  });

  it("Discord: waits for Discord to save the message; content with mentions turned off", async () => {
    const { svc, out } = send(discord);
    expect(await out).toEqual({ ok: true });
    expect(svc.posted[0]?.url).toBe(`${DISCORD_URL}?wait=true`);
    const body = JSON.parse(svc.posted[0]?.body ?? "");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content).toMatch(/^\*\*Update failed: Links\*\*/);
  });

  it("webhook: JSON body signed with the channel's secret over the exact bytes", async () => {
    const { svc, out } = send(webhook);
    expect(await out).toEqual({ ok: true });
    const [p] = svc.posted;
    expect(p?.url).toBe(HOOK_URL);
    expect(p?.headers["x-appflare-signature"]).toBe(await signBody(HOOK_SECRET, p?.body ?? ""));
    expect(p?.headers["x-appflare-event"]).toBe("update_failed");
    expect(p?.headers["x-appflare-delivery"]).toBe("01EVENT");
    expect(JSON.parse(p?.body ?? "")).toEqual({
      id: "01EVENT",
      event: "update_failed",
      test: false,
      occurredAt: new Date(NOW - 1000).toISOString(),
      sentAt: new Date(NOW).toISOString(),
      title: "Update failed: Links",
      text: "Updating Links (Worker my-links) from 1.0.0 to 1.1.0 failed. The job log says where.",
      url: `${MANAGER}/jobs/j1`,
      managerUrl: MANAGER,
      data: {
        app: { installId: "i1", app: "Cut", instance: "Links", workerName: "my-links" },
        from: "1.0.0",
        to: "1.1.0",
        jobId: "j1",
      },
    });
    // The secret itself never travels.
    expect(JSON.stringify(p)).not.toContain(HOOK_SECRET);
  });
});

describe("failures", () => {
  it("a refusal is final and carries the service's reason, never a credential", async () => {
    const { out } = send(telegram, () => 400);
    expect(await out).toEqual({
      ok: false,
      retryable: false,
      error: "HTTP 400: Bad Request: chat not found",
    });
    const slackOut = await send(slack, () => 404).out;
    expect(slackOut).toEqual({ ok: false, retryable: false, error: "HTTP 404: no_service" });
  });

  it("scrubs a credential the service echoes back", async () => {
    const { out } = send(discord, () =>
      Response.json({ message: `Unknown Webhook ${DISCORD_URL}` }, { status: 404 }),
    );
    const result = await out;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(result)).toContain("[redacted]");
  });

  it("a webhook's own error body is never read into the error", async () => {
    const { out } = send(webhook, () => new Response(`denied ${HOOK_SECRET}`, { status: 403 }));
    expect(await out).toEqual({ ok: false, retryable: false, error: "HTTP 403" });
  });

  it("429 and 5xx may be retried; 429 passes on the wait it asked for", async () => {
    expect(await send(slack, () => 503).out).toMatchObject({ ok: false, retryable: true });
    expect(
      await send(
        slack,
        () => new Response("rate_limited", { status: 429, headers: { "retry-after": "30" } }),
      ).out,
    ).toEqual({
      ok: false,
      retryable: true,
      error: "HTTP 429: rate_limited",
      retryAfterMs: 30_000,
    });
  });

  it("a redirect is not followed", async () => {
    const { out } = send(
      webhook,
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    expect(await out).toMatchObject({
      ok: false,
      retryable: false,
      error: expect.stringMatching(/^HTTP 302/),
    });
  });

  it("a network error may be retried", async () => {
    const result = await sendToChannel(telegram, delivery, {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      now: () => NOW,
    });
    expect(result).toEqual({ ok: false, retryable: true, error: "could not connect" });
  });
});
