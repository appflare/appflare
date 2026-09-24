import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  addChannel,
  BOT_TOKEN,
  channelsEnv,
  DISCORD_URL,
  HOOK_URL,
  MANAGER,
  SLACK_URL,
  services,
  TELEGRAM,
} from "../test/notification-fixtures";
import {
  ChannelError,
  channelCounts,
  createChannel,
  deleteChannel,
  listChannels,
  replaceSigningSecret,
  sendTest,
  updateChannel,
} from "./channels.server";
import { signBody } from "./crypto";
import { MANAGER_URL_KEY } from "./outbox.server";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

async function rawRows(): Promise<string> {
  const { results } = await env.DB.prepare("SELECT * FROM notification_channels").all();
  return JSON.stringify(results);
}

describe("adding channels", () => {
  it("stores credentials encrypted and lists only a non-secret target", async () => {
    const saved = await addChannel();
    expect(saved.signingSecret).toBeNull();
    expect(saved.channel).toMatchObject({
      kind: "telegram",
      label: "Ops chat",
      target: "chat -1001234567890",
      failureCount: 0,
      readable: true,
      pending: 0,
    });
    expect(await rawRows()).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ");
    expect(JSON.stringify(await listChannels(channelsEnv()))).not.toContain(BOT_TOKEN);
  });

  it("targets for Slack, Discord and a webhook name the host or the webhook id only", async () => {
    await addChannel({
      label: "S",
      events: [],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    await addChannel({
      label: "D",
      events: [],
      settings: { kind: "discord", webhookUrl: DISCORD_URL },
    });
    await addChannel({ label: "W", events: [], settings: { kind: "webhook", url: HOOK_URL } });
    const list = await listChannels(channelsEnv());
    expect(list.map((c) => c.target)).toEqual([
      "hooks.slack.com",
      "webhook 123456789012345678",
      "hooks.example.test",
    ]);
    const raw = await rawRows();
    for (const secret of ["XXXXXXXXXXXXXXXXXXXXXXXX", "abcdefghijklmnop", "receiver-token-123"]) {
      expect(raw).not.toContain(secret);
    }
    expect(await channelCounts(env.DB)).toEqual({ telegram: 0, slack: 1, discord: 1, webhook: 1 });
  });

  it("a webhook's signing secret is returned once and signs its messages", async () => {
    const saved = await addChannel({
      label: "Receiver",
      events: ["update_available"],
      settings: { kind: "webhook", url: HOOK_URL },
    });
    expect(saved.signingSecret).toMatch(/^afwhsec_/);
    expect(await rawRows()).not.toContain(saved.signingSecret ?? "-");
    const svc = services();
    expect(await sendTest(channelsEnv(), saved.channel.id, { fetch: svc.fetch })).toEqual({
      ok: true,
      detail: "Delivered.",
    });
    const [p] = svc.posted;
    expect(p?.headers["x-appflare-signature"]).toBe(
      await signBody(saved.signingSecret ?? "", p?.body ?? ""),
    );
    expect(JSON.parse(p?.body ?? "")).toMatchObject({ event: "test", test: true });
  });

  it("refuses invalid credentials", async () => {
    await expect(
      addChannel({ ...TELEGRAM, settings: { kind: "telegram", botToken: "nope", chatId: "1" } }),
    ).rejects.toThrow();
    await expect(
      addChannel({
        label: "S",
        events: [],
        settings: { kind: "slack", webhookUrl: "https://example.com/x" },
      }),
    ).rejects.toThrow();
    await expect(
      addChannel({
        label: "W",
        events: [],
        settings: { kind: "webhook", url: "http://plain.test/" },
      }),
    ).rejects.toThrow();
  });

  it("remembers the admin's origin for links", async () => {
    await createChannel(channelsEnv(), TELEGRAM, { origin: `${MANAGER}/settings/notifications` });
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
      .bind(MANAGER_URL_KEY)
      .first<{ value: string }>();
    expect(row?.value).toBe(MANAGER);
  });
});

describe("changing channels", () => {
  it("renames and changes events without touching credentials", async () => {
    const { channel } = await addChannel();
    const before = await rawRows();
    const updated = await updateChannel(channelsEnv(), {
      id: channel.id,
      label: "Renamed",
      events: ["health_failing", "update_available"],
    });
    expect(updated.label).toBe("Renamed");
    // Stored in the canonical order, whatever order they were picked in.
    expect(updated.events).toEqual(["update_available", "health_failing"]);
    expect(JSON.parse(before)[0].config).toBe(JSON.parse(await rawRows())[0].config);
  });

  it("replaces credentials of the same kind only", async () => {
    const { channel } = await addChannel();
    const updated = await updateChannel(channelsEnv(), {
      id: channel.id,
      label: "Ops",
      events: [],
      settings: { kind: "telegram", botToken: BOT_TOKEN, chatId: "@appflare_ops" },
    });
    expect(updated.target).toBe("chat @appflare_ops");
    await expect(
      updateChannel(channelsEnv(), {
        id: channel.id,
        label: "Ops",
        events: [],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      }),
    ).rejects.toThrow(ChannelError);
  });

  it("a webhook keeps its signing secret when its URL changes, and replacing it shows a new one", async () => {
    const saved = await addChannel({
      label: "W",
      events: [],
      settings: { kind: "webhook", url: HOOK_URL },
    });
    await updateChannel(channelsEnv(), {
      id: saved.channel.id,
      label: "W",
      events: [],
      settings: { kind: "webhook", url: "https://other.example.test/hook" },
    });
    let svc = services();
    await sendTest(channelsEnv(), saved.channel.id, { fetch: svc.fetch });
    expect(svc.posted[0]?.url).toBe("https://other.example.test/hook");
    expect(svc.posted[0]?.headers["x-appflare-signature"]).toBe(
      await signBody(saved.signingSecret ?? "", svc.posted[0]?.body ?? ""),
    );

    const replaced = await replaceSigningSecret(channelsEnv(), saved.channel.id);
    expect(replaced.signingSecret).not.toBe(saved.signingSecret);
    svc = services();
    await sendTest(channelsEnv(), saved.channel.id, { fetch: svc.fetch });
    expect(svc.posted[0]?.headers["x-appflare-signature"]).toBe(
      await signBody(replaced.signingSecret ?? "", svc.posted[0]?.body ?? ""),
    );
    const { channel } = await addChannel();
    await expect(replaceSigningSecret(channelsEnv(), channel.id)).rejects.toThrow(ChannelError);
  });

  it("removing a channel removes its deliveries", async () => {
    const { channel } = await addChannel();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO notification_events (id, type, dedupe_key, facts_json, occurred_at)
         VALUES ('e1', 'health_failing', 'k1', '{}', 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO notification_deliveries (event_id, channel_id, status, next_attempt_at, created_at, updated_at)
         VALUES ('e1', ?1, 'pending', 1, 1, 1)`,
      ).bind(channel.id),
    ]);
    expect((await listChannels(channelsEnv()))[0]?.pending).toBe(1);
    await deleteChannel(channelsEnv(), channel.id);
    expect(await listChannels(channelsEnv())).toEqual([]);
    const left = await env.DB.prepare("SELECT count(*) AS n FROM notification_deliveries").first<{
      n: number;
    }>();
    expect(left?.n).toBe(0);
    await expect(deleteChannel(channelsEnv(), channel.id)).rejects.toThrow(ChannelError);
  });
});

describe("Send test", () => {
  it("counts failures and resets the count on success", async () => {
    const { channel } = await addChannel();
    const failing = services(() => 400);
    expect(await sendTest(channelsEnv(), channel.id, { fetch: failing.fetch })).toEqual({
      ok: false,
      detail: "Not delivered: HTTP 400: Bad Request: chat not found.",
    });
    await sendTest(channelsEnv(), channel.id, { fetch: failing.fetch });
    let [view] = await listChannels(channelsEnv());
    expect(view).toMatchObject({
      failureCount: 2,
      lastError: "HTTP 400: Bad Request: chat not found",
    });
    await sendTest(channelsEnv(), channel.id, { fetch: services().fetch });
    [view] = await listChannels(channelsEnv());
    expect(view?.failureCount).toBe(0);
    expect(view?.lastSuccessAt).not.toBeNull();
  });

  it("a channel whose key changed shows as unreadable and sends nothing", async () => {
    const { channel } = await addChannel();
    const other = { DB: env.DB, BETTER_AUTH_SECRET: "a-different-secret-0123456789" };
    expect((await listChannels(other))[0]?.readable).toBe(false);
    const svc = services();
    expect((await sendTest(other, channel.id, { fetch: svc.fetch })).ok).toBe(false);
    expect(svc.posted).toEqual([]);
  });
});
