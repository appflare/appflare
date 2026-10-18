import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import {
  emitUsageEvent,
  type UsageEvent,
  type UsageEventOutcome,
} from "../notifications/usage-events.server";
import { ACC, TOKEN } from "../test/fake-account";
import { type FakeRoute, fakeCloudflare } from "../test/fake-cloudflare";
import { addChannel, SLACK_URL } from "../test/notification-fixtures";
import { ACCOUNT_DAY_READ, HOUR, LEVEL_PRODUCTS } from "./collect";
import { WATCHED_APPS_SQL } from "./collect.server";
import {
  type AnswerRow,
  answerRow,
  fakeGraphQL,
  RECORDED,
  RECORDED_IDS,
  RECORDED_NOW,
} from "./collect-fixtures";
import { spendSnapshotSchema } from "./overview.server";
import type { PauseRequest } from "./pause.server";
import { PauseActionError } from "./pause.server";
import { listActivity, recordActivity } from "./store/activity.server";
import { createAlertRule } from "./store/alert-rules.server";
import { writeAppSpendSettings } from "./store/app-settings.server";
import { writeSpendDefaults } from "./store/defaults.server";
import { readUsage, recordHourlyUsage } from "./store/series.server";
import { readUsageState } from "./store/usage-state.server";
import { recentRows, type SpendWatchDeps, spendWatchLog, watchSpend } from "./watcher.server";
import type { CheckInput } from "./watcher-check.server";
import { HISTORY_KEY } from "./watcher-history.server";
import type { ShardInput } from "./watcher-shard.server";
import { readSpendWatchStatus } from "./watcher-status";
import { createSpendWatcherUnits } from "./watcher-unit";

const NOW = RECORDED_NOW * 1000; // 2026-10-12 16:50 UTC
const HOUR_NOW = Math.floor(RECORDED_NOW / HOUR) * HOUR;
const DAY_MS = 86_400_000;
const DAY_START = Math.floor(NOW / DAY_MS) * DAY_MS;
const db = () => createDb(env.DB);
const A = `/accounts/${ACC}`;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(db(), { [SETTING.accountId]: ACC });
});

async function seedApp(
  id: string,
  opts: {
    worker: string;
    installedAt?: number;
    resources?: Array<{ kind: string; name: string; cfId?: string | null }>;
    manifest?: unknown;
  },
) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
       status, manifest_json, installed_at, updated_at)
     VALUES (?1, ?2, ?2, ?2, '1.0.0', 'https://artifacts.test/x.zip', 'installed', ?3, ?4, ?4)`,
  )
    .bind(
      id,
      opts.worker,
      JSON.stringify(opts.manifest ?? { worker: { bindings: [] } }),
      opts.installedAt ?? NOW - 30 * DAY_MS,
    )
    .run();
  for (const [i, r] of [
    { kind: "worker", name: opts.worker },
    ...(opts.resources ?? []),
  ].entries()) {
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES (?1, ?2, ?3, NULL, ?4, ?5, 1)`,
    )
      .bind(`${id}-r${i}`, id, r.kind, r.name, "cfId" in r ? (r.cfId ?? null) : null)
      .run();
  }
}

/** The recorded app: a Worker, a D1 database, a KV namespace and a Durable Object namespace. */
async function seedRecordedApp(id = "notes", installedAt?: number) {
  await seedApp(id, {
    worker: RECORDED_IDS.worker,
    ...(installedAt === undefined ? {} : { installedAt }),
    resources: [
      { kind: "d1", name: "notes-db", cfId: RECORDED_IDS.d1 },
      { kind: "kv", name: "notes-kv", cfId: RECORDED_IDS.kv },
    ],
  });
}

function world(
  answers: Readonly<Record<string, readonly AnswerRow[]>>,
  opts: {
    namespaces?: Array<{ id: string; script: string }> | FakeRoute;
    /** The answer to the container applications list. */
    containers?: FakeRoute;
    refuse?: { message: string; code?: string; datasets?: readonly string[] };
  } = {},
) {
  const namespaces = opts.namespaces ?? [
    { id: RECORDED_IDS.durableObject, script: RECORDED_IDS.worker },
  ];
  const rest = fakeCloudflare({
    [`GET ${A}/workers/durable_objects/namespaces`]: Array.isArray(namespaces)
      ? { result: namespaces.map((n) => ({ ...n, class: "Store" })) }
      : namespaces,
    [`GET ${A}/containers/applications`]: opts.containers ?? { result: [] },
  });
  const graphql = fakeGraphQL(answers, rest.fetch, opts.refuse);
  const events: UsageEvent[] = [];
  const pauses: PauseRequest[] = [];
  let refusePauses = new Set<string>();
  const deps = (now = NOW): SpendWatchDeps => ({
    now: () => now,
    fetch: graphql.fetch,
    emit: async (_env, event): Promise<UsageEventOutcome> => {
      events.push(event);
      return { status: "skipped", reason: "no-channel" };
    },
    startPause: async (_env, request) => {
      if (refusePauses.has(request.installId)) {
        throw new PauseActionError("Another job of this app is queued or running.");
      }
      pauses.push(request);
      return { jobId: `job-${pauses.length}` };
    },
  });
  return {
    deps,
    events,
    pauses,
    graphql: graphql.sent,
    graphqlRequests: graphql.requests,
    rest: rest.calls,
    refusePause: (ids: string[]) => {
      refusePauses = new Set(ids);
    },
  };
}

const watchEnv = () => ({ ...env, CF_API_TOKEN: TOKEN, SELF: undefined });

async function hourly(installId: string, product: string) {
  const rows = await readUsage(db(), {
    from: HOUR_NOW - 10 * 24 * HOUR,
    to: HOUR_NOW + HOUR,
    grain: "hour",
    installIds: [installId],
  });
  return rows.filter((r) => r.product === product).map((r) => [r.t - HOUR_NOW, r.value]);
}

