import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readAccountPlan, writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { type FakeRoute, FORBIDDEN, fakeCloudflare } from "../test/fake-cloudflare";
import {
  readCapabilitiesView,
  refreshCapabilitiesAfterVersionChange,
  refreshCapabilitiesForNewToken,
  refreshCapabilitiesIfStale,
} from "./capabilities.server";

const TOKEN = "cfat_TEST-token-value-DO-NOT-LEAK";
const ACC = "acc0000000000000000000000000000a";
const A = `/accounts/${ACC}`;
const MORNING = new Date("2026-09-24T06:00:00.000Z");
const EVENING = new Date("2026-09-24T21:00:00.000Z");
const NEXT_DAY = new Date("2026-09-25T00:30:00.000Z");

/** Answers as recorded live on a Workers Free account with R2 on (ids left out). */
const FREE_ACCOUNT: Record<string, FakeRoute> = {
  [`GET ${A}/r2/buckets`]: { result: { buckets: [{ name: "b" }] } },
  [`GET ${A}/containers/applications`]: {
    status: 401,
    errors: [
      {
        code: 1000,
        message:
          '{"error":"Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan."}',
      },
    ],
  },
  [`GET ${A}/subscriptions`]: {
    result: [
      { rate_plan: { id: "free", scope: "zone" }, state: "Paid" },
      { rate_plan: { id: "r2_paid", scope: "account" }, state: "Paid" },
    ],
    result_info: { page: 1, per_page: 50, total_pages: 1 },
  },
  "GET /zones": {
    result: [{ id: "zone1", name: "example.com", status: "active", type: "full" }],
    result_info: { page: 1, per_page: 1, total_pages: 1 },
  },
  "GET /zones/zone1/email/routing": {
    result: { id: "r1", tag: "r1", name: "example.com", enabled: true, status: "ready" },
  },
  [`GET ${A}/workers/subdomain`]: { result: { subdomain: "appflare-dev" } },
  // No Zero Trust organization yet.
  [`GET ${A}/access/organizations`]: {
    status: 404,
    errors: [{ code: 404, message: "not found" }],
  },
  // Analytics Engine never turned on: the SQL service's own plain-text refusal.
  [`POST ${A}/analytics_engine/sql`]: { status: 403, text: "Authorization error" },
  // A token without "Access: Service Tokens".
  [`GET ${A}/access/service_tokens`]: FORBIDDEN,
};

/** The same account seen with a token that has no "Billing: Read" and no Containers permission. */
const WITHOUT_OPTIONAL_GROUPS: Record<string, FakeRoute> = {
  ...FREE_ACCOUNT,
  [`GET ${A}/containers/applications`]: FORBIDDEN,
  [`GET ${A}/subscriptions`]: FORBIDDEN,
};

const PAID_ACCOUNT: Record<string, FakeRoute> = {
  [`GET ${A}/r2/buckets`]: { result: { buckets: [] } },
  [`GET ${A}/containers/applications`]: { result: [] },
  [`GET ${A}/subscriptions`]: {
    result: [{ rate_plan: { id: "workers_paid", scope: "account" }, state: "Paid" }],
    result_info: { page: 1, per_page: 50, total_pages: 1 },
  },
  // No domain on the account: the Email Routing call is skipped.
  "GET /zones": { result: [], result_info: { page: 1, per_page: 1, total_pages: 0 } },
  [`GET ${A}/workers/subdomain`]: { result: { subdomain: "paid-team" } },
  [`GET ${A}/access/organizations`]: {
    result: { auth_domain: "paid-team.cloudflareaccess.com", name: "paid-team" },
  },
  [`POST ${A}/analytics_engine/sql`]: { result: null },
  [`GET ${A}/access/service_tokens`]: { result: [], result_info: { page: 1, total_pages: 1 } },
};

