import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { setUpGatewayCore } from "../gateway/gateway.server";
import { runExternalDomainCheck } from "../notifications/cron.server";
import { MANAGER_URL_KEY } from "../notifications/outbox.server";
import { fakeSaas } from "../test/fake-saas";
import { addChannel, MANAGER, SECRET, SLACK_URL } from "../test/notification-fixtures";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { addExternalDomainCore, removeExternalDomainCore } from "./external-domains.server";
import { checkExternalDomains, DOMAIN_STATE_PREFIX } from "./external-domains-poll.server";

/**
 * The scheduled check of external domains against the local D1 and a
 * stateful fake of Cloudflare for SaaS, with a channel that wants both
 * domain events.
 */

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const HALF_HOUR = 1_800_000;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 1)")
    .bind(MANAGER_URL_KEY, MANAGER)
    .run();
});

async function withDomain(hostname = "go.customer.test") {
  const saas = fakeSaas();
  await setUpGatewayCore({ db: env.DB, api: saas.api, sleep: async () => {} }, { zoneId: "z-gw" });
  const { resourceId } = await addExternalDomainCore(
    { db: env.DB, api: saas.api, now: () => new Date(NOW - 60_000) },
    { installId: INSTALL_ID, hostname, validation: "http" },
  );
  return { saas, resourceId };
}

async function events() {
  const { results } = await env.DB.prepare(
    "SELECT type, dedupe_key, facts_json FROM notification_events ORDER BY occurred_at, dedupe_key",
  ).all<{ type: string; dedupe_key: string; facts_json: string }>();
  return results.map((r) => ({ ...r, facts: JSON.parse(r.facts_json) as Record<string, unknown> }));
}

async function recorded(resourceId: string) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(`${DOMAIN_STATE_PREFIX}${resourceId}`)
    .first<{ value: string }>();
  return row === null ? null : (JSON.parse(row.value) as { state: string; since: number });
}

const listCalls = (saas: ReturnType<typeof fakeSaas>) =>
  saas.world.calls.filter((c) => c === "GET /zones/z-gw/custom_hostnames").length;