describe("watchSpend: collect and store", () => {
  it("stores the recorded usage, then writes only hours that changed", async () => {
    await seedRecordedApp();
    const w = world(RECORDED);
    const first = await watchSpend(watchEnv(), {}, w.deps());
    expect(first).toMatchObject({ status: "watching", apps: 1, newApps: 0, history: "database" });
    // The namespace list, then one request asking for every dataset at once:
    // the app's resources, and on Workers Free the whole account's totals
    // for the daily limits (no resource ids, since 00:00 UTC).
    expect(first.subrequests).toBe(1 + 1);
    expect(w.graphqlRequests.count).toBe(1);
    expect(w.graphql).toHaveLength(9 + ACCOUNT_DAY_READ.length);
    const byResource = w.graphql.filter((s) =>
      Object.keys(s.filter).some((k) => k.endsWith("_in")),
    );
    expect(byResource).toHaveLength(9);
    expect(new Set(byResource.map((s) => s.dataset)).size).toBe(byResource.length);
    const totals = w.graphql.filter((s) => !byResource.includes(s));
    expect(totals.every((s) => s.filter.datetime_geq === new Date(DAY_START).toISOString())).toBe(
      true,
    );
    expect(await hourly("notes", "workers_requests")).toEqual([
      [-4 * HOUR, 2],
      [-3 * HOUR, 2],
      [-2 * HOUR, 2],
      [-HOUR, 2],
      [0, 1],
    ]);
    // Storage has a point for every hour from the first sample on.
    expect(await hourly("notes", "do_storage")).toHaveLength(5);
    expect(first.rowsWritten).toBeGreaterThan(20);
    // The account's day is the app's own here: nothing else in the recorded account.
    const status = await readSpendWatchStatus(db());
    expect(status).toMatchObject({ state: "watching", at: NOW, account: { at: NOW } });
    const todays = async (product: string) =>
      (await hourly("notes", product))
        .filter(([t]) => (t ?? 0) + HOUR_NOW >= DAY_START / 1000)
        .reduce((sum, [, v]) => sum + (v ?? 0), 0);
    expect(status?.account?.used.workers_requests).toBe(await todays("workers_requests"));
    expect(status?.account?.used.d1_rows_read).toBe(await todays("d1_rows_read"));
    expect(status?.account?.used.queues_operations).toBe(0);

    // Five minutes later the analytics say the same: nothing to write.
    const second = await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(second.rowsWritten).toBe(0);
    expect(second.history).toBe("cache");
    // Only the recent hours are read again.
    const workers = w.graphql.filter(
      (s) => s.dataset === "workersInvocationsAdaptive" && "scriptName_in" in s.filter,
    );
    expect(workers[1]?.filter.datetime_geq).toBe(
      new Date((HOUR_NOW - 3 * HOUR - 3 * HOUR) * 1000).toISOString(),
    );
    expect(spendWatchLog(second)).toMatch(
      /^spend watcher: watching, 1 app\(s\), 0 row\(s\) written/,
    );
  });

  it("writes an hour again when the analytics' number grew", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(RECORDED).deps());
    const grown = {
      ...RECORDED,
      workersInvocationsAdaptive: [
        ...(RECORDED.workersInvocationsAdaptive ?? []).filter(
          (r) => r.dimensions.datetimeHour !== "2026-10-12T16:00:00Z",
        ),
        answerRow("scriptName", "notes", HOUR_NOW, { sum: { requests: 7, cpuTimeUs: 136516 } }),
      ],
    };
    const report = await watchSpend(watchEnv(), {}, world(grown).deps(NOW + 5 * 60_000));
    expect(report.rowsWritten).toBe(1);
    expect((await hourly("notes", "workers_requests")).at(-1)).toEqual([0, 7]);
  });

  it("leaves an app younger than 15 minutes for later", async () => {
    await seedRecordedApp("notes", NOW - 5 * 60_000);
    const w = world(RECORDED);
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report).toMatchObject({ status: "watching", apps: 0, newApps: 1, rowsWritten: 0 });
    // Nothing of the app; on Workers Free, the account's totals alone.
    expect(w.graphql).toHaveLength(ACCOUNT_DAY_READ.length);
    expect(w.graphql.some((s) => Object.keys(s.filter).some((k) => k.endsWith("_in")))).toBe(false);
    expect((await readUsageState(db(), "notes")).lastCheckedAt).toBeNull();

    // Its first check reads from its install on.
    const later = await watchSpend(watchEnv(), {}, w.deps(NOW + 20 * 60_000));
    expect(later.apps).toBe(1);
    expect(w.graphql.find((s) => "scriptName_in" in s.filter)?.filter.datetime_geq).toBe(
      new Date((HOUR_NOW - 3 * HOUR) * 1000).toISOString(),
    );
  });
});

describe("watchSpend: access", () => {
  it("does nothing without the analytics scopes, and says so", async () => {
    await seedRecordedApp();
    await env.DB.prepare(
      `INSERT INTO cloudflare_grant (id, client_id, scopes_json, refresh_token, access_token,
         access_expires_at, key_id, status, connected_at, refreshed_at)
       VALUES ('g', 'c', ?1, 'sealed', 'sealed', ?2, 'k', 'connected', 1, 1)`,
    )
      .bind(JSON.stringify(["account-settings.read", "workers-scripts.write"]), NOW + 3_600_000)
      .run();
    const w = world(RECORDED);
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report.status).toBe("needs_access");
    expect(w.graphql).toEqual([]);
    expect(w.rest).toEqual([]);
    expect(await readSpendWatchStatus(db())).toEqual({
      state: "needs_access",
      at: NOW,
      via: "oauth",
      missing: ["account-analytics.read"],
    });
  });

  it("says so when Cloudflare refuses the token the analytics", async () => {
    await seedRecordedApp();
    const w = world(RECORDED, {
      refuse: { message: "not authorized for that account", code: "authz" },
    });
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report.status).toBe("needs_access");
    expect(await readSpendWatchStatus(db())).toMatchObject({ state: "needs_access", via: "token" });
    expect(await hourly("notes", "workers_requests")).toEqual([]);
  });

  it("does not take a refusal without Cloudflare's permission code for missing access", async () => {
    await seedRecordedApp();
    const w = world(RECORDED, { refuse: { message: "access to this dataset is limited" } });
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report.status).toBe("watching");
    expect(report.failedReads?.length).toBeGreaterThan(0);
    // Nothing was read: the app keeps its last check's time, so the next reads it all again.
    expect((await readUsageState(db(), "notes")).lastCheckedAt).toBeNull();
  });

  it("records a failure of the check itself without throwing", async () => {
    await seedRecordedApp();
    await env.DB.prepare("DROP TABLE app_usage_state").run();
    const report = await watchSpend(watchEnv(), {}, world(RECORDED).deps());
    expect(report.status).toBe("failed");
    expect(await readSpendWatchStatus(db())).toMatchObject({ state: "failed" });
  });
});