async function configured() {
  await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
  return { DB: env.DB, CF_API_TOKEN: TOKEN };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("capabilities after a token save", () => {
  it("probes with the new token, one call each, and stores what it found", async () => {
    const api = fakeCloudflare(FREE_ACCOUNT);
    const db = createDb(env.DB);
    await refreshCapabilitiesForNewToken(
      db,
      { accountId: ACC, token: TOKEN, fetch: api.fetch, onRequest: api.onRequest },
      MORNING,
    );
    expect(api.keys().sort()).toEqual([
      `GET ${A}/access/organizations`,
      `GET ${A}/access/service_tokens`,
      `GET ${A}/containers/applications`,
      `GET ${A}/r2/buckets`,
      `GET ${A}/subscriptions`,
      `GET ${A}/workers/subdomain`,
      "GET /zones",
      "GET /zones/zone1/email/routing",
      `POST ${A}/analytics_engine/sql`,
    ]);
    expect(api.calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const view = await readCapabilitiesView(db);
    expect(view).toMatchObject({
      checkedAt: MORNING.toISOString(),
      r2: { state: "enabled" },
      containers: { state: "needs-workers-paid" },
      workersPlan: { state: "free" },
      zone: { state: "available" },
      emailRouting: { state: "available" },
      workersDev: { state: "registered", subdomain: "appflare-dev" },
      zeroTrust: { state: "none" },
      analyticsEngine: { state: "not-enabled" },
      accessServiceTokens: { state: "unknown", reason: "no-permission" },
      plan: { plan: "free", source: "detected" },
    });
    expect(api.calls.find((c) => c.key.endsWith("/analytics_engine/sql"))?.body).toBe(
      "SHOW TABLES",
    );
    const row = await readSettings(db, [SETTING.accountCapabilities]);
    expect(row.account_capabilities).not.toContain(TOKEN);
  });

  it("never fails the save, even when the API cannot be reached", async () => {
    const api = fakeCloudflare({
      [`GET ${A}/r2/buckets`]: "network-error",
      [`GET ${A}/containers/applications`]: "network-error",
      [`GET ${A}/subscriptions`]: "network-error",
    });
    const stored = await refreshCapabilitiesForNewToken(createDb(env.DB), {
      accountId: ACC,
      token: TOKEN,
      fetch: api.fetch,
    });
    expect(stored?.r2).toMatchObject({ state: "unknown", reason: "error" });
  });
});

describe("a failed check", () => {
  it("keeps the last answer of a probe that failed outright, with the new check time", async () => {
    const db = createDb(env.DB);
    const cf = await configured();
    await refreshCapabilitiesIfStale(cf, db, {
      now: MORNING,
      fetch: fakeCloudflare(PAID_ACCOUNT).fetch,
    });
    const down = fakeCloudflare({
      [`GET ${A}/r2/buckets`]: "network-error",
      [`GET ${A}/containers/applications`]: { status: 503 },
      [`GET ${A}/subscriptions`]: FORBIDDEN,
      "GET /zones": "network-error",
      [`GET ${A}/workers/subdomain`]: "network-error",
      [`GET ${A}/access/organizations`]: FORBIDDEN,
    });
    await refreshCapabilitiesIfStale(cf, db, { now: NEXT_DAY, fetch: down.fetch });
    const view = await readCapabilitiesView(db);
    expect(view.checkedAt).toBe(NEXT_DAY.toISOString());
    expect(view.workersDev).toEqual({ state: "registered", subdomain: "paid-team" });
    expect(view.zeroTrust).toMatchObject({ state: "unknown", reason: "no-permission" });
    expect(view.r2).toEqual({ state: "enabled" });
    expect(view.containers).toEqual({ state: "available" });
    expect(view.zone).toEqual({ state: "none" });
    expect(view.emailRouting).toEqual({ state: "no-zone" });
    // A refusal is an answer: the token lost Billing: Read.
    expect(view.workersPlan).toEqual({
      state: "unknown",
      reason: "no-permission",
      detail: "HTTP 403, Cloudflare code 10000",
    });
    expect(view.plan).toEqual({ plan: "paid", source: "detected" });
    // The account id is there for dashboard links only; no probe answer carries it.
    const { accountId, ...answers } = view;
    expect(accountId).toBe(ACC);
    expect(JSON.stringify(answers)).not.toContain(ACC);
  });
});

describe("the Workers plan in force", () => {
  it("is the detected plan, else the admin's, else free", async () => {
    const db = createDb(env.DB);
    const cf = await configured();
    expect(await readAccountPlan(db)).toBe("free");
    await writeAccountPlan(db, "paid");
    expect(await readAccountPlan(db)).toBe("paid");

    // A token without Billing: Read or Containers cannot tell: the admin's plan stays.
    await refreshCapabilitiesIfStale(cf, db, {
      now: MORNING,
      fetch: fakeCloudflare(WITHOUT_OPTIONAL_GROUPS).fetch,
    });
    expect(await readAccountPlan(db)).toBe("paid");
    expect((await readCapabilitiesView(db)).plan).toEqual({ plan: "paid", source: "set-by-you" });

    // Detected free wins over the admin's paid.
    await refreshCapabilitiesIfStale(cf, db, {
      now: NEXT_DAY,
      fetch: fakeCloudflare(FREE_ACCOUNT).fetch,
    });
    expect(await readAccountPlan(db)).toBe("free");
    expect((await readCapabilitiesView(db)).manualPlan).toBe("paid");
  });
});

describe("the cron's check", () => {
  it("runs once per UTC day", async () => {
    const db = createDb(env.DB);
    const cf = await configured();
    const api = fakeCloudflare(PAID_ACCOUNT);
    expect(await refreshCapabilitiesIfStale(cf, db, { now: MORNING, fetch: api.fetch })).toBe(
      "checked",
    );
    expect(await refreshCapabilitiesIfStale(cf, db, { now: EVENING, fetch: api.fetch })).toBe(
      "fresh",
    );
    // Three account probes, the zone list, workers.dev, Zero Trust,
    // Analytics Engine and service tokens; no zone, so no Email Routing read.
    expect(api.calls).toHaveLength(8);
    expect(await refreshCapabilitiesIfStale(cf, db, { now: NEXT_DAY, fetch: api.fetch })).toBe(
      "checked",
    );
    expect(api.calls).toHaveLength(16);
    const view = await readCapabilitiesView(db);
    expect(view.plan).toEqual({ plan: "paid", source: "detected" });
    expect(view.accessServiceTokens).toEqual({ state: "readable" });
    expect(view.analyticsEngine).toEqual({ state: "enabled" });
  });

  it("does nothing before setup has stored a token", async () => {
    const api = fakeCloudflare(PAID_ACCOUNT);
    expect(
      await refreshCapabilitiesIfStale({ DB: env.DB }, createDb(env.DB), { fetch: api.fetch }),
    ).toBe("no-token");
    expect(api.calls).toHaveLength(0);
  });
});

describe("after an update of Appflare", () => {
  /** What a manager from before the service token probe stored: no such probe, no version. */
  const OLDER_ROW = {
    checkedAt: MORNING.toISOString(),
    r2: { state: "enabled" },
    containers: { state: "available" },
    workersPlan: { state: "paid" },
    zone: { state: "none" },
    emailRouting: { state: "no-zone" },
    workersDev: { state: "registered", subdomain: "paid-team" },
    zeroTrust: { state: "exists", teamDomain: "paid-team.cloudflareaccess.com" },
    analyticsEngine: { state: "enabled" },
  };

  it("checks again on the same day when the stored answer lacks a probe this version runs", async () => {
    const db = createDb(env.DB);
    const cf = await configured();
    await writeSettings(db, { [SETTING.accountCapabilities]: JSON.stringify(OLDER_ROW) });
    const api = fakeCloudflare({
      ...PAID_ACCOUNT,
      // The token predates the permission.
      [`GET ${A}/access/service_tokens`]: FORBIDDEN,
    });
    expect(
      await refreshCapabilitiesAfterVersionChange(cf, db, {
        now: EVENING,
        version: "0.2.1",
        fetch: api.fetch,
      }),
    ).toBe("checked");
    const view = await readCapabilitiesView(db);
    expect(view.checkedAt).toBe(EVENING.toISOString());
    expect(view.accessServiceTokens).toMatchObject({ state: "unknown", reason: "no-permission" });
    const row = await readSettings(db, [SETTING.accountCapabilities]);
    expect(JSON.parse(row.account_capabilities ?? "{}")).toMatchObject({ version: "0.2.1" });
  });

  it("checks again when an older version stored the answer, and once only", async () => {
    const db = createDb(env.DB);
    const cf = await configured();
    const api = fakeCloudflare(PAID_ACCOUNT);
    await refreshCapabilitiesIfStale(cf, db, { now: MORNING, version: "0.2.0", fetch: api.fetch });
    expect(api.calls).toHaveLength(8);
    // Same version, same day: nothing to do, from a request or from the cron.
    const same = { now: EVENING, version: "0.2.0", fetch: api.fetch };
    expect(await refreshCapabilitiesAfterVersionChange(cf, db, same)).toBe("fresh");
    expect(await refreshCapabilitiesIfStale(cf, db, same)).toBe("fresh");
    // The first request of the new version.
    const newer = { now: EVENING, version: "0.2.1", fetch: api.fetch };
    expect(await refreshCapabilitiesAfterVersionChange(cf, db, newer)).toBe("checked");
    expect(await refreshCapabilitiesAfterVersionChange(cf, db, newer)).toBe("fresh");
    expect(await refreshCapabilitiesIfStale(cf, db, newer)).toBe("fresh");
    expect(api.calls).toHaveLength(16);
  });

  it("leaves a newer version's answer to the next day", async () => {
    const db = createDb(env.DB);
    const cf = await configured();
    const api = fakeCloudflare(PAID_ACCOUNT);
    // The new version answered its own preview check during a self-update.
    await refreshCapabilitiesIfStale(cf, db, { now: MORNING, version: "0.2.1", fetch: api.fetch });
    const older = { now: EVENING, version: "0.2.0", fetch: api.fetch };
    expect(await refreshCapabilitiesAfterVersionChange(cf, db, older)).toBe("fresh");
    expect(await refreshCapabilitiesIfStale(cf, db, older)).toBe("fresh");
    expect(api.calls).toHaveLength(8);
  });

  it("leaves never-run and earlier-day answers to setup and the cron", async () => {
    const db = createDb(env.DB);
    const cf = await configured();
    const api = fakeCloudflare(PAID_ACCOUNT);
    const first = { now: MORNING, version: "0.2.1", fetch: api.fetch };
    expect(await refreshCapabilitiesAfterVersionChange(cf, db, first)).toBe("fresh");
    await refreshCapabilitiesIfStale(cf, db, first);
    const tomorrow = { now: NEXT_DAY, version: "0.2.1", fetch: api.fetch };
    expect(await refreshCapabilitiesAfterVersionChange(cf, db, tomorrow)).toBe("fresh");
    expect(await refreshCapabilitiesIfStale(cf, db, tomorrow)).toBe("checked");
  });
});