describe("checkExternalDomains", () => {
  it("records a pending domain, tells once when it goes active, and once when it is deleted", async () => {
    await addChannel(
      {
        label: "Domains",
        events: ["domain_active", "domain_failed"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 120_000,
    );
    const { saas, resourceId } = await withDomain();
    const check = (t: number) => checkExternalDomains({ db: env.DB, api: saas.api, now: () => t });
    const before = listCalls(saas);

    expect(await check(NOW)).toMatchObject({ checked: 1, zones: 1, activated: 0, failed: 0 });
    expect(await recorded(resourceId)).toEqual({ state: "pending", since: NOW });
    expect(await events()).toEqual([]);

    saas.activate("go.customer.test");
    expect(await check(NOW + HALF_HOUR)).toMatchObject({ activated: 1, queued: 1 });
    expect(await recorded(resourceId)).toEqual({ state: "active", since: NOW + HALF_HOUR });
    const [event] = await events();
    expect(event).toMatchObject({
      type: "domain_active",
      dedupe_key: `domain_active:${resourceId}:${NOW}`,
      facts: {
        type: "domain_active",
        hostname: "go.customer.test",
        app: { installId: INSTALL_ID, workerName: "cut" },
      },
    });
    expect(listCalls(saas) - before).toBe(2);

    // Still active: read again (one list), no new event.
    expect(await check(NOW + 2 * HALF_HOUR)).toMatchObject({ checked: 1, zones: 1 });
    expect(listCalls(saas) - before).toBe(3);
    expect(await events()).toHaveLength(1);

    // Deleted in the dashboard: removed, told once.
    saas.world.hostnames = [];
    expect(await check(NOW + 3 * HALF_HOUR)).toMatchObject({ failed: 1, queued: 1 });
    expect(await recorded(resourceId)).toEqual({ state: "removed", since: NOW + 3 * HALF_HOUR });
    await check(NOW + 4 * HALF_HOUR);
    const all = await events();
    expect(all.map((e) => e.dedupe_key)).toEqual([
      `domain_active:${resourceId}:${NOW}`,
      `domain_failed:${resourceId}:${NOW + HALF_HOUR}`,
    ]);
    expect(all[1]?.facts.reason).toBe(
      "Cloudflare no longer has a custom hostname for it; remove the domain on the app's page and add it again.",
    );
  });

  it("tells when an active domain's certificate expires", async () => {
    await addChannel(
      {
        label: "Domains",
        events: ["domain_failed"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 120_000,
    );
    const { saas, resourceId } = await withDomain();
    saas.activate("go.customer.test");
    const check = (t: number) => checkExternalDomains({ db: env.DB, api: saas.api, now: () => t });
    await check(NOW);
    const hostname = saas.world.hostnames[0];
    if (hostname) hostname.ssl.status = "expired";
    expect(await check(NOW + HALF_HOUR)).toMatchObject({ failed: 1 });
    expect(await recorded(resourceId)).toMatchObject({ state: "failed" });
    expect((await events())[0]?.facts.reason).toBe(
      "Its certificate expired and was not renewed. Check that its DNS records are still in place, then remove the domain and add it again.",
    );
  });

  it("tells when a pending domain's custom hostname is gone or its certificate timed out", async () => {
    await addChannel(
      {
        label: "Domains",
        events: ["domain_failed"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 120_000,
    );
    const { saas, resourceId } = await withDomain();
    const other = await addExternalDomainCore(
      { db: env.DB, api: saas.api, now: () => new Date(NOW - 60_000) },
      { installId: INSTALL_ID, hostname: "shop.customer.test", validation: "http" },
    );
    const check = (t: number) => checkExternalDomains({ db: env.DB, api: saas.api, now: () => t });
    await check(NOW);

    saas.world.hostnames = saas.world.hostnames.filter((h) => h.hostname !== "go.customer.test");
    const timedOut = saas.world.hostnames.find((h) => h.hostname === "shop.customer.test");
    if (timedOut) timedOut.ssl.status = "validation_timed_out";
    expect(await check(NOW + HALF_HOUR)).toMatchObject({ checked: 2, failed: 2, queued: 2 });
    expect(Object.fromEntries((await events()).map((e) => [e.dedupe_key, e.facts.reason]))).toEqual(
      {
        [`domain_failed:${other.resourceId}:${NOW}`]:
          "Its certificate was not issued: Cloudflare reports it as validation timed out. Remove the domain and add it again once its DNS records are in place.",
        [`domain_failed:${resourceId}:${NOW}`]:
          "Cloudflare no longer has a custom hostname for it; remove the domain on the app's page and add it again.",
      },
    );
    // Still failed: no second message.
    await check(NOW + 2 * HALF_HOUR);
    expect(await events()).toHaveLength(2);
  });

  it("changes nothing when the zone cannot be listed, and forgets a removed domain", async () => {
    const { saas, resourceId } = await withDomain();
    const check = (t: number) => checkExternalDomains({ db: env.DB, api: saas.api, now: () => t });
    await check(NOW);
    saas.world.noSsl = true;
    saas.activate("go.customer.test");
    expect(await check(NOW + HALF_HOUR)).toMatchObject({ checked: 0, unreadZones: 1 });
    expect(await recorded(resourceId)).toEqual({ state: "pending", since: NOW });

    saas.world.noSsl = false;
    await removeExternalDomainCore(
      { db: env.DB, api: saas.api, now: () => new Date(NOW) },
      { installId: INSTALL_ID, resourceId },
    );
    expect(await check(NOW + 2 * HALF_HOUR)).toMatchObject({ checked: 0 });
    expect(await recorded(resourceId)).toBeNull();
  });

  it("records states without any channel, so a channel added later hears only new changes", async () => {
    const { saas, resourceId } = await withDomain();
    saas.activate("go.customer.test");
    await checkExternalDomains({ db: env.DB, api: saas.api, now: () => NOW });
    expect(await recorded(resourceId)).toMatchObject({ state: "active" });
    expect(await events()).toEqual([]);
  });
});

describe("runExternalDomainCheck", () => {
  it("is idle without external domains, and runs the unit in place without SELF", async () => {
    const cronEnv = {
      DB: env.DB,
      KV: env.KV,
      APPFLARE_VERSION: "0.5.0",
      BETTER_AUTH_SECRET: SECRET,
    };
    expect(await runExternalDomainCheck(cronEnv)).toEqual({ status: "idle" });
    const { saas } = await withDomain();
    expect(await runExternalDomainCheck(cronEnv, { api: saas.api, now: () => NOW })).toEqual({
      status: "ran",
      report: { checked: 1, zones: 1, unreadZones: 0, activated: 0, failed: 0, queued: 0 },
    });
  });
});
