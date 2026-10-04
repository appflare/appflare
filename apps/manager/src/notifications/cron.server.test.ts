import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  addChannel,
  cacheCatalog,
  cacheManagerRelease,
  MANAGER,
  SECRET,
  SLACK_URL,
  services,
} from "../test/notification-fixtures";
import { seedInstall } from "../test/seed-install";
import { type NotificationsCronEnv, runNotifications } from "./cron.server";
import { detectConditions, JOB_SWEEP_LAG_MS } from "./events.server";
import { MANAGER_URL_KEY, readChannels } from "./outbox.server";

/**
 * The scheduled pass end to end against the local D1 and KV, with the
 * units running in place (no `SELF`) and every outbound request answered by
 * a recording fake: the installed app's health URL and the chat services.
 */

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const APP_URL = "https://cut.appflare-dev.workers.dev/";

function cronEnv(): NotificationsCronEnv {
  return { DB: env.DB, KV: env.KV, APPFLARE_VERSION: "0.5.0", BETTER_AUTH_SECRET: SECRET };
}

/** Answers the app's health URL with `health` (or no answer at all) and every chat service with 200. */
function world(health: () => number | "no answer") {
  const chat = services();
  const probes: string[] = [];
  return {
    chat,
    probes,
    fetch: async (url: string, init?: RequestInit) => {
      if (url.includes(".workers.dev")) {
        probes.push(url);
        const status = health();
        if (status === "no answer") throw new Error("The operation was aborted due to timeout");
        return new Response("app", { status });
      }
      return chat.fetch(url, init);
    },
  };
}

const sentTexts = (posted: { body: string }[]) =>
  posted.map((p) => {
    const body = JSON.parse(p.body) as { text?: string };
    return body.text?.split("\n")[0] ?? "";
  });

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 1)")
    .bind(MANAGER_URL_KEY, MANAGER)
    .run();
});

