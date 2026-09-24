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
  acknowledgeNotice,
  markOpenedToday,
  readTelemetryStatus,
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
    await acknowledgeNotice(e, { enabled: true, via: "setup" });
    expect(await reportTelemetry(e, { fetch: ph.fetch, now: () => NOW })).toEqual({
      status: "skipped",
      reason: "development build",
    });
    expect(ph.sent).toEqual([]);
  });

  it("APPFLARE_TELEMETRY=off or DO_NOT_TRACK=1 on the Worker locks it off", async () => {
    const ph = posthog();
    await acknowledgeNotice(managerEnv(), { enabled: true, via: "setup" });
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

  it("sends nothing until an admin has seen the notice", async () => {
    const ph = posthog();
    const out = await reportTelemetry(managerEnv(), { fetch: ph.fetch, now: () => NOW });
    expect(out).toEqual({ status: "skipped", reason: "notice not seen" });
    expect(ph.sent).toEqual([]);
  });

  it("sends and writes nothing once turned off, not even that it is off", async () => {
    const ph = posthog();
    await acknowledgeNotice(
      managerEnv(),
      { enabled: false, via: "setup" },
      new Date(NOW - 60 * MIN),
    );
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

describe("the choice", () => {
  it("keeps the CLI's install id and moves the job cursor to the moment it is turned on", async () => {
    const at = new Date(NOW - 60 * MIN);
    const e = managerEnv({ APPFLARE_INSTALL_ID: CLI_ID });
    expect(await acknowledgeNotice(e, { enabled: true, via: "setup" }, at)).toMatchObject({
      state: "on",
    });
    const rows = await readSettings(createDb(env.DB), [
      SETTING.telemetryInstallId,
      SETTING.telemetryCursor,
      SETTING.telemetryNoticeAt,
      SETTING.telemetrySetupSent,
    ]);
    expect(rows).toEqual({
      telemetry_install_id: CLI_ID,
      telemetry_cursor: String(at.getTime()),
      telemetry_notice_at: at.toISOString(),
    });
    // Off and on again: same id, fresh cursor.
    await setTelemetryEnabled(e, false, new Date(NOW - 30 * MIN));
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

  it("makes its own random id without a valid one from the CLI, and a lock records off", async () => {
    await acknowledgeNotice(
      managerEnv({ APPFLARE_INSTALL_ID: "not-an-id", APPFLARE_TELEMETRY: "false" }),
      { enabled: true, via: "banner" },
    );
    const rows = await readSettings(createDb(env.DB), [
      SETTING.telemetry,
      SETTING.telemetryInstallId,
      SETTING.telemetrySetupSent,
    ]);
    expect(rows.telemetry).toBe("off");
    expect(rows.telemetry_install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows.telemetry_install_id).not.toBe("not-an-id");
    expect(rows.telemetry_setup_sent).toBe("skipped");
  });
});

describe("the report", () => {
  async function turnOn(via: "setup" | "banner" = "setup") {
    await acknowledgeNotice(
      managerEnv({ APPFLARE_INSTALL_ID: CLI_ID }),
      { enabled: true, via },
      new Date(NOW - 60 * MIN),
    );
  }

  it("sends the heartbeat, job events, the opened day and setup completed in one batch", async () => {
    await turnOn();
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
    await turnOn();
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
    await turnOn();
    const out = await reportTelemetry(managerEnv(), {
      fetch: async () => {
        throw new Error("network down");
      },
      now: () => NOW,
    });
    expect(out).toEqual({ status: "failed", reason: "could not reach PostHog: network down" });
  });

  it("sends the heartbeat once per UTC day", async () => {
    await turnOn("banner");
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
    // Through the notice banner, setup completed is never reported.
    const all = ph.sent.flatMap((s) => s.body.batch.map((ev) => ev.event));
    expect(all).not.toContain("manager setup completed");
  });

  it("drops job events older than seven days", async () => {
    await turnOn();
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
    await turnOn();
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
  it("records only while usage data is on, and only the first opener of a day", async () => {
    await markOpenedToday(managerEnv(), "admin", NOW);
    const read = async () =>
      (await readSettings(createDb(env.DB), [SETTING.telemetryOpenedDay])).telemetry_opened_day;
    expect(await read()).toBeUndefined();
    // Nothing was written, so the same isolate records the day once an admin
    // answers the notice (here through the home page banner).
    await acknowledgeNotice(managerEnv(), { enabled: true, via: "banner" });
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
      properties: { users: 2, installs_total: 1, days_since_setup: null },
    });
  });
});