describe("watchSpend: a read that fails", () => {
  it("leaves out only what it covers; the rest is stored and judged", async () => {
    await seedRecordedApp();
    await seedApp("other", { worker: "other" });
    const answers = {
      ...RECORDED,
      workersInvocationsAdaptive: [
        ...(RECORDED.workersInvocationsAdaptive ?? []),
        answerRow("scriptName", "other", HOUR_NOW, { sum: { requests: 9, cpuTimeUs: 1000 } }),
      ],
    };
    const w = world(answers, {
      refuse: { message: "timeout", datasets: ["d1AnalyticsAdaptiveGroups"] },
    });
    const report = await watchSpend(watchEnv(), {}, w.deps());
    // The account's totals lose D1 too, and keep the rest.
    expect(report).toMatchObject({ status: "watching", failedReads: ["d1", "account"] });
    expect(spendWatchLog(report)).toContain("failed reads: d1, account");
    const used = (await readSpendWatchStatus(db()))?.account?.used ?? {};
    expect(used.d1_rows_written).toBeUndefined();
    expect(used.workers_requests).toBeGreaterThan(0);
    // The rest of the app's usage, and the other app's, are stored.
    expect(await hourly("notes", "workers_requests")).toHaveLength(5);
    expect(await hourly("notes", "kv_storage")).toHaveLength(5);
    expect(await hourly("other", "workers_requests")).toEqual([[0, 9]]);
    // Not the products of the failed read, not even storage carried forward.
    expect(await hourly("notes", "d1_rows_read")).toEqual([]);
    expect(await hourly("notes", "d1_storage")).toEqual([]);
    // Only the app fully read counts as checked now.
    expect((await readUsageState(db(), "other")).lastCheckedAt).toBe(NOW);
    expect((await readUsageState(db(), "notes")).lastCheckedAt).toBeNull();
  });
});

describe("watchSpend: an account list that fails", () => {
  it("leaves out only containers when the container applications are not listed", async () => {
    await writeAccountPlan(db(), "paid");
    await seedRecordedApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world(RECORDED, { containers: { result: { applications: [] } } });
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report).toMatchObject({ status: "watching" });
    expect(warn).toHaveBeenCalledWith("spend watcher: container applications not listed", {
      error: expect.stringContaining("container applications"),
    });
    warn.mockRestore();
    // The namespaces were read: Durable Objects and their alarms are.
    expect(await hourly("notes", "do_storage")).toHaveLength(5);
    expect(w.graphql.some((s) => s.filter.type === "alarm")).toBe(true);
    // Containers are not, so the app does not count as checked.
    expect((await readUsageState(db(), "notes")).lastCheckedAt).toBeNull();
  });

  it("leaves out Durable Objects, their alarms and containers when the namespaces are not listed", async () => {
    await writeAccountPlan(db(), "paid");
    await seedRecordedApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world(RECORDED, {
      namespaces: { status: 500, errors: [{ code: 10000, message: "internal error" }] },
    });
    const report = await watchSpend(watchEnv(), {}, w.deps());
    expect(report).toMatchObject({ status: "watching" });
    expect(warn).toHaveBeenCalledWith("spend watcher: Durable Object namespaces not listed", {
      error: expect.any(String),
    });
    warn.mockRestore();
    expect(await hourly("notes", "do_storage")).toEqual([]);
    expect(await hourly("notes", "workers_requests")).toHaveLength(5);
    expect(w.rest.some((c) => c.key === `GET ${A}/containers/applications`)).toBe(false);
  });
});

