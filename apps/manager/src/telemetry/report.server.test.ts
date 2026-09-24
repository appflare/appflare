import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { TELEMETRY_BATCH_URL, TELEMETRY_PROJECT_KEY } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readSettings, SETTING, writeSettings } from "../db/settings";
import { CURSOR_LAG_MS, previewHeartbeat, type ReportEnv, reportTelemetry } from "./report.server";
import {
  dismissNotice,
  isNoticeDue,
  markOpenedToday,
  readTelemetryStatus,
  recordSetupNotice,
  resetOpenedMemo,
  setTelemetryEnabled,
  TelemetryLockedError,
} from "./state.server";

/**
 * The cron's usage-data report against the local D1 and KV, with PostHog's
 * batch endpoint replaced by a recording fetch.
 */

const MIN = 60_000;
const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const CLI_ID = "6f1c3c1e-2b1a-4c1d-9e1f-0a1b2c3d4e5f";

function managerEnv(vars: Partial<ReportEnv> = {}): ReportEnv {
  return { DB: env.DB, KV: env.KV, APPFLARE_VERSION: "0.5.0", ...vars };
}

interface Sent {
  url: string;
  body: {
    api_key: string;
    batch: {
      event: string;
      uuid: string;
      timestamp: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    }[];
  };
}

function posthog(status = 200) {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status });
    },
  };
}

