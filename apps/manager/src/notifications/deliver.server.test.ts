import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { addChannel, channelsEnv, SLACK_URL, services } from "../test/notification-fixtures";
import { listChannels } from "./channels.server";
import { deliverDue } from "./deliver.server";
import type { NotificationFacts } from "./messages";
import {
  CLAIM_LEASE_MS,
  claimDue,
  DELIVERY_EXPIRY_MS,
  emitEvent,
  MAX_ATTEMPTS,
  readChannels,
} from "./outbox.server";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const FACTS: NotificationFacts = {
  type: "manager_update_available",
  from: "0.5.0",
  to: "0.6.0",
};

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

async function emit(key = "manager_update_available:0.6.0", at = NOW) {
  return emitEvent(
    env.DB,
    await readChannels(env.DB),
    { type: "manager_update_available", dedupeKey: key, facts: FACTS, occurredAt: at },
    at,
  );
}

async function deliveries() {
  const { results } = await env.DB.prepare(
    "SELECT channel_id, status, attempts, next_attempt_at, last_error FROM notification_deliveries",
  ).all<{
    channel_id: string;
    status: string;
    attempts: number;
    next_attempt_at: number;
    last_error: string | null;
  }>();
  return results;
}

const noSleep = async () => {};

describe("the outbox", () => {
  it("writes nothing when no channel wants the event", async () => {
    await addChannel({
      label: "Quiet",
      events: ["update_failed"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    expect(await emit()).toEqual({ eventId: null, queued: 0 });
    expect(await deliveries()).toEqual([]);
  });

  it("an event happens once, and each channel gets it once, including one added later", async () => {
    await addChannel(undefined, NOW - 10);
    const first = await emit();
    expect(first.queued).toBe(1);
    expect(await emit()).toEqual({ eventId: first.eventId, queued: 0 });
    await addChannel({
      label: "Later",
      events: ["manager_update_available"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    expect(await emit()).toEqual({ eventId: first.eventId, queued: 1 });
    expect(await deliveries()).toHaveLength(2);
  });

  it("a claim is a lease: a second claimer gets nothing until it runs out", async () => {
    await addChannel(undefined, NOW - 10);
    await emit();
    expect(await claimDue(env.DB, { now: NOW, limit: 10 })).toHaveLength(1);
    expect(await claimDue(env.DB, { now: NOW + 1000, limit: 10 })).toEqual([]);
    const again = await claimDue(env.DB, { now: NOW + CLAIM_LEASE_MS, limit: 10 });
    expect(again).toHaveLength(1);
    expect(again[0]?.facts).toEqual(FACTS);
  });
});

describe("deliverDue", () => {
  it("sends, marks sent, and never sends the same delivery twice", async () => {
    await addChannel(undefined, NOW - 10);
    await emit();
    const svc = services();
    const e = channelsEnv();
    expect(await deliverDue(e, { fetch: svc.fetch, now: () => NOW })).toEqual({
      claimed: 1,
      sent: 1,
      retrying: 0,
      failed: 0,
    });
    expect(await deliverDue(e, { fetch: svc.fetch, now: () => NOW + 3_600_000 })).toMatchObject({
      claimed: 0,
    });
    expect(svc.posted).toHaveLength(1);
    expect((await deliveries())[0]?.status).toBe("sent");
    expect((await listChannels(e))[0]?.lastSuccessAt).toBe(new Date(NOW).toISOString());
  });

  it("retries a retryable failure once at once, then with backoff, then gives up", async () => {
    await addChannel(undefined, NOW - 10);
    await emit();
    const svc = services(() => 503);
    const e = channelsEnv();
    let t = NOW;
    const report = await deliverDue(e, { fetch: svc.fetch, now: () => t, sleep: noSleep });
    expect(report).toMatchObject({ claimed: 1, retrying: 1 });
    // One attempt made of the request and its quick retry.
    expect(svc.posted).toHaveLength(2);
    let [d] = await deliveries();
    expect(d).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "HTTP 503: Bad Request: chat not found",
    });
    expect(d?.next_attempt_at).toBe(NOW + 60_000);
    // Not due yet.
    expect(
      await deliverDue(e, { fetch: svc.fetch, now: () => t + 1000, sleep: noSleep }),
    ).toMatchObject({ claimed: 0 });
    for (let i = 2; i <= MAX_ATTEMPTS; i++) {
      t = (await deliveries())[0]?.next_attempt_at ?? t;
      await deliverDue(e, { fetch: svc.fetch, now: () => t, sleep: noSleep });
    }
    [d] = await deliveries();
    expect(d).toMatchObject({ status: "failed", attempts: MAX_ATTEMPTS });
    expect((await listChannels(e))[0]?.failureCount).toBe(MAX_ATTEMPTS);
  });

  it("a final failure is not retried", async () => {
    await addChannel(undefined, NOW - 10);
    await emit();
    const svc = services(() => 400);
    const report = await deliverDue(channelsEnv(), {
      fetch: svc.fetch,
      now: () => NOW,
      sleep: noSleep,
    });
    expect(report).toMatchObject({ failed: 1 });
    expect(svc.posted).toHaveLength(1);
  });

  it("gives up on a delivery that is still unsent a day after it was queued", async () => {
    await addChannel(undefined, NOW - 10);
    await emit();
    const svc = services();
    const report = await deliverDue(channelsEnv(), {
      fetch: svc.fetch,
      now: () => NOW + DELIVERY_EXPIRY_MS + 1,
    });
    expect(report.claimed).toBe(0);
    expect(svc.posted).toEqual([]);
    expect((await deliveries())[0]).toMatchObject({
      status: "failed",
      last_error: "not delivered within 24 hours",
    });
  });

  it("fails a delivery whose credentials cannot be read, without sending", async () => {
    await addChannel(undefined, NOW - 10);
    await emit();
    const svc = services();
    const report = await deliverDue(
      { DB: env.DB, BETTER_AUTH_SECRET: "another-secret-0123456789" },
      { fetch: svc.fetch, now: () => NOW },
    );
    expect(report).toMatchObject({ failed: 1 });
    expect(svc.posted).toEqual([]);
  });
});
