import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { TELEMETRY_BATCH_URL, TELEMETRY_PROJECT_KEY } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { FAILURE_REPORT_EVENT, LOG_MAX_LINES } from "./failure-report";
import {
  type FailureReportEnv,
  FailureReportError,
  previewFailureReport,
  sendFailureReport,
} from "./failure-report.server";

/**
 * Failure reports against the local D1, with PostHog's batch endpoint
 * replaced by a recording fetch.
 */

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const INSTALL_ID = "6f1c3c1e-2b1a-4c1d-9e1f-0a1b2c3d4e5f";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const PLANTED_TOKEN = "Xy7kQ2mN9pL4rT6vB8wC1zD3fG5hJ0aSeUiO";
const PLANTED_EMAIL = "ada@example.com";

function managerEnv(vars: Partial<FailureReportEnv> = {}): FailureReportEnv {
  return { DB: env.DB, APPFLARE_VERSION: "0.5.0", ...vars };
}

interface SentBody {
  api_key: string;
  batch: {
    event: string;
    uuid: string;
    timestamp: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  }[];
}

function posthog(status = 200) {
  const sent: { url: string; body: SentBody }[] = [];
  return {
    sent,
    fetch: async (url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status });
    },
  };
}

const opts = (fetch: ReturnType<typeof posthog>["fetch"]) => ({ fetch, now: () => NOW });

async function seed() {
  const log = (ts: number, level: string, message: string, data: unknown = null) =>
    env.DB.prepare(
      "INSERT INTO job_logs (job_id, ts, level, message, data_json) VALUES ('j1', ?1, ?2, ?3, ?4)",
    ).bind(ts, level, message, data === null ? null : JSON.stringify(data));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url,
         status, config_json, installed_at, updated_at)
       VALUES ('i1', 'cut', 'my-links', 'Links', '1.1.0', 'https://artifacts.test/cut.zip',
         'installed', '{}', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, error, started_at, finished_at)
       VALUES ('j1', 'i1', 'update', 'failed', '{"installId":"i1","fromVersion":"1.0.0","version":"1.1.0"}',
         ?1, ?2, ?3)`,
    ).bind(
      `set cron triggers: Cloudflare API request failed: PUT /accounts/${ACCOUNT}/workers/scripts/my-links/schedules -> 400: [10072] too many cron triggers`,
      NOW - 5 * 60_000,
      NOW - 4 * 60_000,
    ),
    env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at, finished_at)
       VALUES ('j2', 'i1', 'install', 'succeeded', '{"version":"1.0.0"}', 1, 2)`,
    ),
    log(NOW - 5 * 60_000, "info", "start", {
      requests: [`GET /accounts/${ACCOUNT}/workers/scripts -> 200`],
    }),
    log(NOW - 4.5 * 60_000, "warn", `upstream said: contact ${PLANTED_EMAIL}`, {
      output: `API_TOKEN=${PLANTED_TOKEN}`,
    }),
    log(
      NOW - 4 * 60_000,
      "error",
      `Cloudflare API request failed: PUT /accounts/${ACCOUNT}/workers/scripts/my-links/schedules -> 400: [10072] too many cron triggers; [10021] other`,
    ),
  ]);
  await writeSettings(createDb(env.DB), {
    [SETTING.telemetryInstallId]: INSTALL_ID,
    [SETTING.accountPlan]: "free",
  });
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seed();
});