async function seed() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO user (id, name, email, email_verified, created_at, updated_at, role)
       VALUES ('u1', 'Ada Admin', 'ada@example.com', 0, ?1, ?1, 'admin'),
              ('u2', 'Max Member', 'max@example.com', 0, ?1, ?1, 'member')`,
    ).bind(NOW - 100 * MIN),
    env.DB.prepare(
      `INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up)
       VALUES ('p1', 'laptop', 'pk', 'u1', 'cred', 0, 'singleDevice', 0)`,
    ),
    env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
         status, config_json, installed_at, updated_at)
       VALUES ('i1', 'cut', 'my-links', 'Links for Ada', '1.1.0', 'https://artifacts.test/cut.zip',
         'installed', '{"HOME":"secret-home"}', 1, ?1)`,
    ).bind(NOW - 10 * MIN),
    env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, name, cf_id, created_at)
       VALUES ('r1', 'i1', 'cron', '*/5 * * * *', NULL, 1),
              ('r2', 'i1', 'domain', 'links.ada.example', 'cf-zone-1', 1)`,
    ),
    // Before usage data was turned on: never reported.
    env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at, finished_at)
       VALUES ('j0', 'i1', 'install', 'succeeded', '{"slug":"cut","version":"1.0.0"}', ?1, ?2)`,
    ).bind(NOW - 300 * MIN, NOW - 290 * MIN),
    env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, error, started_at, finished_at)
       VALUES ('j1', 'i1', 'update', 'failed', '{"installId":"i1","fromVersion":"1.0.0","version":"1.1.0","secrets":["STRIPE_KEY"]}',
         'set secret STRIPE_KEY: Cloudflare API request failed: PUT /accounts/acc-123/workers/scripts/my-links/secrets -> 403: [10000] Authentication error',
         ?1, ?2)`,
    ).bind(NOW - 20 * MIN, NOW - 15 * MIN),
  ]);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: "acc-123",
    [SETTING.accountName]: "Ada's account",
    [SETTING.workerName]: "appflare-ada",
    [SETTING.cfTokenConfigured]: "1",
    [SETTING.cfTokenVerifiedAt]: new Date(NOW - 70 * MIN).toISOString(),
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  resetOpenedMemo();
  await seed();
});

describe("before anything is sent", () => {
  it("a development build sends nothing and reads nothing", async () => {
    const ph = posthog();
    const e = managerEnv({ APPFLARE_VERSION: "0.0.0-dev" });
    await recordSetupNotice(e);
    expect(await reportTelemetry(e, { fetch: ph.fetch, now: () => NOW })).toEqual({
      status: "skipped",
      reason: "development build",
    });
    expect(ph.sent).toEqual([]);
  });

  it("APPFLARE_TELEMETRY=off or DO_NOT_TRACK=1 on the Worker locks it off", async () => {
    const ph = posthog();
    await recordSetupNotice(managerEnv());
    for (const vars of [{ APPFLARE_TELEMETRY: "off" }, { DO_NOT_TRACK: "1" }]) {
      const out = await reportTelemetry(managerEnv(vars), { fetch: ph.fetch, now: () => NOW });
      expect(out.status).toBe("skipped");
    }
    expect(ph.sent).toEqual([]);
    const locked = managerEnv({ APPFLARE_TELEMETRY: "off" });
    await expect(setTelemetryEnabled(locked, true)).rejects.toThrow(TelemetryLockedError);
    expect(await readTelemetryStatus(locked)).toMatchObject({
      state: "on",
      lockedBy: "APPFLARE_TELEMETRY",
    });
  });

  it("sends nothing before setup finished", async () => {
    const ph = posthog();
    await env.DB.prepare("DELETE FROM settings WHERE key = ?1")
      .bind(SETTING.cfTokenConfigured)
      .run();
    const out = await reportTelemetry(managerEnv(), { fetch: ph.fetch, now: () => NOW });
    expect(out).toEqual({ status: "skipped", reason: "setup not finished" });
    expect(ph.sent).toEqual([]);
    const ids = await readSettings(createDb(env.DB), [SETTING.telemetryInstallId]);
    expect(ids).toEqual({});
  });

  it("sends and writes nothing once turned off, not even that it is off", async () => {
    const ph = posthog();
    await recordSetupNotice(managerEnv(), new Date(NOW - 60 * MIN));
    await setTelemetryEnabled(managerEnv(), false, new Date(NOW - 50 * MIN));
    const before = await env.DB.prepare("SELECT key, value FROM settings ORDER BY key").all();
    await markOpenedToday(managerEnv(), "admin", NOW);
    expect(await reportTelemetry(managerEnv(), { fetch: ph.fetch, now: () => NOW })).toEqual({
      status: "skipped",
      reason: "turned off",
    });
    expect(ph.sent).toEqual([]);
    const after = await env.DB.prepare("SELECT key, value FROM settings ORDER BY key").all();
    expect(after.results).toEqual(before.results);
  });
});

describe("the choice and the notice", () => {
  it("records setup with the CLI's install id, and moves the job cursor when turned back on", async () => {
    const at = new Date(NOW - 60 * MIN);
    const e = managerEnv({ APPFLARE_INSTALL_ID: CLI_ID });
    await recordSetupNotice(e, at);
    const rows = await readSettings(createDb(env.DB), [
      SETTING.telemetry,
      SETTING.telemetryInstallId,
      SETTING.telemetryCursor,
      SETTING.telemetryNoticeAt,
      SETTING.telemetrySetupSent,
    ]);
    // No choice is stored: on by default, and "setup completed" is still due.
    expect(rows).toEqual({
      telemetry_install_id: CLI_ID,
      telemetry_cursor: String(at.getTime()),
      telemetry_notice_at: at.toISOString(),
    });
    expect(await readTelemetryStatus(e)).toMatchObject({ state: "on", lockedBy: null });
    // Off and on again: same id, fresh cursor.
    expect(await setTelemetryEnabled(e, false, new Date(NOW - 30 * MIN))).toMatchObject({
      state: "off",
    });
    await setTelemetryEnabled(e, true, new Date(NOW - 10 * MIN));
    const again = await readSettings(createDb(env.DB), [
      SETTING.telemetryInstallId,
      SETTING.telemetryCursor,
    ]);
    expect(again).toEqual({
      telemetry_install_id: CLI_ID,
      telemetry_cursor: String(NOW - 10 * MIN),
    });
  });

  it("makes its own random id without a valid one from the CLI, and never reports setup then", async () => {
    await setTelemetryEnabled(managerEnv({ APPFLARE_INSTALL_ID: "not-an-id" }), true);
    const rows = await readSettings(createDb(env.DB), [
      SETTING.telemetry,
      SETTING.telemetryInstallId,
      SETTING.telemetrySetupSent,
    ]);
    expect(rows.telemetry).toBe("on");
    expect(rows.telemetry_install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows.telemetry_install_id).not.toBe("not-an-id");
    expect(rows.telemetry_setup_sent).toBe("skipped");
  });

  it("shows the home page notice once per manager, never while a variable turns it off", async () => {
    expect(await isNoticeDue(managerEnv())).toBe(true);
    expect(await isNoticeDue(managerEnv({ APPFLARE_TELEMETRY: "off" }))).toBe(false);
    await dismissNotice(managerEnv(), new Date(NOW - 5 * MIN));
    expect(await isNoticeDue(managerEnv())).toBe(false);
    // Dismissing again keeps the first time.
    await dismissNotice(managerEnv(), new Date(NOW));
    const rows = await readSettings(createDb(env.DB), [
      SETTING.telemetry,
      SETTING.telemetryNoticeAt,
    ]);
    expect(rows).toEqual({ telemetry_notice_at: new Date(NOW - 5 * MIN).toISOString() });
  });

  it("does not show the home page notice after setup showed it, or after a choice in Settings", async () => {
    await recordSetupNotice(managerEnv());
    expect(await isNoticeDue(managerEnv())).toBe(false);
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await setTelemetryEnabled(managerEnv(), false);
    expect(await isNoticeDue(managerEnv())).toBe(false);
  });
});

describe("the report", () => {
  async function finishSetup() {
    await recordSetupNotice(managerEnv({ APPFLARE_INSTALL_ID: CLI_ID }), new Date(NOW - 60 * MIN));
  }

  it("sends the heartbeat, job events, the opened day and setup completed in one batch", async () => {
    await finishSetup();
    await markOpenedToday(managerEnv(), "member", NOW - 5 * MIN);
    await markOpenedToday(managerEnv(), "admin", NOW - 4 * MIN);
    const ph = posthog();
    const e = managerEnv({ APPFLARE_INSTALL_ID: CLI_ID });
    const out = await reportTelemetry(e, { fetch: ph.fetch, now: () => NOW });
    expect(out).toEqual({ status: "sent", events: 5 });
    expect(ph.sent).toHaveLength(1);
    const [{ url, body }] = ph.sent as [Sent];
    expect(url).toBe(TELEMETRY_BATCH_URL);
    expect(body.api_key).toBe(TELEMETRY_PROJECT_KEY);
    // Sorted by time; the heartbeat carries midnight UTC of its day.
    expect(body.batch.map((e) => e.event)).toEqual([
      "manager heartbeat",
      "manager opened",
      "manager setup completed",
      "job started",
      "job finished",
    ]);
    for (const event of body.batch) {
      expect(event.distinct_id).toBe(CLI_ID);
      expect(event.properties).toMatchObject({
        $process_person_profile: false,
        $geoip_disable: true,
        $lib: "appflare-manager",
        source: "manager",
        manager_version: "0.5.0",
      });
    }
    const byName = Object.fromEntries(body.batch.map((e) => [e.event, e.properties]));
    expect(byName["manager opened"]).toMatchObject({ day: "2026-09-24", role: "member" });
    expect(byName["manager setup completed"]).toMatchObject({
      setup_minutes: 30,
      cli_install_id_used: true,
    });
    expect(byName["job finished"]).toMatchObject({
      kind: "update",
      slug: "cut",
      catalog_version: "1.1.0",
      from_version: "1.0.0",
      outcome: "failed",
      duration_s: 300,
      error_category: "cloudflare_permission",
      failed_phase: "secrets",
      cf_status: 403,
      cf_code: 10000,
    });
    expect(byName["manager heartbeat"]).toMatchObject({
      users: 2,
      admins: 1,
      passkeys_enabled: true,
      passkey_users: 1,
      installs_total: 1,
      installs_with_crons: 1,
      installs_with_domain: 1,
      catalog: "official",
      apps: ["cut"],
      days_since_setup: 0,
    });

    // Nothing the design lists as never sent.
    const text = JSON.stringify(body);
    for (const never of [
      "acc-123",
      "Ada",
      "ada@example.com",
      "max@example.com",
      "my-links",
      "Links for Ada",
      "appflare-ada",
      "links.ada.example",
      "cf-zone-1",
      "STRIPE_KEY",
      "secret-home",
      "Authentication error",
      "/accounts/",
      "i1",
      "j1",
    ]) {
      expect(text, never).not.toContain(never);
    }

    // The job cursor stays a little behind the run, so a job committed late is not skipped.
    const stored = await readSettings(createDb(env.DB), [SETTING.telemetryCursor]);
    expect(stored.telemetry_cursor).toBe(String(NOW - CURSOR_LAG_MS));

    // The cursors moved: the next run has nothing to send and makes no request.
    const next = await reportTelemetry(e, { fetch: ph.fetch, now: () => NOW + 30 * MIN });
    expect(next).toEqual({ status: "sent", events: 0 });
    expect(ph.sent).toHaveLength(1);
  });

  it("keeps everything for the next run when PostHog refuses the batch", async () => {
    await finishSetup();
    const down = posthog(503);
    const e = managerEnv();
    expect(await reportTelemetry(e, { fetch: down.fetch, now: () => NOW })).toEqual({
      status: "failed",
      reason: "PostHog answered HTTP 503",
    });
    const up = posthog();
    const out = await reportTelemetry(e, { fetch: up.fetch, now: () => NOW + 30 * MIN });
    expect(out.status).toBe("sent");
    expect(up.sent[0]?.body.batch.map((ev) => ev.event)).toContain("job finished");
    // The retried events keep their uuids, so PostHog can drop duplicates.
    const uuidOf = (s: Sent | undefined, name: string) =>
      s?.body.batch.find((ev) => ev.event === name)?.uuid;
    expect(uuidOf(up.sent[0], "job finished")).toBe(uuidOf(down.sent[0], "job finished"));
  });

  it("sends a failed reach as an outcome, never an exception", async () => {
    await finishSetup();
    const out = await reportTelemetry(managerEnv(), {
      fetch: async () => {
        throw new Error("network down");
      },
      now: () => NOW,
    });
    expect(out).toEqual({ status: "failed", reason: "could not reach PostHog: network down" });
  });

  it("reports a manager set up before usage data existed from its first run, without setup completed", async () => {
    // No setup record, no choice, no notice dismissed: on by default all the same.
    // Its first admin was created at setup, three days and a bit ago.
    await env.DB.prepare("UPDATE user SET created_at = ?1 WHERE id = 'u1'")
      .bind(NOW - 3 * 86_400_000 - 30 * MIN)
      .run();
    await markOpenedToday(managerEnv(), "admin", NOW - 5 * MIN);
    const ph = posthog();
    const e = managerEnv({ APPFLARE_INSTALL_ID: CLI_ID });
    expect(await reportTelemetry(e, { fetch: ph.fetch, now: () => NOW })).toEqual({
      status: "sent",
      events: 2,
    });
    const [{ body }] = ph.sent as [Sent];
    // Jobs from before the first run are not reported.
    expect(body.batch.map((ev) => ev.event)).toEqual(["manager heartbeat", "manager opened"]);
    expect(body.batch.every((ev) => ev.distinct_id === CLI_ID)).toBe(true);
    // Days since setup count from the first user, as the notice was never shown.
    expect(body.batch[0]?.properties).toMatchObject({ days_since_setup: 3 });
    const rows = await readSettings(createDb(env.DB), [
      SETTING.telemetry,
      SETTING.telemetryInstallId,
      SETTING.telemetrySetupSent,
      SETTING.telemetryCursor,
      SETTING.telemetryNoticeAt,
    ]);
    expect(rows).toEqual({
      telemetry_install_id: CLI_ID,
      telemetry_setup_sent: "skipped",
      telemetry_cursor: String(NOW),
    });
    // The home page notice is still due: nobody has seen it.
    expect(await isNoticeDue(e)).toBe(true);
  });

  it("sends the heartbeat once per UTC day", async () => {
    const ph = posthog();
    const e = managerEnv();
    await reportTelemetry(e, { fetch: ph.fetch, now: () => NOW });
    await reportTelemetry(e, { fetch: ph.fetch, now: () => NOW + 60 * MIN });
    const tomorrow = Date.parse("2026-09-25T00:10:00.000Z");
    await reportTelemetry(e, { fetch: ph.fetch, now: () => tomorrow });
    const heartbeats = ph.sent.flatMap((s) =>
      s.body.batch.filter((ev) => ev.event === "manager heartbeat").map((ev) => ev.timestamp),
    );
    expect(heartbeats).toEqual(["2026-09-24T00:00:00.000Z", "2026-09-25T00:00:00.000Z"]);
  });

  it("drops job events older than seven days", async () => {
    await finishSetup();
    await writeSettings(createDb(env.DB), {
      [SETTING.telemetryCursor]: String(NOW - 30 * 86_400_000),
    });
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at, finished_at)
       VALUES ('old', 'i1', 'install', 'succeeded', '{}', ?1, ?2)`,
    )
      .bind(NOW - 10 * 86_400_000, NOW - 10 * 86_400_000 + MIN)
      .run();
    const ph = posthog();
    await reportTelemetry(managerEnv(), { fetch: ph.fetch, now: () => NOW });
    const jobs = ph.sent[0]?.body.batch.filter((ev) => ev.event.startsWith("job ")) ?? [];
    expect(jobs.map((ev) => ev.timestamp)).toEqual([
      new Date(NOW - 300 * MIN).toISOString(),
      new Date(NOW - 290 * MIN).toISOString(),
      new Date(NOW - 20 * MIN).toISOString(),
      new Date(NOW - 15 * MIN).toISOString(),
    ]);
  });

  it("sends no slugs or versions of a custom catalog", async () => {
    await finishSetup();
    const ph = posthog();
    await reportTelemetry(
      managerEnv({ CATALOG_INDEX_URL: "https://apps.example.com/index.json" }),
      {
        fetch: ph.fetch,
        now: () => NOW,
      },
    );
    const text = JSON.stringify(ph.sent[0]?.body);
    expect(text).not.toContain("apps.example.com");
    expect(text).not.toContain('"cut"');
    const finished = ph.sent[0]?.body.batch.find((ev) => ev.event === "job finished");
    expect(finished?.properties).toMatchObject({
      slug: "custom",
      catalog_version: null,
      from_version: null,
    });
  });
});

