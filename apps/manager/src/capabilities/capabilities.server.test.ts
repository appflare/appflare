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
  refreshCapabilitiesDaily,
  refreshCapabilitiesForNewToken,
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
      `GET ${A}/containers/applications`,
      `GET ${A}/r2/buckets`,
      `GET ${A}/subscriptions`,
    ]);
    expect(api.calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const view = await readCapabilitiesView(db);
    expect(view).toMatchObject({
      checkedAt: MORNING.toISOString(),
      r2: { state: "enabled" },
      containers: { state: "needs-workers-paid" },
      workersPlan: { state: "free" },
      plan: { plan: "free", source: "detected" },
    });
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
    await refreshCapabilitiesDaily(cf, db, {
      now: MORNING,
      fetch: fakeCloudflare(PAID_ACCOUNT).fetch,
    });
    const down = fakeCloudflare({
      [`GET ${A}/r2/buckets`]: "network-error",
      [`GET ${A}/containers/applications`]: { status: 503 },
      [`GET ${A}/subscriptions`]: FORBIDDEN,
    });
    await refreshCapabilitiesDaily(cf, db, { now: NEXT_DAY, fetch: down.fetch });
    const view = await readCapabilitiesView(db);
    expect(view.checkedAt).toBe(NEXT_DAY.toISOString());
    expect(view.r2).toEqual({ state: "enabled" });
    expect(view.containers).toEqual({ state: "available" });
    // A refusal is an answer: the token lost Billing: Read.
    expect(view.workersPlan).toEqual({
      state: "unknown",
      reason: "no-permission",
      detail: "HTTP 403, Cloudflare code 10000",
    });
    expect(view.plan).toEqual({ plan: "paid", source: "detected" });
    expect(JSON.stringify(view)).not.toContain(ACC);
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
    await refreshCapabilitiesDaily(cf, db, {
      now: MORNING,
      fetch: fakeCloudflare(WITHOUT_OPTIONAL_GROUPS).fetch,
    });
    expect(await readAccountPlan(db)).toBe("paid");
    expect((await readCapabilitiesView(db)).plan).toEqual({ plan: "paid", source: "set-by-you" });

    // Detected free wins over the admin's paid.
    await refreshCapabilitiesDaily(cf, db, {
      now: NEXT_DAY,
      fetch: fakeCloudflare(FREE_ACCOUNT).fetch,
    });
    expect(await readAccountPlan(db)).toBe("free");
    expect((await readCapabilitiesView(db)).manualPlan).toBe("paid");
  });
});

describe("the daily check", () => {
  it("runs once per UTC day", async () => {
    const db = createDb(env.DB);
    const cf = await configured();
    const api = fakeCloudflare(PAID_ACCOUNT);
    expect(await refreshCapabilitiesDaily(cf, db, { now: MORNING, fetch: api.fetch })).toBe(
      "checked",
    );
    expect(await refreshCapabilitiesDaily(cf, db, { now: EVENING, fetch: api.fetch })).toBe(
      "fresh",
    );
    expect(api.calls).toHaveLength(3);
    expect(await refreshCapabilitiesDaily(cf, db, { now: NEXT_DAY, fetch: api.fetch })).toBe(
      "checked",
    );
    expect(api.calls).toHaveLength(6);
    expect((await readCapabilitiesView(db)).plan).toEqual({ plan: "paid", source: "detected" });
  });

  it("does nothing before setup has stored a token", async () => {
    const api = fakeCloudflare(PAID_ACCOUNT);
    expect(
      await refreshCapabilitiesDaily({ DB: env.DB }, createDb(env.DB), { fetch: api.fetch }),
    ).toBe("no-token");
    expect(api.calls).toHaveLength(0);
  });
});