describe("watchSpend: the account's free daily limits", () => {
  const OTHER_DB = "ffffffff-0000-4000-8000-000000000001";
  /**
   * The recorded app writing 300 D1 rows an hour for the last three hours,
   * and, with `other`, a database Appflare did not install that wrote that
   * many rows early today.
   */
  function d1Answers(other: number, perHour = 300): Record<string, AnswerRow[]> {
    const own = [HOUR_NOW - 2 * HOUR, HOUR_NOW - HOUR, HOUR_NOW].map((h) =>
      answerRow("databaseId", RECORDED_IDS.d1, h, { sum: { rowsRead: 0, rowsWritten: perHour } }),
    );
    const outside =
      other > 0
        ? [
            answerRow("databaseId", OTHER_DB, DAY_START / 1000 + 2 * HOUR, {
              sum: { rowsRead: 0, rowsWritten: other },
            }),
          ]
        : [];
    return { ...RECORDED, d1AnalyticsAdaptiveGroups: [...own, ...outside] };
  }

  it("warns an app on pace to use up a limit mostly used by others, with its share of the account's", async () => {
    await seedRecordedApp();
    // The app: 2,500 rows an hour (7,500 today); outside: 78,000. The account is
    // at 85.5%, under the account warning, and on pace to run out at the app's pace.
    const w = world(d1Answers(78_000, 2_500));
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.events.filter((e) => e.type === "usage_account_limit")).toEqual([]);
    const near = w.events.filter((e) => e.type === "usage_limit_near");
    expect(near).toEqual([
      expect.objectContaining({ installId: "notes", product: "d1_rows_written", used: 85_500 }),
    ]);
    const event = near[0] as Extract<UsageEvent, { type: "usage_limit_near" }>;
    // The app's share is of the whole account's use.
    expect(event.appShare).toBeCloseTo(7_500 / 85_500, 6);
    expect(event.otherShare).toBeCloseTo(78_000 / 85_500, 6);
    const [entry] = await listActivity(db(), { installId: "notes", kinds: ["limit_near"] });
    expect(entry?.facts).toMatchObject({
      product: "d1_rows_written",
      otherShare: event.otherShare,
    });
  });

  it("warns the account at 90% of a limit once a day; the app's warning skips the account's channels", async () => {
    await seedRecordedApp();
    const w = world(d1Answers(98_000));
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.events.filter((e) => e.type === "usage_account_limit")).toEqual([
      {
        type: "usage_account_limit",
        product: "d1_rows_written",
        limit: 100_000,
        used: 98_900,
        otherShare: 98_000 / 98_900,
        top: { installId: "notes", share: 900 / 98_900 },
      },
    ]);
    // The app is on pace to run it out too: warned, but not on the channels the
    // account's warning reached.
    expect(w.events.filter((e) => e.type === "usage_limit_near")).toEqual([
      expect.objectContaining({
        installId: "notes",
        product: "d1_rows_written",
        exceptChannelsWith: "usage_account_limit",
      }),
    ]);
    const entries = await listActivity(db(), { installId: null, kinds: ["limit_near"] });
    expect(entries.map((e) => e.facts)).toEqual([
      expect.objectContaining({ product: "d1_rows_written", account: true, used: 98_900 }),
    ]);
    // Five minutes on: nothing more, from the account or the app.
    await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.events.filter((e) => e.type.startsWith("usage_"))).toHaveLength(2);
    // Used up later that day: recorded for Home, without a second message.
    await watchSpend(watchEnv(), {}, world(d1Answers(99_500)).deps(NOW + 10 * 60_000));
    const latest = await listActivity(db(), { installId: null, kinds: ["limit_near"] });
    expect(latest[0]?.facts).toMatchObject({ share: 100_400 / 100_000 });
    expect(w.events.filter((e) => e.type.startsWith("usage_"))).toHaveLength(2);
  });

  it("warns the account about a limit an app was warned about first, past the app's channels", async () => {
    await seedRecordedApp();
    await recordActivity(db(), {
      installId: "notes",
      kind: "limit_near",
      facts: { product: "d1_rows_written", share: 0.8, runsOutAt: NOW + HOUR * 1000 },
      at: new Date(NOW - 60 * 60_000),
    });
    const w = world(d1Answers(98_000));
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.events.filter((e) => e.type === "usage_account_limit")).toEqual([
      expect.objectContaining({
        product: "d1_rows_written",
        exceptChannelsWith: "usage_limit_near",
      }),
    ]);
  });

  describe("each channel hears about a limit once a day", () => {
    const deliveries = async () =>
      (
        await env.DB.prepare(
          `SELECT c.label AS channel, e.type AS type FROM notification_deliveries d
           JOIN notification_events e ON e.id = d.event_id
           JOIN notification_channels c ON c.id = d.channel_id ORDER BY c.label, e.type`,
        ).all<{ channel: string; type: string }>()
      ).results.map((r) => `${r.channel}: ${r.type}`);
    const channel = (label: string, events: Array<"usage_limit_near" | "usage_account_limit">) =>
      addChannel(
        { label, events, settings: { kind: "slack", webhookUrl: SLACK_URL } },
        NOW - DAY_MS,
      );

    it("one that gets both hears the first; one that gets one event always hears it", async () => {
      await seedRecordedApp();
      await channel("both", ["usage_limit_near", "usage_account_limit"]);
      await channel("app only", ["usage_limit_near"]);
      await channel("account only", ["usage_account_limit"]);
      // The account's warning first, then the app's in the same check.
      await watchSpend(
        watchEnv(),
        {},
        { ...world(d1Answers(98_000)).deps(), emit: emitUsageEvent },
      );
      expect(await deliveries()).toEqual([
        "account only: usage_account_limit",
        "app only: usage_limit_near",
        "both: usage_account_limit",
      ]);
    });

    it("after an app's warning, the account's reaches only the channels that did not hear it", async () => {
      await seedRecordedApp();
      await channel("both", ["usage_limit_near", "usage_account_limit"]);
      await channel("account only", ["usage_account_limit"]);
      // The app was warned an hour ago, under the account's 90%.
      await watchSpend(
        watchEnv(),
        {},
        { ...world(d1Answers(78_000, 4_000)).deps(NOW - 60 * 60_000), emit: emitUsageEvent },
      );
      expect(await deliveries()).toEqual(["both: usage_limit_near"]);
      await watchSpend(
        watchEnv(),
        {},
        { ...world(d1Answers(80_000, 4_000)).deps(), emit: emitUsageEvent },
      );
      expect(await deliveries()).toEqual([
        "account only: usage_account_limit",
        "both: usage_limit_near",
      ]);
    });
  });

  describe("with no app to read", () => {
    /** Outside usage only: a database Appflare did not install wrote 95,000 rows today. */
    const OUTSIDE = {
      d1AnalyticsAdaptiveGroups: [
        answerRow("databaseId", OTHER_DB, DAY_START / 1000 + 2 * HOUR, {
          sum: { rowsRead: 0, rowsWritten: 95_000 },
        }),
      ],
    };
    const limitsChannel = () =>
      addChannel(
        {
          label: "Limits",
          events: ["usage_account_limit"],
          settings: { kind: "slack", webhookUrl: SLACK_URL },
        },
        NOW - DAY_MS,
      );
    const outbox = async () =>
      (
        await env.DB.prepare(
          `SELECT e.type, d.status FROM notification_events e
           JOIN notification_deliveries d ON d.event_id = e.id`,
        ).all<{ type: string; status: string }>()
      ).results;

    it("Workers Free, no apps: reads the account alone and warns past 90%", async () => {
      await limitsChannel();
      const w = world(OUTSIDE);
      const deps = { ...w.deps(), emit: emitUsageEvent };
      const kicks: string[] = [];
      const self: Record<string, (input: unknown) => Promise<unknown>> = {};
      const units = createSpendWatcherUnits({ ...watchEnv(), SELF: self }, deps);
      self.spendCheck = (input: unknown) => units.spendCheck(structuredClone(input));
      self.spendShard = (input: unknown) => units.spendShard(structuredClone(input));
      self.deliverNotifications = async (input: unknown) => {
        kicks.push((input as { eventId: string }).eventId);
        return { ok: true, value: { sent: 0, retrying: 0, failed: 0 } };
      };
      const report = await watchSpend({ ...watchEnv(), SELF: self }, {}, deps);
      expect(report).toMatchObject({ status: "watching", apps: 0 });
      // One request for the account's datasets, and nothing about apps.
      expect(w.graphqlRequests.count).toBe(1);
      expect(w.graphql).toHaveLength(ACCOUNT_DAY_READ.length);
      expect(w.rest).toEqual([]);
      // The check's own invocation, the request, and asking for the message to be sent.
      expect(report.subrequests).toBe(3);
      expect((await readSpendWatchStatus(db()))?.account?.used.d1_rows_written).toBe(95_000);
      const entries = await listActivity(db(), { installId: null, kinds: ["limit_near"] });
      expect(entries.map((e) => e.facts)).toEqual([
        expect.objectContaining({ product: "d1_rows_written", used: 95_000, otherShare: 1 }),
      ]);
      expect(await outbox()).toEqual([{ type: "usage_account_limit", status: "pending" }]);
      expect(kicks).toHaveLength(1);
    });

    it("Workers Free, every app too new: the same, and the app is left for later", async () => {
      await seedRecordedApp("notes", NOW - 5 * 60_000);
      await limitsChannel();
      const w = world(OUTSIDE);
      const report = await watchSpend(watchEnv(), {}, { ...w.deps(), emit: emitUsageEvent });
      expect(report).toMatchObject({ status: "watching", apps: 0, newApps: 1 });
      expect(w.graphql).toHaveLength(ACCOUNT_DAY_READ.length);
      expect((await readUsageState(db(), "notes")).lastCheckedAt).toBeNull();
      expect(await listActivity(db(), { installId: null, kinds: ["limit_near"] })).toHaveLength(1);
      expect(await outbox()).toEqual([{ type: "usage_account_limit", status: "pending" }]);
    });

    it("Workers Paid, no apps: no read of the account", async () => {
      await writeAccountPlan(db(), "paid");
      await limitsChannel();
      const w = world(OUTSIDE);
      const report = await watchSpend(watchEnv(), {}, { ...w.deps(), emit: emitUsageEvent });
      expect(report).toMatchObject({ status: "watching", apps: 0, subrequests: 0 });
      expect(w.graphql).toEqual([]);
      expect((await readSpendWatchStatus(db()))?.account).toBeUndefined();
      expect(await listActivity(db(), { kinds: ["limit_near"] })).toEqual([]);
      expect(await outbox()).toEqual([]);
    });
  });

  it("puts the account's warning in the outbox even when judging the apps fails", async () => {
    await seedRecordedApp();
    await addChannel(
      {
        label: "Limits",
        events: ["usage_account_limit"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - DAY_MS,
    );
    const report = await watchSpend(
      watchEnv(),
      {},
      {
        ...world(d1Answers(98_000)).deps(),
        emit: (e, event, d) => {
          if (event.type === "usage_account_limit") return emitUsageEvent(e, event, d);
          // Judging the app sends its own warning: make that blow up.
          throw new Error("judging failed");
        },
      },
    );
    expect(report.status).toBe("failed");
    const row = await env.DB.prepare(
      `SELECT e.type, d.status FROM notification_events e
       JOIN notification_deliveries d ON d.event_id = e.id`,
    ).all<{ type: string; status: string }>();
    // The scheduled run sends it.
    expect(row.results).toEqual([{ type: "usage_account_limit", status: "pending" }]);
  });

  it("stores nothing of what is not Appflare's", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(d1Answers(98_000)).deps());
    // Nothing of the other database is stored or attributed.
    expect(
      (await readUsage(db(), { from: 0, to: HOUR_NOW + HOUR, grain: "hour" })).every(
        (r) => r.installId === "notes",
      ),
    ).toBe(true);
    expect(await hourly("notes", "d1_rows_written")).toEqual([
      [-2 * HOUR, 300],
      [-HOUR, 300],
      [0, 300],
    ]);
  });

  it("does not warn about the same app without the other usage", async () => {
    await seedRecordedApp();
    const w = world(d1Answers(0));
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.events.filter((e) => e.type === "usage_limit_near")).toEqual([]);
  });

  it("hands the account's totals to the check's own invocation on Workers Free", async () => {
    await seedRecordedApp();
    const w = world(d1Answers(98_000));
    const checks: CheckInput[] = [];
    const self: Record<string, (input: unknown) => Promise<unknown>> = {};
    const units = createSpendWatcherUnits({ ...watchEnv(), SELF: self }, w.deps());
    self.spendCheck = (input: unknown) => {
      checks.push(input as CheckInput);
      return units.spendCheck(structuredClone(input));
    };
    self.spendShard = (input: unknown) => units.spendShard(structuredClone(input));
    await watchSpend({ ...watchEnv(), SELF: self }, {}, w.deps());
    expect(checks[0]?.accountToday?.d1_rows_written).toBe(98_900);
    // The account's warning, once, from the check's own invocation; no app's.
    // The account's warning from the check's own invocation; the app's from its
    // part, past the channels the account's reached.
    expect(w.events.map((e) => e.type)).toEqual(["usage_account_limit", "usage_limit_near"]);
    expect(w.events[1]).toMatchObject({ exceptChannelsWith: "usage_account_limit" });
  });

  it("reads no account totals on Workers Paid", async () => {
    await writeAccountPlan(db(), "paid");
    await seedRecordedApp();
    const w = world(d1Answers(98_000));
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.graphql).toHaveLength(9);
    expect(w.graphql.every((s) => Object.keys(s.filter).some((k) => k.endsWith("_in")))).toBe(true);
    expect((await readSpendWatchStatus(db()))?.account).toBeUndefined();
    expect(
      w.events.filter((e) => e.type === "usage_limit_near" || e.type === "usage_account_limit"),
    ).toEqual([]);
    expect(await listActivity(db(), { kinds: ["limit_near"] })).toEqual([]);
  });

  it("merges a partly failed reading with today's earlier one, and judges with the merge", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(d1Answers(98_000)).deps());
    const before = (await readSpendWatchStatus(db()))?.account?.used ?? {};
    expect(before.d1_rows_written).toBe(98_900);
    // Five minutes on, the outside database wrote more, but D1's total cannot be read:
    // D1 keeps the earlier total, every other product is read anew.
    const later = d1Answers(99_500);
    later.workersInvocationsAdaptive = [
      ...(later.workersInvocationsAdaptive ?? []),
      answerRow("scriptName", "not-appflare", HOUR_NOW, { sum: { requests: 40_000 } }),
    ];
    const noD1 = world(later, {
      refuse: { message: "timeout", datasets: ["d1AnalyticsAdaptiveGroups"] },
    });
    const checks: CheckInput[] = [];
    const self: Record<string, (input: unknown) => Promise<unknown>> = {};
    const units = createSpendWatcherUnits({ ...watchEnv(), SELF: self }, noD1.deps());
    self.spendCheck = (input: unknown) => {
      checks.push(input as CheckInput);
      return units.spendCheck(structuredClone(input));
    };
    self.spendShard = (input: unknown) => units.spendShard(structuredClone(input));
    await watchSpend({ ...watchEnv(), SELF: self }, {}, noD1.deps(NOW + 5 * 60_000));
    const merged = (await readSpendWatchStatus(db()))?.account;
    expect(merged?.at).toBe(NOW + 5 * 60_000);
    expect(merged?.used.d1_rows_written).toBe(98_900);
    expect(merged?.used.workers_requests).toBe((before.workers_requests ?? 0) + 40_000);
    expect(merged?.used.kv_reads).toBe(before.kv_reads);
    // The check's own invocation judges the limits with the merged reading.
    expect(checks[0]?.accountToday?.d1_rows_written).toBe(98_900);
    expect(checks[0]?.accountToday?.workers_requests).toBe(merged?.used.workers_requests);
  });

  it("keeps the day's last reading through a check that reads none, and drops it the next day", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(d1Answers(98_000)).deps());
    const failing = world(RECORDED, { refuse: { message: "timeout" } });
    await watchSpend(watchEnv(), {}, failing.deps(NOW + 5 * 60_000));
    const kept = await readSpendWatchStatus(db());
    expect(kept).toMatchObject({ state: "watching", at: NOW + 5 * 60_000, account: { at: NOW } });
    expect(kept?.account?.used.d1_rows_written).toBe(98_900);
    await watchSpend(watchEnv(), {}, failing.deps(DAY_START + DAY_MS + 60_000));
    expect((await readSpendWatchStatus(db()))?.account).toBeUndefined();
  });
});