describe("runNotifications", () => {
  it("does nothing without channels", async () => {
    const w = world(() => 200);
    expect(await runNotifications(cronEnv(), { fetch: w.fetch, now: () => NOW })).toEqual({
      status: "idle",
    });
    expect(w.probes).toEqual([]);
  });

  it("tells about an app update once per version and an Appflare release once", async () => {
    await addChannel(
      {
        label: "Updates",
        events: ["update_available", "manager_update_available"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 1000,
    );
    await cacheCatalog("1.1.0");
    await cacheManagerRelease("0.6.0");
    const w = world(() => 200);
    const run = (t: number) => runNotifications(cronEnv(), { fetch: w.fetch, now: () => t });
    expect(await run(NOW)).toMatchObject({ status: "ran", sent: 2, failed: 0 });
    // No health event wanted: no probes.
    expect(w.probes).toEqual([]);
    expect(sentTexts(w.chat.posted).sort()).toEqual([
      "*Appflare update available*",
      "*Update available: cut*",
    ]);
    expect(w.chat.posted[0]?.body).toContain(MANAGER);
    await run(NOW + 1_800_000);
    expect(w.chat.posted).toHaveLength(2);
    await cacheCatalog("1.2.0");
    await run(NOW + 3_600_000);
    expect(w.chat.posted).toHaveLength(3);
    expect(JSON.parse(w.chat.posted[2]?.body ?? "").text).toContain("Cut 1.2.0 is available");
  });

  it("tells about a version that takes a reinstall, even after the same version went out as an update", async () => {
    await addChannel(
      {
        label: "Updates",
        events: ["update_available"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 1000,
    );
    await cacheCatalog("1.1.0");
    const w = world(() => 200);
    // What a manager from before the reinstall notice sent for this version.
    await runNotifications(cronEnv(), { fetch: w.fetch, now: () => NOW });
    expect(sentTexts(w.chat.posted)).toEqual(["*Update available: cut*"]);
    // The install was deployed by its own installer; the catalog's 1.1.0 is a release.
    await env.DB.prepare("UPDATE installs SET build_kind = 'self-deploying' WHERE id = 'i1'").run();
    await runNotifications(cronEnv(), { fetch: w.fetch, now: () => NOW + 1_800_000 });
    expect(sentTexts(w.chat.posted)).toEqual([
      "*Update available: cut*",
      "*New version takes a reinstall: cut*",
    ]);
    // Once per version, like any update.
    await runNotifications(cronEnv(), { fetch: w.fetch, now: () => NOW + 3_600_000 });
    expect(w.chat.posted).toHaveLength(2);
  });

  it("names an install by its display name when it has one", async () => {
    await env.DB.prepare("UPDATE installs SET display_name = 'Team links' WHERE id = 'i1'").run();
    await addChannel(
      {
        label: "Updates",
        events: ["update_available"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 1000,
    );
    await cacheCatalog("1.1.0");
    const w = world(() => 200);
    await runNotifications(cronEnv(), { fetch: w.fetch, now: () => NOW });
    expect(sentTexts(w.chat.posted)).toEqual(["*Update available: Team links*"]);
    expect(JSON.parse(w.chat.posted[0]?.body ?? "").text).toContain(
      "Cut 1.1.0 is available. Team links runs 1.0.0.",
    );
  });

  it("adds the Worker name only when two installs would read the same", async () => {
    const manifest = JSON.stringify({ version: "1.0.0", catalog: { name: "Cut" } });
    await env.DB.prepare("UPDATE installs SET manifest_json = ?1 WHERE id = 'i1'")
      .bind(manifest)
      .run();
    await env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status,
         manifest_json, installed_at, updated_at)
       VALUES ('i2', 'cut', 'cut-2', '1.0.0', 'https://artifacts.test/cut/old.zip', 'installed',
         ?1, 2, 2)`,
    )
      .bind(manifest)
      .run();
    await addChannel(
      {
        label: "Updates",
        events: ["update_available", "update_failed"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 100_000,
    );
    await cacheCatalog("1.1.0");
    const w = world(() => 200);
    const run = (t: number) => runNotifications(cronEnv(), { fetch: w.fetch, now: () => t });
    await run(NOW);
    expect(sentTexts(w.chat.posted).sort()).toEqual([
      "*Update available: Cut (cut)*",
      "*Update available: Cut (cut-2)*",
    ]);
    // The Worker name comes only with the label that needs it.
    const lines = w.chat.posted.map((p) => (JSON.parse(p.body) as { text: string }).text);
    expect(lines.some((t) => t.includes("Cut 1.1.0 is available. Cut (cut-2) runs 1.0.0."))).toBe(
      true,
    );

    // Once one has a name of its own, the other reads as the app's name alone.
    await env.DB.prepare("UPDATE installs SET display_name = 'Team links' WHERE id = 'i2'").run();
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at, finished_at)
       VALUES ('j9', 'i1', 'update', 'failed', '{"fromVersion":"1.0.0","version":"1.1.0"}', ?1, ?2)`,
    )
      .bind(NOW + 10_000, NOW + 20_000)
      .run();
    await run(NOW + 20_000 + JOB_SWEEP_LAG_MS + 1);
    expect(sentTexts(w.chat.posted.slice(2))).toEqual(["*Update failed: Cut*"]);
    expect(JSON.parse(w.chat.posted[2]?.body ?? "").text).toContain(
      "Updating Cut from 1.0.0 to 1.1.0 failed",
    );
  });

  it("probes health only when wanted, and tells once per failing episode", async () => {
    await addChannel(
      {
        label: "Health",
        events: ["health_failing"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 1000,
    );
    let status = 503;
    const w = world(() => status);
    const run = (t: number) =>
      runNotifications(cronEnv(), { fetch: w.fetch, now: () => t, sleep: async () => {} });
    await run(NOW);
    // A server error is probed twice before it counts.
    expect(w.probes).toEqual([APP_URL, APP_URL]);
    expect(sentTexts(w.chat.posted)).toEqual(["*Health check failing: cut*"]);
    const row = await env.DB.prepare("SELECT health_status FROM installs WHERE id = 'i1'").first();
    expect(row).toEqual({ health_status: "unhealthy" });
    await run(NOW + 1_800_000);
    expect(w.chat.posted).toHaveLength(1);
    status = 200;
    await run(NOW + 3_600_000);
    expect(w.chat.posted).toHaveLength(1);
    status = 500;
    await run(NOW + 5_400_000);
    expect(w.chat.posted).toHaveLength(2);
  });

  it("no answer neither ends an episode nor starts a new one: 5xx, timeout, 5xx is one alert", async () => {
    await addChannel(
      {
        label: "Health",
        events: ["health_failing"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 1000,
    );
    const answers: Array<number | "no answer"> = [503, 503, "no answer", 503, 503];
    const w = world(() => answers.shift() ?? 200);
    const run = (t: number) =>
      runNotifications(cronEnv(), { fetch: w.fetch, now: () => t, sleep: async () => {} });
    await run(NOW);
    await run(NOW + 1_800_000);
    const mid = await env.DB.prepare("SELECT health_status FROM installs WHERE id = 'i1'").first();
    expect(mid).toEqual({ health_status: "unverified" });
    await run(NOW + 3_600_000);
    expect(w.probes).toHaveLength(5);
    expect(sentTexts(w.chat.posted)).toEqual(["*Health check failing: cut*"]);
  });

  it("a single server error, from any check, does not open an episode", async () => {
    await addChannel(
      {
        label: "Health",
        events: ["health_failing"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 1000,
    );
    // "Check now" (or a job) recorded a server error; the scheduled check's
    // first probe fails too, but its second one gets an answer.
    await env.DB.prepare("UPDATE installs SET health_status = 'unhealthy' WHERE id = 'i1'").run();
    const answers = [503, 200];
    const w = world(() => answers.shift() ?? 200);
    await runNotifications(cronEnv(), { fetch: w.fetch, now: () => NOW, sleep: async () => {} });
    expect(w.probes).toHaveLength(2);
    expect(w.chat.posted).toEqual([]);
    // Recorded unhealthy with no confirmation from the scheduled check: still nothing.
    await env.DB.prepare("UPDATE installs SET health_status = 'unhealthy' WHERE id = 'i1'").run();
    const channels = await readChannels(env.DB);
    expect(await detectConditions(cronEnv(), channels, NOW + 1)).toBe(0);
  });

  it("an episode another run opened first keeps its start, so overlapping runs make one event", async () => {
    await addChannel(
      {
        label: "Health",
        events: ["health_failing"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 1000,
    );
    await env.DB.prepare("UPDATE installs SET health_status = 'unhealthy' WHERE id = 'i1'").run();
    const channels = await readChannels(env.DB);
    const confirmed = new Set(["i1"]);
    expect(await detectConditions(cronEnv(), channels, NOW, confirmed)).toBe(1);
    expect(await detectConditions(cronEnv(), channels, NOW + 5, confirmed)).toBe(0);
    const { results } = await env.DB.prepare("SELECT dedupe_key FROM notification_events").all();
    expect(results).toEqual([{ dedupe_key: `health_failing:i1:${NOW}` }]);
  });

  it("catches up on a finished job whose own step did not record it", async () => {
    await addChannel(
      {
        label: "Jobs",
        events: ["update_failed"],
        settings: { kind: "slack", webhookUrl: SLACK_URL },
      },
      NOW - 100_000,
    );
    const w = world(() => 200);
    const run = (t: number) => runNotifications(cronEnv(), { fetch: w.fetch, now: () => t });
    // The first run only starts the sweep's cursor.
    await run(NOW);
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, error, started_at, finished_at)
       VALUES ('j9', 'i1', 'update', 'failed',
         '{"installId":"i1","fromVersion":"1.0.0","version":"1.1.0","secrets":["STRIPE_KEY"]}',
         'set secret STRIPE_KEY: 403', ?1, ?2)`,
    )
      .bind(NOW + 10_000, NOW + 20_000)
      .run();
    await run(NOW + 20_000 + JOB_SWEEP_LAG_MS + 1);
    expect(w.chat.posted).toHaveLength(1);
    const text = JSON.parse(w.chat.posted[0]?.body ?? "").text as string;
    expect(text).toContain("Updating cut from 1.0.0 to 1.1.0 failed");
    expect(text).toContain(`${MANAGER}/jobs/j9`);
    // The job's error names a secret; the message never carries it.
    expect(text).not.toContain("STRIPE_KEY");
    await run(NOW + 3_600_000);
    expect(w.chat.posted).toHaveLength(1);
  });
});
