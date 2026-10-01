import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MANAGER_LATEST_KEY } from "../catalog/manager-releases.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  buildArtifactFixture,
} from "../test/artifact-fixture";
import { cacheIndex, INSTALL_ID, type SeedResource, seedInstall } from "../test/seed-install";
import { runScheduledUpdates, type ScheduledUpdatesEnv, scheduledUpdatesLog } from "./cron.server";

/**
 * The cron's automatic updates against the local D1 and KV, with the
 * Workflow binding replaced by a recorder. The update start path is the real
 * one (the Update button's), so what it refuses or asks for is real too.
 */

const RESOURCES: SeedResource[] = [
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
];

const NEW_APP: ArtifactFixtureOptions = { version: "1.1.0" };

interface Created {
  id: string;
  params: Record<string, unknown>;
}

function jobs(): ScheduledUpdatesEnv["JOBS"] & { created: Created[] } {
  const created: Created[] = [];
  return {
    created,
    async create({ id, params }) {
      created.push({ id, params: params as unknown as Record<string, unknown> });
      return { id };
    },
    async get() {
      return { status: async () => ({ status: "running" }) };
    },
  };
}

async function settings(values: { apps?: "on" | "off"; manager?: "on" | "off" }) {
  await writeSettings(createDb(env.DB), {
    [SETTING.autoUpdateApps]: values.apps,
    [SETTING.autoUpdateManager]: values.manager,
    [SETTING.workerName]: "appflare",
  });
}

async function run(
  fixture: ArtifactFixture,
  opts: { version?: string; token?: string | null; ids?: string[] } = {},
) {
  const JOBS = jobs();
  const ids = [...(opts.ids ?? ["job1", "job2", "job3", "job4"])];
  const outcome = await runScheduledUpdates(
    {
      DB: env.DB,
      KV: env.KV,
      JOBS,
      APPFLARE_VERSION: opts.version ?? "0.5.0",
      ...(opts.token === null ? {} : { CF_API_TOKEN: opts.token ?? "cf-token" }),
    },
    {
      loadManifest: async () => fixture.manifest,
      newId: () => ids.shift() ?? "job-x",
      now: () => new Date("2026-09-24T12:00:00.000Z"),
    },
  );
  const rows = (
    await env.DB.prepare(
      "SELECT id, install_id, kind, status, started_by, input_json FROM jobs ORDER BY id",
    ).all<{
      id: string;
      install_id: string | null;
      kind: string;
      status: string;
      started_by: string;
      input_json: string;
    }>()
  ).results;
  const install = await env.DB.prepare("SELECT status FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<{ status: string }>();
  return { outcome, created: JOBS.created, rows, install };
}

async function publishRelease(fixture: ArtifactFixture, version: string) {
  await env.KV.put(
    MANAGER_LATEST_KEY,
    JSON.stringify({
      version,
      tag: `manager@${version}`,
      assets: fixture.index.artifacts,
      publishedAt: "2026-09-23T00:00:00.000Z",
      checkedAt: "2026-09-24T11:30:00.000Z",
    }),
  );
}

let fixture: ArtifactFixture;

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall({ resources: RESOURCES });
  fixture = await buildArtifactFixture(NEW_APP);
  await cacheIndex(fixture);
});