/** Ten calm days of Durable Object use, stored as the watcher would have. */
async function seedCalmHistory(installId: string) {
  const rows = [];
  for (let h = HOUR_NOW - 10 * 24 * HOUR; h < HOUR_NOW - 8 * HOUR; h += HOUR) {
    rows.push({ installId, product: "do_requests", hour: h, value: 1_440 });
    rows.push({ installId, product: "do_rows_written", hour: h, value: 2_880 });
  }
  await recordHourlyUsage(db(), rows, { levels: LEVEL_PRODUCTS, now: new Date(NOW) });
}

/** A Durable Object alarm loop over the last three hours: about $10 an hour. */
function loopAnswers(namespace: string): Record<string, AnswerRow[]> {
  const hours = [HOUR_NOW - 2 * HOUR, HOUR_NOW - HOUR, HOUR_NOW];
  return {
    durableObjectsInvocationsAdaptiveGroups: hours.map((h) =>
      answerRow("namespaceId", namespace, h, { sum: { requests: 5e6 } }),
    ),
    durableObjectsPeriodicGroups: hours.map((h) =>
      answerRow("namespaceId", namespace, h, { sum: { rowsWritten: 10e6, duration: 0 } }),
    ),
    alarms: hours.map((h) =>
      answerRow("namespaceId", namespace, h, { sum: { requests: 5e6 } }, { objectId: "obj" }),
    ),
  };
}