describe("previewFailureReport", () => {
  it("builds the report exactly as it is sent, with no private values", async () => {
    const preview = await previewFailureReport(managerEnv(), "j1");
    expect(preview.reportedAt).toBeNull();
    expect(preview.usageDataOff).toBe(false);
    expect(preview.summary).toEqual({
      kind: "update",
      restore: false,
      deleteRetained: false,
      app: "cut",
      version: "1.1.0",
      managerVersion: "0.5.0",
      plan: "free",
      cloudflareCodes: [10072, 10021],
      failedStep: "set cron triggers",
      logLines: 5,
      logTruncated: false,
    });
    const { event } = preview;
    expect(event.event).toBe(FAILURE_REPORT_EVENT);
    expect(event.distinct_id).toBe(INSTALL_ID);
    expect(event.timestamp).toBe(new Date(NOW - 4 * 60_000).toISOString());
    expect(event.properties).toMatchObject({
      $process_person_profile: false,
      $geoip_disable: true,
      manager_version: "0.5.0",
      kind: "update",
      slug: "cut",
      catalog_version: "1.1.0",
      from_version: "1.0.0",
      account_plan: "free",
      usage_data: "on",
      error_category: "plan_limit",
      failed_phase: "crons",
      failed_step: "set cron triggers",
      cf_status: 400,
      cf_code: 10072,
      cf_codes: ["10072", "10021"],
      duration_s: 60,
      log_truncated: false,
      note: null,
    });
    expect(event.properties.error).toBe(
      "set cron triggers: Cloudflare API request failed: PUT /accounts/[account id]/workers/scripts/[worker]/schedules -> 400: [10072] too many cron triggers",
    );
    const json = JSON.stringify(preview);
    expect(json).not.toContain(ACCOUNT);
    expect(json).not.toContain(PLANTED_TOKEN);
    expect(json).not.toContain(PLANTED_EMAIL);
    expect(event.properties.log).toEqual([
      `${new Date(NOW - 5 * 60_000).toISOString()} info start`,
      "  GET /accounts/[account id]/workers/scripts -> 200",
      `${new Date(NOW - 4.5 * 60_000).toISOString()} warn upstream said: contact [email]`,
      '  {"output":"API_TOKEN=[redacted]"}',
      `${new Date(NOW - 4 * 60_000).toISOString()} error Cloudflare API request failed: PUT /accounts/[account id]/workers/scripts/[worker]/schedules -> 400: [10072] too many cron triggers; [10021] other`,
    ]);
  });

  it("refuses a job that did not fail, and one that does not exist", async () => {
    await expect(previewFailureReport(managerEnv(), "j2")).rejects.toThrow(FailureReportError);
    await expect(previewFailureReport(managerEnv(), "nope")).rejects.toThrow("no such job");
  });

  it("sends only the end of a long log", async () => {
    const rows = Array.from({ length: LOG_MAX_LINES + 50 }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO job_logs (job_id, ts, level, message) VALUES ('j1', ?1, 'info', ?2)",
      ).bind(NOW, `line ${i}`),
    );
    await env.DB.batch(rows);
    const { summary, event } = await previewFailureReport(managerEnv(), "j1");
    expect(summary.logTruncated).toBe(true);
    expect(summary.logLines).toBe(LOG_MAX_LINES);
    expect((event.properties.log as string[]).at(-1)).toContain(`line ${LOG_MAX_LINES + 49}`);
  });
});