describe("runScheduledUpdates", () => {
  it("does nothing while automatic updates are off (the default)", async () => {
    const r = await run(fixture);
    expect(r.outcome).toEqual({ selfUpdate: null, apps: [], idle: "off" });
    expect(r.created).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(scheduledUpdatesLog(r.outcome)).toEqual([]);
  });

  it("starts an update that needs nothing from an admin, recorded as started by the schedule", async () => {
    await settings({ apps: "on" });
    const r = await run(fixture);
    expect(r.outcome.apps).toEqual([
      {
        installId: INSTALL_ID,
        slug: "cut",
        status: "started",
        version: "1.1.0",
        jobId: "job1",
      },
    ]);
    expect(r.created).toEqual([
      {
        id: "job1",
        params: {
          kind: "update",
          jobId: "job1",
          installId: INSTALL_ID,
          version: "1.1.0",
          secrets: {},
        },
      },
    ]);
    expect(r.rows).toMatchObject([
      {
        id: "job1",
        install_id: INSTALL_ID,
        kind: "update",
        status: "queued",
        started_by: "schedule",
      },
    ]);
    expect(r.install?.status).toBe("updating");
    expect(scheduledUpdatesLog(r.outcome)).toEqual([
      `automatic updates: started updating cut (${INSTALL_ID}) to 1.1.0 (job job1)`,
    ]);
  });

  it("follows an install's own choice over the account default", async () => {
    await settings({ apps: "off" });
    await env.DB.prepare("UPDATE installs SET auto_update = 'on'").run();
    expect((await run(fixture)).created.map((c) => c.id)).toEqual(["job1"]);

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await seedInstall({ resources: RESOURCES });
    await cacheIndex(fixture);
    await settings({ apps: "on" });
    await env.DB.prepare("UPDATE installs SET auto_update = 'off'").run();
    const r = await run(fixture);
    expect(r.created).toEqual([]);
    expect(r.outcome.apps).toEqual([]);
  });

  it("leaves an update that introduces a secret for an admin", async () => {
    const withSecret = await buildArtifactFixture({
      ...NEW_APP,
      catalog: {
        secrets: [
          { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
          { name: "API_KEY", label: "API key" },
        ],
      },
    });
    await cacheIndex(withSecret);
    await settings({ apps: "on" });
    const r = await run(withSecret);
    expect(r.created).toEqual([]);
    expect(r.rows).toEqual([]);
    expect(r.install?.status).toBe("installed");
    expect(r.outcome.apps).toEqual([
      {
        installId: INSTALL_ID,
        slug: "cut",
        status: "left",
        version: "1.1.0",
        reason: "it needs a value for API_KEY",
      },
    ]);
  });

  it("leaves an update that adds cron triggers on a free account for an admin", async () => {
    const withCrons = await buildArtifactFixture({ ...NEW_APP, crons: ["*/10 * * * *"] });
    await cacheIndex(withCrons);
    await settings({ apps: "on" });
    const r = await run(withCrons);
    expect(r.created).toEqual([]);
    expect(r.outcome.apps[0]).toMatchObject({
      status: "left",
      reason: "it needs a Workers Paid confirmation for its cron triggers",
    });
  });

  it("leaves an update that cannot be checked on a preview for an admin", async () => {
    const withDo = await buildArtifactFixture({
      ...NEW_APP,
      bindings: [{ type: "durable_object_namespace", name: "ROOMS", class_name: "Room" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
    });
    await cacheIndex(withDo);
    await settings({ apps: "on" });
    const r = await run(withDo);
    expect(r.created).toEqual([]);
    expect(r.outcome.apps[0]).toMatchObject({
      status: "left",
      reason: "it needs a confirmation to update without a preview check",
    });
  });

  it("does not try again a version whose update already failed", async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_by)
       VALUES ('old', ?1, 'update', 'failed', '{"version":"1.1.0"}', 'schedule')`,
    )
      .bind(INSTALL_ID)
      .run();
    await settings({ apps: "on" });
    const r = await run(fixture);
    expect(r.created).toEqual([]);
    expect(r.outcome.apps).toEqual([
      { installId: INSTALL_ID, slug: "cut", status: "skipped", reason: "failed-before" },
    ]);
    expect(scheduledUpdatesLog(r.outcome)).toEqual([
      `automatic updates: cut (${INSTALL_ID}) not tried: an update to this version already failed`,
    ]);
  });

  it("leaves an install whose job is running alone", async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json)
       VALUES ('busy', ?1, 'reconfigure', 'running', '{}')`,
    )
      .bind(INSTALL_ID)
      .run();
    await settings({ apps: "on" });
    const r = await run(fixture);
    expect(r.created).toEqual([]);
    expect(r.outcome.apps[0]).toMatchObject({ status: "left", version: "1.1.0" });
  });

  it("does not move an install back to a version a rollback moved it off", async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json)
       VALUES ('upd', ?1, 'update', 'succeeded', '{"version":"1.1.0"}'),
              ('rb', ?1, 'rollback', 'succeeded', '{"installId":"i1","snapshotId":"upd"}')`,
    )
      .bind(INSTALL_ID)
      .run();
    await env.DB.prepare(
      `INSERT INTO snapshots (id, install_id, job_id, worker_version_id, d1_bookmarks_json, taken_at,
         catalog_version, target_catalog_version)
       VALUES ('upd', ?1, 'upd', 'v-old', '{}', 1, '1.0.0', '1.1.0')`,
    )
      .bind(INSTALL_ID)
      .run();
    await settings({ apps: "on" });
    const r = await run(fixture);
    expect(r.created).toEqual([]);
    expect(r.outcome.apps).toEqual([
      { installId: INSTALL_ID, slug: "cut", status: "skipped", reason: "rolled-back" },
    ]);
    expect(scheduledUpdatesLog(r.outcome)).toEqual([
      `automatic updates: cut (${INSTALL_ID}) not tried: it was rolled back from this version`,
    ]);

    // A database restore is recorded as a rollback job too; it moves nothing.
    await env.DB.prepare("DELETE FROM jobs WHERE id = 'rb'").run();
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json)
       VALUES ('restore', ?1, 'rollback', 'succeeded', '{"snapshotId":"upd","restore":true}')`,
    )
      .bind(INSTALL_ID)
      .run();
    expect((await run(fixture)).created.map((c) => c.id)).toEqual(["job1"]);
  });

  it("leaves an update to a version that must run behind Cloudflare Access for an admin", async () => {
    const required = await buildArtifactFixture({
      ...NEW_APP,
      catalog: { access: { mode: "required" }, requires: ["access"] },
    });
    await cacheIndex(required);
    await settings({ apps: "on" });
    const r = await run(required);
    expect(r.created).toEqual([]);
    expect(r.outcome.apps[0]).toMatchObject({
      status: "left",
      version: "1.1.0",
      reason: expect.stringContaining("Turn protection on for the app first"),
    });
    const waiting = await env.DB.prepare("SELECT auto_update_waiting FROM installs WHERE id = ?1")
      .bind(INSTALL_ID)
      .first<{ auto_update_waiting: string | null }>();
    expect(waiting?.auto_update_waiting).toBe("1.1.0");
  });

  it("remembers an update it left for an admin and tries only a newer version", async () => {
    const withSecret = await buildArtifactFixture({
      ...NEW_APP,
      catalog: {
        secrets: [
          { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
          { name: "API_KEY", label: "API key" },
        ],
      },
    });
    await cacheIndex(withSecret);
    await settings({ apps: "on" });
    let loads = 0;
    const first = await run(withSecret);
    expect(first.outcome.apps[0]).toMatchObject({ status: "left", version: "1.1.0" });
    const waiting = await env.DB.prepare("SELECT auto_update_waiting FROM installs WHERE id = ?1")
      .bind(INSTALL_ID)
      .first<{ auto_update_waiting: string | null }>();
    expect(waiting?.auto_update_waiting).toBe("1.1.0");

    // The next run does not try it again (nor load its manifest).
    const second = await runScheduledUpdates(
      {
        DB: env.DB,
        KV: env.KV,
        JOBS: jobs(),
        APPFLARE_VERSION: "0.5.0",
        CF_API_TOKEN: "cf-token",
      },
      {
        loadManifest: async () => {
          loads += 1;
          return withSecret.manifest;
        },
      },
    );
    expect(loads).toBe(0);
    expect(second.apps).toEqual([
      { installId: INSTALL_ID, slug: "cut", status: "skipped", reason: "waiting" },
    ]);

    // A newer catalog version is tried again (and needs nothing this time).
    const newer = await buildArtifactFixture({ version: "1.2.0" });
    await cacheIndex(newer);
    const third = await run(newer);
    expect(third.outcome.apps[0]).toMatchObject({ status: "started", version: "1.2.0" });
  });

  describe("limits per run", () => {
    async function addInstall(id: string, installedAt: number, withSecret: boolean) {
      await env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version,
           artifact_url, status, installed_at, updated_at)
         VALUES (?1, 'cut', ?1, ?1, '1.0.0', 'https://artifacts.test/cut/old.zip', 'installed', ?2, ?2)`,
      )
        .bind(id, installedAt)
        .run();
      if (withSecret) {
        await env.DB.prepare(
          `INSERT INTO resources (id, install_id, kind, binding, name, created_at)
           VALUES (?1 || ':secret:ADMIN_PASSWORD', ?1, 'secret', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD', 1)`,
        )
          .bind(id)
          .run();
      }
    }
    const needsPassword = () =>
      buildArtifactFixture({
        ...NEW_APP,
        catalog: {
          secrets: [{ name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" }],
        },
      });

    it("counts only started updates toward the 3 per run", async () => {
      const app = await needsPassword();
      await cacheIndex(app);
      // Three installs without the secret come first and are left for an admin.
      for (const id of ["a1", "a2", "a3"]) await addInstall(id, 0, false);
      await settings({ apps: "on" });
      const r = await run(app);
      expect(r.outcome.apps.map((a) => [a.installId, a.status])).toEqual([
        ["a1", "left"],
        ["a2", "left"],
        ["a3", "left"],
        [INSTALL_ID, "started"],
      ]);
    });

    it("starts at most 3 and leaves the rest for the next run", async () => {
      const app = await needsPassword();
      await cacheIndex(app);
      for (const id of ["b1", "b2", "b3"]) await addInstall(id, 0, true);
      await settings({ apps: "on" });
      const r = await run(app);
      expect(r.created.map((c) => c.params.installId)).toEqual(["b1", "b2", "b3"]);
      expect(r.outcome.apps.at(-1)).toEqual({
        installId: INSTALL_ID,
        slug: "cut",
        status: "skipped",
        reason: "limit",
      });
    });

    it("tries at most 10 per run", async () => {
      const app = await needsPassword();
      await cacheIndex(app);
      for (let i = 0; i < 11; i++) await addInstall(`c${String(i).padStart(2, "0")}`, 0, false);
      await settings({ apps: "on" });
      const r = await run(app);
      const statuses = r.outcome.apps.map((a) => a.status);
      expect(statuses.filter((s) => s === "left")).toHaveLength(10);
      expect(r.outcome.apps.filter((a) => a.status === "skipped").map((a) => a.installId)).toEqual([
        "c10",
        INSTALL_ID,
      ]);
    });
  });

  it("skips everything without a Cloudflare token", async () => {
    await settings({ apps: "on", manager: "on" });
    const r = await run(fixture, { token: null });
    expect(r.outcome.idle).toBe("no-token");
    expect(r.created).toEqual([]);
    expect(scheduledUpdatesLog(r.outcome)).toEqual([
      "automatic updates: skipped, the Cloudflare token is not configured",
    ]);
  });

  describe("Appflare itself", () => {
    it("starts a self-update when nothing runs, and nothing else that run", async () => {
      await publishRelease(fixture, "0.6.0");
      await settings({ apps: "on", manager: "on" });
      const r = await run(fixture);
      expect(r.outcome.selfUpdate).toEqual({ status: "started", version: "0.6.0", jobId: "job1" });
      expect(r.outcome.apps).toEqual([]);
      expect(r.created.map((c) => c.params.kind)).toEqual(["self_update"]);
      expect(r.rows).toMatchObject([
        { id: "job1", install_id: null, kind: "self_update", started_by: "schedule" },
      ]);
      // The app's update waits for the next run.
      expect(r.install?.status).toBe("installed");
    });

    it("does not start while another job runs; apps still get their turn", async () => {
      await publishRelease(fixture, "0.6.0");
      await env.DB.prepare(
        "INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at) VALUES ('i2', 'other', 'other', '1.0.0', 'x', 'installed', 2, 2)",
      ).run();
      await env.DB.prepare(
        `INSERT INTO jobs (id, install_id, kind, status, input_json)
         VALUES ('busy', 'i2', 'reconfigure', 'running', '{}')`,
      ).run();
      await settings({ apps: "on", manager: "on" });
      const r = await run(fixture);
      expect(r.outcome.selfUpdate).toMatchObject({ status: "left", version: "0.6.0" });
      expect(r.created.map((c) => c.params.kind)).toEqual(["update"]);
    });

    it("never updates a development build, and not a release that already failed", async () => {
      await publishRelease(fixture, "0.6.0");
      await settings({ manager: "on" });
      const dev = await run(fixture, { version: "0.0.0-dev" });
      expect(dev.outcome.selfUpdate).toEqual({ status: "skipped", reason: "dev-build" });
      expect(dev.created).toEqual([]);

      await env.DB.prepare(
        `INSERT INTO jobs (id, kind, status, input_json)
         VALUES ('old', 'self_update', 'failed', '{"version":"0.6.0","fromVersion":"0.5.0"}')`,
      ).run();
      const failed = await run(fixture);
      expect(failed.outcome.selfUpdate).toEqual({ status: "skipped", reason: "failed-before" });
      expect(failed.created).toEqual([]);
    });

    it("waits while the running version is the newest", async () => {
      await publishRelease(fixture, "0.5.0");
      await settings({ manager: "on" });
      const r = await run(fixture);
      expect(r.outcome.selfUpdate).toEqual({ status: "skipped", reason: "up-to-date" });
      expect(r.created).toEqual([]);
    });
  });
});