describe("watchSpend: judging", () => {
  async function seedLoopingApp(id: string, ns: string) {
    await seedApp(id, { worker: id });
    await seedCalmHistory(id);
    return { id: ns, script: id };
  }

  it("alerts unusual usage once and pauses a loop on the second check in a row", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    await writeAppSpendSettings(
      db(),
      "loopy",
      { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
      { userId: "u", now: new Date(NOW - DAY_MS) },
    );
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });

    const first = await watchSpend(watchEnv(), {}, w.deps());
    expect(w.events.filter((e) => e.type === "usage_unusual")).toHaveLength(1);
    expect(w.pauses).toEqual([]);
    expect((await readUsageState(db(), "loopy")).loopChecks).toBe(1);
    const started = await listActivity(db(), { installId: "loopy", kinds: ["unusual_started"] });
    expect(started).toHaveLength(1);
    expect(started[0]?.facts).toMatchObject({ factor: 20, product: expect.stringMatching(/^do_/) });
    expect(first.alerts).toBe(w.events.length);

    const second = await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.events.filter((e) => e.type === "usage_unusual")).toHaveLength(1);
    expect(w.pauses).toEqual([
      {
        installId: "loopy",
        reason: "loop",
        by: null,
        detail: expect.objectContaining({
          level: "strict",
          plan: "free",
          alarms: expect.any(Number),
        }),
      },
    ]);
    expect(second.pauses).toBe(1);
  });

  it("does not pause with auto-pause off (the default)", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });
    await watchSpend(watchEnv(), {}, w.deps());
    await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.pauses).toEqual([]);
    expect((await readUsageState(db(), "loopy")).loopChecks).toBe(2);
  });

  it("sends a usage alert once per period", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    await createAlertRule(
      db(),
      "loopy",
      { kind: "spent", unit: "usd", amount: 5, period: "day" },
      { userId: "u", now: new Date(NOW - DAY_MS) },
    );
    await writeAccountPlan(db(), "paid");
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });
    await watchSpend(watchEnv(), {}, w.deps());
    await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.events.filter((e) => e.type === "usage_alert")).toEqual([
      expect.objectContaining({ sentence: "When it has spent $5.00 today", period: "day" }),
    ]);
    const sent = await listActivity(db(), { installId: "loopy", kinds: ["alert_sent"] });
    expect(sent).toHaveLength(1);
  });

  it("pauses one app per check for the budget, and waits while the biggest is busy", async () => {
    await writeAccountPlan(db(), "paid");
    await writeSpendDefaults(db(), { budget: { on: true, amount: 10 } });
    const big = await seedLoopingApp("big", "ns-big");
    const small = await seedLoopingApp("small", "ns-small");
    const answers = loopAnswers("ns-big");
    for (const [k, rows] of Object.entries(loopAnswers("ns-small"))) {
      answers[k] = [
        ...(answers[k] ?? []),
        ...rows.map((r) => ({ ...r, sum: { requests: 1e6, rowsWritten: 2e6, duration: 0 } })),
      ];
    }
    const w = world(answers, { namespaces: [big, small] });
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.pauses).toEqual([
      expect.objectContaining({ installId: "big", reason: "budget", by: null }),
    ]);
    expect(w.events.filter((e) => e.type === "budget_reached")).toHaveLength(1);

    w.refusePause(["big"]);
    const second = await watchSpend(watchEnv(), {}, w.deps(NOW + 5 * 60_000));
    expect(w.pauses.map((p) => p.installId)).toEqual(["big"]);
    expect(second.deferred).toBe(1);
    // The budget is told once a month.
    expect(w.events.filter((e) => e.type === "budget_reached")).toHaveLength(1);
  });

  it("holds off pausing an app for an hour after its pause failed", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    await writeAppSpendSettings(
      db(),
      "loopy",
      { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
      { userId: "u", now: new Date(NOW - DAY_MS) },
    );
    await env.DB.prepare(
      "INSERT INTO app_usage_state (install_id, loop_checks) VALUES ('loopy', 1)",
    ).run();
    await recordActivity(db(), {
      installId: "loopy",
      kind: "pause_failed",
      facts: { reason: "loop", jobId: "j1", error: "the stand-in did not deploy" },
      at: new Date(NOW - 30 * 60_000),
    });
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });
    await watchSpend(watchEnv(), {}, w.deps());
    expect(w.pauses).toEqual([]);
    // An hour after the failure, it is paused again.
    await watchSpend(watchEnv(), {}, w.deps(NOW + 31 * 60_000));
    expect(w.pauses.map((p) => p.installId)).toEqual(["loopy"]);
  });

  it("starts pauses before it sends notifications", async () => {
    const ns = await seedLoopingApp("loopy", "ns-loopy");
    await writeAppSpendSettings(
      db(),
      "loopy",
      { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
      { userId: "u", now: new Date(NOW - DAY_MS) },
    );
    await env.DB.prepare(
      "INSERT INTO app_usage_state (install_id, loop_checks) VALUES ('loopy', 1)",
    ).run();
    const order: string[] = [];
    const w = world(loopAnswers("ns-loopy"), { namespaces: [ns] });
    const deps = w.deps();
    const report = await watchSpend(
      watchEnv(),
      {},
      {
        ...deps,
        // Room for the reads and one more subrequest only.
        budget: 11,
        startPause: async (e, r) => {
          order.push("pause");
          return (deps.startPause ?? (() => Promise.reject(new Error("no"))))(e, r);
        },
        emit: async (e, ev, d) => {
          // Into the outbox only (no `SELF`): no subrequest, so it may come first.
          order.push(`send ${ev.type}${e.SELF === undefined ? " (outbox)" : ""}`);
          return (deps.emit ?? (() => Promise.reject(new Error("no"))))(e, ev, d);
        },
      },
    );
    expect(order.filter((o) => !o.endsWith("(outbox)"))[0]).toBe("pause");
    expect(order).toContain("send usage_account_limit (outbox)");
    expect(report.pauses).toBe(1);
  });

  it("stores the pages' numbers every check", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(RECORDED).deps());
    const raw = (await readSettings(db(), [SETTING.spendOverview]))[SETTING.spendOverview];
    const snapshot = spendSnapshotSchema.parse(JSON.parse(raw ?? "null"));
    expect(snapshot.computedAt).toBe(NOW);
    expect(snapshot.apps.map((a) => a.installId)).toEqual(["notes"]);
  });

  describe("on Workers Free, in parts over SELF", () => {
    /**
     * A `SELF` whose `spendCheck` and `spendShard` run the units here (each
     * input cloned, as over RPC), recording each one's input.
     */
    function selfFor(deps: SpendWatchDeps) {
      const parts: ShardInput[] = [];
      const checks: CheckInput[] = [];
      const self: Record<string, (input: unknown) => Promise<unknown>> = {};
      const units = createSpendWatcherUnits({ ...watchEnv(), SELF: self }, deps);
      self.spendCheck = (input: unknown) => {
        checks.push(input as CheckInput);
        return units.spendCheck(structuredClone(input));
      };
      self.spendShard = (input: unknown) => {
        parts.push(input as ShardInput);
        return units.spendShard(structuredClone(input));
      };
      return { parts, checks, self };
    }
    const snapshot = async () =>
      spendSnapshotSchema.parse(
        JSON.parse(
          (await readSettings(db(), [SETTING.spendOverview]))[SETTING.spendOverview] ?? "null",
        ),
      );

    it("judges a few apps per part and stores the numbers a whole check would", async () => {
      await seedRecordedApp();
      for (const id of ["b", "c", "d", "e"]) await seedApp(id, { worker: id });
      const w = world(RECORDED);
      await watchSpend(watchEnv(), {}, w.deps());
      const whole = await snapshot();

      const { self, parts, checks } = selfFor(w.deps());
      const report = await watchSpend({ ...watchEnv(), SELF: self }, {}, w.deps());
      // The account's sums and the parts in an invocation of their own.
      expect(checks).toHaveLength(1);
      expect(checks[0]?.judge).toEqual(["b", "c", "d", "e", "notes"]);
      // In the order Home lists them (by install time, then id).
      expect(parts.map((p) => p.apps.map((a) => a.installId))).toEqual([
        ["b", "c", "d", "e"],
        ["notes"],
      ]);
      expect(parts.map((p) => p.judge)).toEqual([["b", "c", "d", "e"], ["notes"]]);
      expect(report.parts).toEqual({ count: 2, ran: 2, failed: 0 });
      expect(spendWatchLog(report)).toContain("2 part(s)");
      expect(await snapshot()).toEqual(whole);
    });

    it("pauses a loop from a part, on the second check in a row", async () => {
      await seedApp("loopy", { worker: "loopy" });
      await seedCalmHistory("loopy");
      await writeAppSpendSettings(
        db(),
        "loopy",
        { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
        { userId: "u", now: new Date(NOW - DAY_MS) },
      );
      const w = world(loopAnswers("ns-loopy"), {
        namespaces: [{ id: "ns-loopy", script: "loopy" }],
      });
      const first = selfFor(w.deps());
      await watchSpend({ ...watchEnv(), SELF: first.self }, {}, w.deps());
      expect(first.parts[0]?.alarms.loopy).toBeDefined();
      expect(w.events.filter((e) => e.type === "usage_unusual")).toHaveLength(1);
      expect(w.pauses).toEqual([]);
      const second = selfFor(w.deps(NOW + 5 * 60_000));
      const report = await watchSpend(
        { ...watchEnv(), SELF: second.self },
        {},
        w.deps(NOW + 5 * 60_000),
      );
      expect(w.pauses.map((p) => [p.installId, p.reason])).toEqual([["loopy", "loop"]]);
      expect(report.pauses).toBe(1);
    });

    it("asks for the account warning's delivery only after the parts' pauses", async () => {
      await seedApp("loopy", { worker: "loopy" });
      await seedCalmHistory("loopy");
      await writeAppSpendSettings(
        db(),
        "loopy",
        { autoPause: "on", customTriggers: true, loopOn: true, loopLevel: "strict", capOn: false },
        { userId: "u", now: new Date(NOW - DAY_MS) },
      );
      // Its second check in a row: this one pauses it.
      await env.DB.prepare(
        "INSERT INTO app_usage_state (install_id, loop_checks) VALUES ('loopy', 1)",
      ).run();
      await addChannel(
        {
          label: "Limits",
          events: ["usage_account_limit"],
          settings: { kind: "slack", webhookUrl: SLACK_URL },
        },
        NOW - DAY_MS,
      );
      const w = world(loopAnswers("ns-loopy"), {
        namespaces: [{ id: "ns-loopy", script: "loopy" }],
      });
      const order: string[] = [];
      const deps: SpendWatchDeps = {
        ...w.deps(),
        emit: emitUsageEvent,
        startPause: async (e, r) => {
          order.push(`pause ${r.installId}`);
          return (w.deps().startPause ?? (() => Promise.reject(new Error("no"))))(e, r);
        },
      };
      const { self } = selfFor(deps);
      self.deliverNotifications = async (input: unknown) => {
        const { eventId } = input as { eventId: string };
        const row = await env.DB.prepare("SELECT type FROM notification_events WHERE id = ?1")
          .bind(eventId)
          .first<{ type: string }>();
        order.push(`deliver ${row?.type}`);
        return { ok: true, value: { sent: 0, retrying: 0, failed: 0 } };
      };
      const report = await watchSpend({ ...watchEnv(), SELF: self }, {}, deps);
      expect(report.pauses).toBe(1);
      // The account is past 90% of its Durable Objects requests and rows written:
      // both warnings are sent after the pause.
      expect(order).toEqual([
        "pause loopy",
        "deliver usage_account_limit",
        "deliver usage_account_limit",
      ]);
    });

    it("keeps an app's last numbers when its part fails", async () => {
      await seedRecordedApp();
      const w = world(RECORDED);
      await watchSpend(watchEnv(), {}, w.deps());
      const before = await snapshot();
      const self = { spendShard: async () => ({ ok: false as const, error: "boom" }) };
      const report = await watchSpend({ ...watchEnv(), SELF: self }, {}, w.deps(NOW + 5 * 60_000));
      expect(report.parts).toEqual({ count: 1, ran: 1, failed: 1 });
      const after = await snapshot();
      expect(after.apps).toEqual(before.apps);
      expect(after.computedAt).toBe(NOW + 5 * 60_000);
    });

    async function grantWithoutAnalytics() {
      await env.DB.prepare(
        `INSERT INTO cloudflare_grant (id, client_id, scopes_json, refresh_token, access_token,
           access_expires_at, key_id, status, connected_at, refreshed_at)
         VALUES ('g', 'c', ?1, 'sealed', 'sealed', ?2, 'k', 'connected', 1, 1)`,
      )
        .bind(JSON.stringify(["account-settings.read", "workers-scripts.write"]), NOW + 3_600_000)
        .run();
    }

    for (const [how, spendCheck] of [
      ["answers that it failed", async () => ({ ok: false as const, error: "boom" })],
      [
        "throws",
        async () => {
          throw new Error("network connection lost");
        },
      ],
    ] as const) {
      it(`still says it needs access when the unit for the account's numbers ${how}`, async () => {
        await seedRecordedApp();
        await grantWithoutAnalytics();
        const self = { spendCheck, spendShard: async () => ({ ok: false as const, error: "x" }) };
        const report = await watchSpend({ ...watchEnv(), SELF: self }, {}, world(RECORDED).deps());
        expect(report.status).toBe("needs_access");
        expect(await readSpendWatchStatus(db())).toMatchObject({
          state: "needs_access",
          via: "oauth",
        });
      });
    }

    it("runs as many parts as its subrequests allow, a different window each check", async () => {
      for (const id of ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]) {
        await seedApp(id, { worker: id });
      }
      const w = world(RECORDED, { namespaces: [] });
      const ran: string[][] = [];
      const units = createSpendWatcherUnits(watchEnv(), w.deps());
      const self = {
        spendShard: (input: unknown) => {
          ran.push((input as ShardInput).apps.map((a) => a.installId));
          return units.spendShard(input);
        },
      };
      // The reads take 2 subrequests (the namespace list and the Workers
      // dataset): a budget of 4 leaves room for 2 of the 3 parts.
      const first = await watchSpend({ ...watchEnv(), SELF: self }, {}, { ...w.deps(), budget: 4 });
      expect(first.parts).toEqual({ count: 3, ran: 2, failed: 0 });
      expect(spendWatchLog(first)).toContain("3 part(s) (1 left for the next check)");
      const next = await watchSpend(
        { ...watchEnv(), SELF: self },
        {},
        { ...w.deps(NOW + 5 * 60_000), budget: 4 },
      );
      expect(next.parts?.ran).toBe(2);
      // Over the two checks every part ran.
      expect(new Set(ran.flat())).toEqual(
        new Set(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]),
      );
      // The pages still list every app.
      expect((await snapshot()).apps).toHaveLength(9);
    });
  });

  it("prunes on half-hour checks", async () => {
    await seedRecordedApp();
    const report = await watchSpend(watchEnv(), { maintenance: true }, world(RECORDED).deps());
    expect(report.pruned).toBe(0);
    const plain = await watchSpend(watchEnv(), {}, world(RECORDED).deps(NOW + 300_000));
    expect(plain.pruned).toBeNull();
  });
});