describe("markOpenedToday", () => {
  it("records unless usage data is turned off, and only the first opener of a day", async () => {
    await setTelemetryEnabled(managerEnv(), false);
    await markOpenedToday(managerEnv(), "admin", NOW);
    const read = async () =>
      (await readSettings(createDb(env.DB), [SETTING.telemetryOpenedDay])).telemetry_opened_day;
    expect(await read()).toBeUndefined();
    await markOpenedToday(managerEnv({ APPFLARE_TELEMETRY: "off" }), "admin", NOW);
    expect(await read()).toBeUndefined();
    // Nothing was written, so the same isolate records the day once it is
    // turned back on.
    await setTelemetryEnabled(managerEnv(), true);
    await markOpenedToday(managerEnv(), "member", NOW);
    resetOpenedMemo();
    await markOpenedToday(managerEnv(), "admin", NOW + MIN);
    expect(await read()).toBe("2026-09-24 member");
    resetOpenedMemo();
    await markOpenedToday(managerEnv(), "admin", NOW + 86_400_000);
    expect(await read()).toBe("2026-09-25 admin");
  });
});

describe("previewHeartbeat", () => {
  it("builds the heartbeat the cron would send, whatever the stored choice", async () => {
    const preview = await previewHeartbeat(managerEnv(), NOW);
    expect(preview).toMatchObject({
      event: "manager heartbeat",
      distinct_id: null,
      // No notice shown yet: days since setup count from the first user (100 minutes ago).
      properties: { users: 2, installs_total: 1, days_since_setup: 0 },
    });
  });

  it("counts days since setup from the earlier of the first user and the notice", async () => {
    const days = async () =>
      (await previewHeartbeat(managerEnv(), NOW)).properties.days_since_setup;
    // The notice is earlier than the first user (100 minutes ago).
    await recordSetupNotice(managerEnv(), new Date(NOW - 2 * 86_400_000));
    expect(await days()).toBe(2);
    await env.DB.prepare("DELETE FROM settings WHERE key = ?1")
      .bind(SETTING.telemetryNoticeAt)
      .run();
    // An upgraded manager: set up three days ago, notice dismissed just now.
    // The dismissal does not reset the count.
    await env.DB.prepare("UPDATE user SET created_at = ?1")
      .bind(NOW - 3 * 86_400_000)
      .run();
    await dismissNotice(managerEnv(), new Date(NOW));
    expect(await days()).toBe(3);
    await env.DB.prepare("DELETE FROM settings WHERE key = ?1")
      .bind(SETTING.telemetryNoticeAt)
      .run();
    // Neither known: null.
    await env.DB.batch([env.DB.prepare("DELETE FROM passkey"), env.DB.prepare("DELETE FROM user")]);
    expect((await previewHeartbeat(managerEnv(), NOW)).properties).toMatchObject({
      days_since_setup: null,
    });
  });

  it("reports the detected Workers plan over the one an admin set", async () => {
    await writeSettings(createDb(env.DB), {
      [SETTING.accountPlan]: "paid",
      [SETTING.accountCapabilities]: JSON.stringify({
        checkedAt: "2026-09-24T10:00:00.000Z",
        r2: { state: "enabled" },
        containers: { state: "needs-workers-paid" },
        workersPlan: { state: "free" },
      }),
    });
    const preview = await previewHeartbeat(managerEnv(), NOW);
    expect(preview.properties).toMatchObject({ account_plan: "free" });
  });
});