describe("sendFailureReport", () => {
  it("sends one job_failure_report event with the note, and remembers it", async () => {
    const ph = posthog();
    const outcome = await sendFailureReport(
      managerEnv(),
      "j1",
      `  It broke after I added a cron. Reach me at ${PLANTED_EMAIL}  `,
      opts(ph.fetch),
    );
    expect(outcome).toEqual({ status: "sent", reportedAt: new Date(NOW).toISOString() });
    expect(ph.sent).toHaveLength(1);
    const [{ url, body }] = ph.sent as [{ url: string; body: SentBody }];
    expect(url).toBe(TELEMETRY_BATCH_URL);
    expect(body.api_key).toBe(TELEMETRY_PROJECT_KEY);
    expect(body.batch).toHaveLength(1);
    const [event] = body.batch as [SentBody["batch"][number]];
    const preview = await previewFailureReport(managerEnv(), "j1");
    expect(event.event).toBe(FAILURE_REPORT_EVENT);
    expect(event.distinct_id).toBe(INSTALL_ID);
    expect(event.uuid).toBe(preview.event.uuid);
    expect(event.properties).toEqual({
      ...preview.event.properties,
      note: "It broke after I added a cron. Reach me at [email]",
    });
    expect(JSON.stringify(body)).not.toContain(PLANTED_EMAIL);
    expect(preview.reportedAt).toBe(new Date(NOW).toISOString());
  });

  it("sends at most one report per job", async () => {
    const ph = posthog();
    await sendFailureReport(managerEnv(), "j1", "", opts(ph.fetch));
    const again = await sendFailureReport(managerEnv(), "j1", "second", {
      fetch: ph.fetch,
      now: () => NOW + 60_000,
    });
    expect(again).toEqual({ status: "already_sent", reportedAt: new Date(NOW).toISOString() });
    expect(ph.sent).toHaveLength(1);
  });

  it("two sends at once still send one report", async () => {
    const ph = posthog();
    const outcomes = await Promise.all([
      sendFailureReport(managerEnv(), "j1", "", opts(ph.fetch)),
      sendFailureReport(managerEnv(), "j1", "", opts(ph.fetch)),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["already_sent", "sent"]);
    expect(ph.sent).toHaveLength(1);
  });

  it("still sends when usage data is turned off, and says so in the report", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.telemetry]: "off" });
    for (const vars of [{}, { APPFLARE_TELEMETRY: "off" }, { DO_NOT_TRACK: "1" }]) {
      await env.DB.exec("UPDATE jobs SET reported_at = NULL");
      const e = managerEnv(vars);
      const preview = await previewFailureReport(e, "j1");
      expect(preview.usageDataOff).toBe(true);
      expect(preview.event.properties.usage_data).toBe("off");
      const ph = posthog();
      expect((await sendFailureReport(e, "j1", "", opts(ph.fetch))).status).toBe("sent");
      expect(ph.sent).toHaveLength(1);
    }
  });

  it("with the Worker variable and no stored choice, usage data reads as off", async () => {
    const preview = await previewFailureReport(managerEnv({ APPFLARE_TELEMETRY: "off" }), "j1");
    expect(preview.usageDataOff).toBe(true);
  });

  it("lets the admin try again when PostHog refuses or cannot be reached", async () => {
    const refused = posthog(503);
    await expect(sendFailureReport(managerEnv(), "j1", "", opts(refused.fetch))).rejects.toThrow(
      FailureReportError,
    );
    expect((await previewFailureReport(managerEnv(), "j1")).reportedAt).toBeNull();
    const unreachable = async () => {
      throw new Error("network down");
    };
    await expect(
      sendFailureReport(managerEnv(), "j1", "", { fetch: unreachable, now: () => NOW }),
    ).rejects.toThrow("could not be sent");
    const ph = posthog();
    expect((await sendFailureReport(managerEnv(), "j1", "", opts(ph.fetch))).status).toBe("sent");
  });

  it("never sends from a development build", async () => {
    const ph = posthog();
    const e = managerEnv({ APPFLARE_VERSION: "0.0.0-dev" });
    expect((await previewFailureReport(e, "j1")).devBuild).toBe(true);
    await expect(sendFailureReport(e, "j1", "", opts(ph.fetch))).rejects.toThrow(
      "development build",
    );
    expect(ph.sent).toEqual([]);
  });

  it("gives a manager without an install id the one the preview showed, stored only once sent", async () => {
    await env.DB.exec("DELETE FROM settings WHERE key LIKE 'telemetry%'");
    const preview = await previewFailureReport(managerEnv(), "j1");
    expect(await settingsRows()).toEqual([]);
    const refused = posthog(500);
    await expect(
      sendFailureReport(managerEnv(), "j1", "", {
        ...opts(refused.fetch),
        proposedInstallId: preview.event.distinct_id,
      }),
    ).rejects.toThrow(FailureReportError);
    expect(await settingsRows()).toEqual([]);
    const ph = posthog();
    await sendFailureReport(managerEnv(), "j1", "", {
      ...opts(ph.fetch),
      proposedInstallId: preview.event.distinct_id,
    });
    expect(ph.sent[0]?.body.batch[0]?.distinct_id).toBe(preview.event.distinct_id);
    expect(await settingsRows()).toEqual([
      { key: "telemetry_cursor", value: String(NOW) },
      { key: "telemetry_install_id", value: preview.event.distinct_id },
      { key: "telemetry_setup_sent", value: "skipped" },
    ]);
  });

  it("a preview never writes settings, on a development build or with usage data off", async () => {
    await env.DB.exec("DELETE FROM settings WHERE key LIKE 'telemetry%'");
    await previewFailureReport(managerEnv({ APPFLARE_VERSION: "0.0.0-dev" }), "j1");
    await previewFailureReport(managerEnv({ APPFLARE_TELEMETRY: "off" }), "j1");
    await writeSettings(createDb(env.DB), { [SETTING.telemetry]: "off" });
    await previewFailureReport(managerEnv(), "j1");
    expect(await settingsRows()).toEqual([{ key: "telemetry", value: "off" }]);
  });

  it("takes this account's workers.dev subdomain, hostnames and Worker names out", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, name, created_at)
         VALUES ('r1', 'i1', 'domain', 'links.ada.example', 1),
                ('r2', 'i1', 'worker_route', 'shop.ada.example/*', 1),
                ('r3', 'i1', 'worker', 'my-links-queue-consumer', 1)`,
      ),
      env.DB.prepare(
        "INSERT INTO job_logs (job_id, ts, level, message) VALUES ('j1', ?1, 'info', ?2)",
      ).bind(
        NOW,
        "checked https://my-links.ada.workers.dev and https://links.ada.example, shop.ada.example, my-links-queue-consumer and appflare-ada",
      ),
    ]);
    await writeSettings(createDb(env.DB), {
      [SETTING.accountSubdomain]: "ada",
      [SETTING.workerName]: "appflare-ada",
    });
    const preview = await previewFailureReport(managerEnv(), "j1");
    expect((preview.event.properties.log as string[]).at(-1)).toBe(
      `${new Date(NOW).toISOString()} info checked https://[worker].[domain].workers.dev and https://[domain], [domain], [worker] and [worker]`,
    );
    const ph = posthog();
    await sendFailureReport(managerEnv(), "j1", "my Worker appflare-ada at links.ada.example", {
      ...opts(ph.fetch),
    });
    expect(ph.sent[0]?.body.batch[0]?.properties.note).toBe("my Worker [worker] at [domain]");
    // What stays readable: the slug, the step, the codes and the statuses.
    expect(preview.event.properties).toMatchObject({
      slug: "cut",
      failed_step: "set cron triggers",
      cf_codes: ["10072", "10021"],
      cf_status: 400,
    });
  });

  it("takes Appflare's own custom domain, and the ones it had before, out", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user (id, name, email, email_verified, created_at, updated_at, role)
         VALUES ('u1', 'Ada', 'ada@example.com', 0, 1, 1, 'admin')`,
      ),
      env.DB.prepare(
        `INSERT INTO passkey (id, name, public_key, user_id, credential_id, counter, device_type, backed_up)
         VALUES ('pk1', NULL, 'k', 'u1', 'c1', 0, 'singleDevice', 0)`,
      ),
      env.DB.prepare(
        "INSERT INTO passkey_host (passkey_id, hostname, recorded_at) VALUES ('pk1', 'first.ada.example', 1)",
      ),
      env.DB.prepare(
        "INSERT INTO job_logs (job_id, ts, level, message) VALUES ('j1', ?1, 'info', ?2)",
      ).bind(NOW, "opened home.ada.example, then.ada.example and first.ada.example"),
    ]);
    await writeSettings(createDb(env.DB), {
      [SETTING.managerHostname]: "home.ada.example",
      [SETTING.managerPreviousHostname]: "then.ada.example",
    });
    const preview = await previewFailureReport(managerEnv(), "j1");
    expect((preview.event.properties.log as string[]).at(-1)).toBe(
      `${new Date(NOW).toISOString()} info opened [domain], [domain] and [domain]`,
    );
  });

  it("a report that cannot be built leaves the job unmarked", async () => {
    // A log line whose time is not a date makes building the report throw.
    await env.DB.prepare(
      "INSERT INTO job_logs (job_id, ts, level, message) VALUES ('j1', ?1, 'info', 'x')",
    )
      .bind(8.64e15 + 1)
      .run();
    const ph = posthog();
    await expect(sendFailureReport(managerEnv(), "j1", "", opts(ph.fetch))).rejects.toThrow();
    const row = await env.DB.prepare("SELECT reported_at FROM jobs WHERE id = 'j1'").first();
    expect(row).toEqual({ reported_at: null });
    expect(ph.sent).toEqual([]);
  });
});

async function settingsRows(): Promise<{ key: string; value: string }[]> {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key LIKE 'telemetry%' ORDER BY key",
  ).all<{ key: string; value: string }>();
  return results;
}