describe("rows read", () => {
  /** Every SQL statement a check sends, through a recording D1 binding. */
  function recording(): { d1: D1Database; sql: string[] } {
    const sql: string[] = [];
    const d1 = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            sql.push(query);
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { d1, sql };
  }

  async function plans(statements: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const sql of new Set(statements)) {
      if (!/^\s*(select|insert|update|delete|with)/i.test(sql)) continue;
      const count = (sql.match(/\?(\d*)/g) ?? []).length;
      const numbered = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const params = Array.from({ length: Math.max(count, numbered) }, () => 0);
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ detail: string }>();
      out.push(...results.map((r) => r.detail));
    }
    return out;
  }

  it("reads the large tables through their indexes only", async () => {
    await writeAccountPlan(db(), "paid");
    await writeSpendDefaults(db(), { budget: { on: true, amount: 10 } });
    const ns = { id: "ns-big", script: "big" };
    await seedApp("big", { worker: "big" });
    await seedCalmHistory("big");
    const { d1, sql } = recording();
    const w = world(loopAnswers("ns-big"), { namespaces: [ns] });
    await watchSpend({ ...watchEnv(), DB: d1 }, { maintenance: true }, w.deps());
    await watchSpend({ ...watchEnv(), DB: d1 }, {}, w.deps(NOW + 300_000));
    const lines = await plans(sql);
    expect(lines.length).toBeGreaterThan(10);
    const scans = lines.filter((l) =>
      /\bSCAN (usage_hourly|usage_daily|usage_activity|resources|jobs|job_logs|app_usage_state|app_spend_settings)\b/.test(
        l,
      ),
    );
    expect(scans).toEqual([]);
  });

  it("reads each install's resources through their index", async () => {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${WATCHED_APPS_SQL}`).all<{
      detail: string;
    }>();
    const lines = results.map((r) => r.detail);
    expect(lines).toContainEqual(
      expect.stringMatching(/SEARCH r USING INDEX resources_install_id_idx/),
    );
    // The installs table is read whole (one row per install ever made), as Home reads it.
    expect(lines.filter((l) => /^SCAN/.test(l) && !/^SCAN (i|b|w|wb|json_each)\b/.test(l))).toEqual(
      [],
    );
  });

  it("caches the history in KV for the hour", async () => {
    await seedRecordedApp();
    await watchSpend(watchEnv(), {}, world(RECORDED).deps());
    expect(await env.KV.get(HISTORY_KEY)).not.toBeNull();
  });
});

describe("recentRows", () => {
  it("leaves out hours the history holds already, so none counts twice", () => {
    const hourlyFrom = HOUR_NOW - 3 * HOUR;
    const row = (t: number, value: number) => ({
      installId: "a",
      product: "workers_requests",
      t,
      value,
    });
    expect(
      recentRows(
        [row(hourlyFrom - HOUR, 5), row(hourlyFrom, 6), row(hourlyFrom + HOUR, 7)],
        [{ installId: "a", product: "workers_requests", hour: hourlyFrom + HOUR, value: 8 }],
        hourlyFrom,
      ),
    ).toEqual([row(hourlyFrom, 6), row(hourlyFrom + HOUR, 8)]);
  });
});
