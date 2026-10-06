import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { readAcceptedBypass } from "../access/accepted-paths.server";
import { protectInstall, resyncInstallAccessIfFailed } from "../access/protect.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { listSnapshotsCore, startRollbackCore } from "../installs/versions.server";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { fakeAccessAccount } from "../test/fake-access-account";
import { type FakeAccount, fakeAccount, NEW_VERSION, TOKEN } from "../test/fake-account";
import { type FakeEngine, fakeEngine } from "../test/fake-invocations";
import { fakeStep } from "../test/fake-step";
import { recordProtectedInstall } from "../test/protected-install";
import { recordFixtureRevision } from "../test/recorded-revision";
import { INSTALL_ID, OLD_MANIFEST, OLD_VERSION, seedInstall } from "../test/seed-install";
import { type RollbackJobParams, runRollback } from "./rollback";
import type { JobEnv } from "./run-job";

/**
 * End-to-end test of the rollback job against the fake Cloudflare API and
 * the local D1: an install updated from 1.0.0 to 1.1.0 goes back to the
 * version its snapshot recorded, and no database is touched.
 */

const NEW_MANIFEST = JSON.stringify({
  version: "1.1.0",
  worker: { migrations: [], crons: ["*/10 * * * *"] },
});

async function seedUpdated(): Promise<void> {
  await seedInstall({
    version: "1.1.0",
    currentVersionId: NEW_VERSION,
    manifestJson: NEW_MANIFEST,
    resources: [
      { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
      { kind: "d1", binding: "DB", name: "cut-db", cfId: "d1-1" },
    ],
  });
  await env.DB.prepare(
    "INSERT INTO jobs (id, install_id, kind, status, worker_version_id) VALUES ('upd1', ?1, 'update', 'succeeded', ?2)",
  )
    .bind(INSTALL_ID, NEW_VERSION)
    .run();
  await env.DB.prepare(
    `INSERT INTO snapshots (id, install_id, job_id, worker_version_id, d1_bookmarks_json, taken_at,
       catalog_version, manifest_json, artifact_url, artifact_digest, pin_sha, do_migration_tag,
       target_catalog_version)
     VALUES ('upd1', ?1, 'upd1', ?2, '{"d1-1":"bm-before"}', 1000, '1.0.0', ?3,
       'https://artifacts.test/cut/old.zip', ?4, 'oldsha', NULL, '1.1.0')`,
  )
    .bind(INSTALL_ID, OLD_VERSION, OLD_MANIFEST, "0".repeat(64))
    .run();
}

async function rollback(
  world: Partial<FakeAccount> = {},
  /** Wraps the fake's fetch (an app of several Workers routes each to its own fake). */
  wrapFetch?: (fake: ReturnType<typeof fakeAccount>) => FetchLike,
  /** More of the job's environment (the job Workflow binding). */
  extraEnv: Partial<JobEnv> = {},
  /** Runs once the rollback is started, before its job runs. */
  beforeRun?: () => Promise<void>,
  /** Runs the job in the engine that keeps Workers Free's 50 requests per invocation. */
  engine?: FakeEngine,
) {
  const fake = fakeAccount(null, {
    deployments: [
      { id: "dep-2", versions: [{ version_id: NEW_VERSION, percentage: 100 }] },
      { id: "dep-1", versions: [{ version_id: OLD_VERSION, percentage: 100 }] },
    ],
    bookmarks: { "d1-1": "bm-now" },
    ...world,
  });
  let params: RollbackJobParams | null = null;
  const { jobId } = await startRollbackCore(
    {
      db: env.DB,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => "rb1",
    },
    { installId: INSTALL_ID, snapshotId: "upd1" },
  );
  if (params === null) throw new Error("no Workflow params");
  await beforeRun?.();
  const step = fakeStep();
  const jobParams = params;
  const fetch = wrapFetch?.(fake) ?? fake.fetch;
  let error: unknown = null;
  try {
    if (engine === undefined) {
      await runRollback({
        params: jobParams,
        step,
        env: { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, ...extraEnv },
        deps: { fetch },
      });
    } else {
      await engine.run(() =>
        runRollback({
          params: jobParams,
          step: engine.step,
          env: { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, ...extraEnv },
          deps: { fetch: engine.fetch(fetch) },
        }),
      );
    }
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare(
    "SELECT status, error, worker_version_id FROM jobs WHERE id = ?1",
  )
    .bind(jobId)
    .first();
  const install = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<Record<string, unknown>>();
  return { fake, step, error, job, install };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedUpdated();
});

describe("rollback job", () => {
  it("leaves alone a Workflow of another script that a row without an id names", async () => {
    const old = await buildArtifactFixture({
      bindings: [{ type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "Jobs" }],
    });
    await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
      .bind(JSON.stringify(old.manifest))
      .run();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:workflow:JOBS', ?1, 'workflow', 'JOBS', 'cut-jobs', NULL, 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    const r = await rollback({ workflows: ["cut-jobs"] });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.fake.state.calls).toContain("GET /workflows/cut-jobs");
    expect(r.fake.state.calls).not.toContain("PUT /workflows/cut-jobs");
  });

  it("puts each Workflow the snapshot's version defines back on that version's class", async () => {
    const old = await buildArtifactFixture({
      bindings: [{ type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "Jobs" }],
    });
    await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
      .bind(JSON.stringify(old.manifest))
      .run();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:workflow:JOBS', ?1, 'workflow', 'JOBS', 'cut-jobs', 'wf-cut-jobs', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    const r = await rollback({
      workflows: ["cut-jobs"],
      workflowDefs: { "cut-jobs": { script_name: "cut", class_name: "JobsV2" } },
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.fake.state.workflowDefs).toEqual({
      "cut-jobs": { script_name: "cut", class_name: "Jobs", schedules: [] },
    });
    expect(r.step.names.indexOf("deploy snapshot version")).toBeLessThan(
      r.step.names.indexOf("update Workflow cut-jobs"),
    );
  });

  it("puts a Workflow back on the settings the snapshot's version gives it", async () => {
    // The snapshot's version sets a step limit and a retention; the serving
    // one set a concurrency limit instead.
    const settings = { limits: { steps: 300 }, default_retention: { success_retention: "2 days" } };
    const old = await buildArtifactFixture({
      bindings: [{ type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "Jobs" }],
      tweak: (m) => {
        m.worker.workflowSettings = { JOBS: settings };
      },
    });
    await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
      .bind(JSON.stringify(old.manifest))
      .run();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:workflow:JOBS', ?1, 'workflow', 'JOBS', 'cut-jobs', 'wf-cut-jobs', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    const r = await rollback({
      workflows: ["cut-jobs"],
      workflowDefs: {
        "cut-jobs": { script_name: "cut", class_name: "Jobs", concurrency: { limit: 2 } },
      },
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.fake.state.workflowDefs).toEqual({
      "cut-jobs": { script_name: "cut", class_name: "Jobs", schedules: [], ...settings },
    });
  });

  describe("a Workflow on a schedule only the serving version defines", () => {
    // The serving version adds SWEEP, run hourly; the snapshot's version has JOBS only.
    const seed = async () => {
      const jobs = { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "Jobs" };
      const old = await buildArtifactFixture({ bindings: [jobs] });
      const serving = await buildArtifactFixture({
        version: "1.1.0",
        bindings: [
          jobs,
          { type: "workflow", name: "SWEEP", workflow_name: "sweep", class_name: "Sweep" },
        ],
        catalog: { plan: "paid" },
        tweak: (m) => {
          m.worker.workflowSettings = {
            SWEEP: { schedules: ["0 * * * *"], concurrency: { limit: 1 } },
          };
        },
      });
      await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
        .bind(JSON.stringify(old.manifest))
        .run();
      await env.DB.prepare("UPDATE installs SET manifest_json = ?1 WHERE id = ?2")
        .bind(JSON.stringify(serving.manifest), INSTALL_ID)
        .run();
      await env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at) VALUES
         ('i1:worker:cut', ?1, 'worker', NULL, 'cut', 'cut', 1),
         ('i1:workflow:JOBS', ?1, 'workflow', 'JOBS', 'cut-jobs', 'wf-cut-jobs', 1),
         ('i1:workflow:SWEEP', ?1, 'workflow', 'SWEEP', 'cut-sweep', 'wf-cut-sweep', 1)`,
      )
        .bind(INSTALL_ID)
        .run();
    };
    const world = (): Partial<FakeAccount> => ({
      workflows: ["cut-jobs", "cut-sweep"],
      workflowDefs: {
        "cut-jobs": { script_name: "cut", class_name: "Jobs" },
        "cut-sweep": {
          script_name: "cut",
          class_name: "Sweep",
          concurrency: { limit: 1 },
          schedules: [{ cron: "0 * * * *" }],
        },
      },
    });
    const logsOf = async () =>
      (
        await env.DB.prepare(
          "SELECT level, message FROM job_logs WHERE job_id = 'rb1' ORDER BY id",
        ).all<{ level: string; message: string }>()
      ).results;

    it("takes its schedule off once the snapshot's version serves", async () => {
      await seed();
      const r = await rollback(world());
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.step.names.indexOf("update Workflow cut-jobs")).toBeLessThan(
        r.step.names.indexOf("take Workflow cut-sweep off its schedule"),
      );
      // Still there for the uninstall, on its class and other settings, without a schedule.
      expect(r.fake.state.workflowDefs["cut-sweep"]).toEqual({
        script_name: "cut",
        class_name: "Sweep",
        concurrency: { limit: 1 },
        schedules: [],
      });
      expect(await logsOf()).toContainEqual({
        level: "info",
        message:
          'Appflare took the Workflow "cut-sweep" off its schedule "0 * * * *": version 1.0.0 does not define it, so each instance the schedule started would fail. A version that defines it puts the schedule back.',
      });
    });

    it("warns, saying what to do, when Cloudflare refuses to take it off", async () => {
      await seed();
      const r = await rollback({
        ...world(),
        failOnce: new Map([["PUT /workflows/cut-sweep", 400]]),
      });
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      const warning = (await logsOf()).find(
        (l) => l.level === "warn" && l.message.includes('"cut-sweep"'),
      );
      expect(warning?.message).toMatch(
        /^The Workflow "cut-sweep" still starts on the schedule "0 \* \* \* \*", but version 1\.0\.0 does not define it, so each instance it starts fails: Cloudflare refused to take the schedule off \(.+\)\. Delete the Workflow in the Cloudflare dashboard, or update the app to a version that defines it\.$/,
      );
    });
  });

  it("redeploys the snapshot's version and restores the install's catalog state, not its data", async () => {
    const r = await rollback();
    expect(r.error).toBeNull();
    expect(r.job).toEqual({ status: "succeeded", error: null, worker_version_id: OLD_VERSION });
    expect(r.step.names).toEqual([
      "start",
      "deploy snapshot version",
      "read the version's secrets",
      "record rollback",
      "look up workers.dev subdomain",
      "health check 1",
      "finish",
    ]);
    // Forced, so a secret an update added cannot block the rollback; and logged.
    expect(r.fake.state.deployForced).toEqual([true]);
    expect(
      (
        await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'rb1'").all<{
          message: string;
        }>()
      ).results.some((l) => l.message.includes("deployment forced")),
    ).toBe(true);
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: OLD_VERSION, percentage: 100 },
    ]);
    expect(r.install).toMatchObject({
      status: "installed",
      current_version_id: OLD_VERSION,
      catalog_version: "1.0.0",
      manifest_json: OLD_MANIFEST,
      artifact_url: "https://artifacts.test/cut/old.zip",
      pin_sha: "oldsha",
      health_status: "verified",
    });
    // D1 is never touched by a rollback.
    expect(r.fake.state.calls.some((c) => c.includes("/d1/"))).toBe(false);
    expect(r.fake.state.restores).toEqual([]);
  });

  it("turns automatic updates of the app off, so the cron does not update it straight back", async () => {
    await env.DB.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('auto_update_apps', 'on', 1)",
    ).run();
    const r = await rollback();
    expect(r.error).toBeNull();
    expect(r.install).toMatchObject({ auto_update: "off" });
    const logs = (
      await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'rb1'").all<{
        message: string;
      }>()
    ).results.map((l) => l.message);
    expect(logs).toContain(
      `Automatic updates of this app are now off, so the cron does not update it to 1.1.0 again. Turn them back on under [Automatic updates on the app's page](/apps/${INSTALL_ID}#automatic-updates) once a fixed version is out.`,
    );
  });

  it("leaves the automatic-update choice alone when they were off", async () => {
    const r = await rollback();
    expect(r.install).toMatchObject({ auto_update: "inherit" });
    const logs = (
      await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'rb1'").all<{
        message: string;
      }>()
    ).results.map((l) => l.message);
    expect(logs.some((m) => m.startsWith("Automatic updates"))).toBe(false);
  });

  it("checks health on the first custom domain while workers.dev is off", async () => {
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, name, cf_id, created_at) VALUES
         ('i1:domain:01B', ?1, 'domain', 'second.example.com', 'dom-2', 2),
         ('i1:domain:01A', ?1, 'domain', 'links.example.com', 'dom-1', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    await env.DB.prepare("UPDATE installs SET workers_dev_enabled = 0 WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    const r = await rollback({
      domainHealth: { "links.example.com": [{ status: 200, body: "ok" }] },
    });
    expect(r.error).toBeNull();
    expect(r.fake.state.domainProbes).toEqual(["links.example.com"]);
    expect(r.install).toMatchObject({ health_status: "verified" });
  });

  it("checks health on the domain the switch verified, while it is still attached", async () => {
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, name, cf_id, created_at) VALUES
         ('i1:domain:01A', ?1, 'domain', 'links.example.com', 'dom-1', 1),
         ('i1:domain:01B', ?1, 'domain', 'second.example.com', 'dom-2', 2)`,
    )
      .bind(INSTALL_ID)
      .run();
    await env.DB.prepare(
      "UPDATE installs SET workers_dev_enabled = 0, served_domain = 'second.example.com' WHERE id = ?1",
    )
      .bind(INSTALL_ID)
      .run();
    const r = await rollback({
      domainHealth: { "second.example.com": [{ status: 200, body: "ok" }] },
    });
    expect(r.error).toBeNull();
    expect(r.fake.state.domainProbes).toEqual(["second.example.com"]);
  });

  it("makes the secret records match the secrets the rolled-back version has", async () => {
    // Since the snapshot: API_KEY was removed (record deleted), NEW_TOKEN added.
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, created_at, deleted_at) VALUES
         ('i1:secret:ADMIN_PASSWORD', ?1, 'secret', 'ADMIN_PASSWORD', 'ADMIN_PASSWORD', 1, NULL),
         ('i1:secret:API_KEY', ?1, 'secret', 'API_KEY', 'API_KEY', 1, 5),
         ('i1:secret:NEW_TOKEN', ?1, 'secret', 'NEW_TOKEN', 'NEW_TOKEN', 6, NULL)`,
    )
      .bind(INSTALL_ID)
      .run();
    const r = await rollback({
      versionSecrets: { [OLD_VERSION]: ["ADMIN_PASSWORD", "API_KEY", "LEGACY"] },
    });
    expect(r.error).toBeNull();
    const rows = (
      await env.DB.prepare(
        "SELECT name, deleted_at FROM resources WHERE install_id = ?1 AND kind = 'secret' ORDER BY name",
      )
        .bind(INSTALL_ID)
        .all<{ name: string; deleted_at: number | null }>()
    ).results;
    expect(rows).toEqual([
      { name: "ADMIN_PASSWORD", deleted_at: null },
      { name: "API_KEY", deleted_at: null },
      { name: "LEGACY", deleted_at: null },
      { name: "NEW_TOKEN", deleted_at: expect.any(Number) },
    ]);
  });

  it("leaves the secret records alone when the version's secrets cannot be read", async () => {
    await env.DB.prepare(
      "INSERT INTO resources (id, install_id, kind, binding, name, created_at) VALUES ('i1:secret:A', ?1, 'secret', 'A', 'A', 1)",
    )
      .bind(INSTALL_ID)
      .run();
    // The fake knows no secrets of the version: it answers 404.
    const r = await rollback();
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded" });
    const row = await env.DB.prepare(
      "SELECT deleted_at FROM resources WHERE id = 'i1:secret:A'",
    ).first();
    expect(row).toEqual({ deleted_at: null });
  });

  it("gives the snapshot's version the queue consumers it had", async () => {
    // The snapshot's version consumed JOBS in batches of 10; the current one
    // changed that and also consumes EXPORT.
    const snapshotManifest = await buildArtifactFixture({
      bindings: [
        { type: "queue", name: "JOBS" },
        { type: "queue", name: "EXPORT" },
      ],
      tweak: (m) => {
        m.worker.queueConsumers = [{ queue: { binding: "JOBS" }, max_batch_size: 10 }];
      },
    });
    await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
      .bind(JSON.stringify(snapshotManifest.manifest))
      .run();
    await env.DB.prepare("UPDATE installs SET manifest_json = ?1 WHERE id = ?2")
      .bind(
        JSON.stringify({
          version: "1.1.0",
          worker: {
            migrations: [],
            queueConsumers: [
              { queue: { binding: "JOBS" }, max_batch_size: 5 },
              { queue: { binding: "EXPORT" } },
            ],
          },
        }),
        INSTALL_ID,
      )
      .run();
    for (const [id, kind, name, cfId] of [
      ["i1:queue:JOBS", "queue", "cut-jobs", "q-jobs"],
      ["i1:queue:EXPORT", "queue", "cut-export", "q-export"],
      ["i1:queue_consumer:JOBS", "queue_consumer", "cut-jobs", "c-jobs"],
      ["i1:queue_consumer:EXPORT", "queue_consumer", "cut-export", "c-export"],
    ] as const) {
      await env.DB.prepare(
        "INSERT INTO resources (id, install_id, kind, name, cf_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1)",
      )
        .bind(id, INSTALL_ID, kind, name, cfId)
        .run();
    }
    const r = await rollback({
      consumers: {
        "q-jobs": [{ consumer_id: "c-jobs", type: "worker", script_name: "cut" }],
        "q-export": [{ consumer_id: "c-export", type: "worker", script_name: "cut" }],
      },
    });
    expect(r.error).toBeNull();
    expect(r.step.names).toContain("update consumer of queue cut-jobs");
    expect(r.step.names).toContain("remove consumer of queue cut-export");
    expect(r.fake.state.consumers).toEqual({
      "q-jobs": [
        { consumer_id: "c-jobs", type: "worker", script_name: "cut", settings: { batch_size: 10 } },
      ],
      "q-export": [],
    });
    const exportConsumer = await env.DB.prepare(
      "SELECT deleted_at FROM resources WHERE id = 'i1:queue_consumer:EXPORT'",
    ).first<{ deleted_at: number | null }>();
    expect(exportConsumer?.deleted_at).not.toBeNull();
  });

  it("leaves the lifecycle rules an update set on a bucket, and names them in its log", async () => {
    const withRules = (version: string, lifecycle: unknown[]) =>
      JSON.stringify({
        version,
        worker: { migrations: [] },
        catalog: { resources: { r2: { FILES: { lifecycle } } } },
      });
    const keep = { id: "keep", prefix: "logs/", deleteAfterDays: 7 };
    await env.DB.prepare("UPDATE installs SET manifest_json = ?1 WHERE id = ?2")
      .bind(
        withRules("1.1.0", [keep, { id: "uploads", prefix: "uploads/", deleteAfterDays: 30 }]),
        INSTALL_ID,
      )
      .run();
    await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
      .bind(withRules("1.0.0", [keep]))
      .run();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at) VALUES
       ('i1:r2:FILES', ?1, 'r2', 'FILES', 'cut-files', 'cut-files', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    const r = await rollback();
    expect(r.job).toMatchObject({ status: "succeeded", error: null });
    // Nothing reads or writes the bucket's rules.
    expect(r.fake.state.calls.filter((c) => c.includes("/lifecycle"))).toEqual([]);
    const logs = (
      await env.DB.prepare(
        "SELECT level, message FROM job_logs WHERE job_id = 'rb1' ORDER BY id",
      ).all<{ level: string; message: string }>()
    ).results;
    expect(logs).toContainEqual({
      level: "warn",
      message:
        'The lifecycle rule "appflare:uploads" on R2 bucket "cut-files" stays: a rollback does not change a bucket\'s rules, and version 1.0.0 does not declare it this way. It goes on deleting or moving objects as it says; delete it in the bucket\'s settings if the app should not have it.',
    });
    expect(logs.filter((l) => l.message.includes("appflare:keep"))).toEqual([]);
  });

  it("records a Worker it cannot reach after the rollback without failing", async () => {
    const r = await rollback({ health: [{ status: 404, body: "error code: 1042" }] });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded", error: null });
    expect(r.install).toMatchObject({
      status: "installed",
      current_version_id: OLD_VERSION,
      health_status: "unverified",
    });
    expect(r.install?.health_checked_at).not.toBeNull();
  });

  it("fails without changing the install when Cloudflare refuses the deployment", async () => {
    const r = await rollback({
      failOnce: new Map([["POST /workers/scripts/cut/deployments", 400]]),
    });
    expect(r.job).toMatchObject({ status: "failed", worker_version_id: null });
    expect(String(r.job?.error)).toMatch(
      /^deploy snapshot version: .*-> 400: \[10000\] injected failure$/,
    );
    expect(r.install).toMatchObject({
      status: "installed",
      current_version_id: NEW_VERSION,
      catalog_version: "1.1.0",
    });
  });

  it("refuses to roll back across a Durable Object migration", async () => {
    await env.DB.prepare("UPDATE installs SET do_migration_tag = 'v2'").run();
    await env.DB.prepare("UPDATE snapshots SET do_migration_tag = 'v1'").run();
    const [view] = await listSnapshotsCore(env.DB, INSTALL_ID);
    expect(view?.crossesDoMigration).toBe(true);
    await expect(rollback()).rejects.toThrow(
      "This update changed the app's Durable Object classes, and Cloudflare refuses to roll a Worker back across such a change.",
    );
    expect(await env.DB.prepare("SELECT status FROM installs").first()).toEqual({
      status: "installed",
    });
  });

  it("refuses to roll back across a change to the Durable Objects its exports declare", async () => {
    const withExports = async (exports: Record<string, { type: string; [k: string]: unknown }>) =>
      JSON.stringify((await buildArtifactFixture({ exports })).manifest);
    const room = { type: "durable-object", storage: "sqlite" };
    await env.DB.prepare("UPDATE installs SET do_migration_tag = NULL").run();
    await env.DB.prepare("UPDATE snapshots SET do_migration_tag = NULL").run();
    const seed = async (snapshot: string, current: string) => {
      await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
        .bind(snapshot)
        .run();
      await env.DB.prepare("UPDATE installs SET manifest_json = ?1 WHERE id = ?2")
        .bind(current, INSTALL_ID)
        .run();
    };

    // An entrypoint-only change is not a class change.
    await seed(
      await withExports({ Room: room }),
      await withExports({ Room: room, Api: { type: "worker", cache: { enabled: true } } }),
    );
    expect((await listSnapshotsCore(env.DB, INSTALL_ID))[0]?.crossesDoMigration).toBe(false);

    await seed(await withExports({ Room: room }), await withExports({ Room: room, Chat: room }));
    expect((await listSnapshotsCore(env.DB, INSTALL_ID))[0]?.crossesDoMigration).toBe(true);
    await expect(rollback()).rejects.toThrow(
      "This update changed the app's Durable Object classes, and Cloudflare refuses to roll a Worker back across such a change.",
    );
    expect(await env.DB.prepare("SELECT status FROM installs").first()).toEqual({
      status: "installed",
    });
  });
});

describe("rollback job, an app of several Workers", () => {
  const JOBS_OLD = "11111111-2222-4333-8444-555555555555";
  const JOBS_NEW = "11111111-2222-4333-8444-666666666666";

  it("puts every other Worker back on its snapshot version before the primary one", async () => {
    const jobsWorker = (crons: string[]) => ({
      name: "jobs",
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
      crons,
    });
    const before = await buildArtifactFixture({ otherWorkers: [jobsWorker(["*/5 * * * *"])] });
    const after = await buildArtifactFixture({
      version: "1.1.0",
      otherWorkers: [jobsWorker(["*/15 * * * *"])],
    });
    await env.DB.prepare("UPDATE installs SET manifest_json = ?1 WHERE id = ?2")
      .bind(JSON.stringify(after.manifest), INSTALL_ID)
      .run();
    await env.DB.prepare(
      "UPDATE snapshots SET manifest_json = ?1, worker_versions_json = ?2 WHERE id = 'upd1'",
    )
      .bind(JSON.stringify(before.manifest), JSON.stringify({ "cut-jobs": JOBS_OLD }))
      .run();
    const jobs = fakeAccount(null, {
      worker: "cut-jobs",
      deployments: [
        { id: "dep-j2", versions: [{ version_id: JOBS_NEW, percentage: 100 }] },
        { id: "dep-j1", versions: [{ version_id: JOBS_OLD, percentage: 100 }] },
      ],
      schedules: ["*/15 * * * *"],
    });
    const r = await rollback(
      {},
      (fake) => async (input, init) =>
        (input.includes("/workers/scripts/cut-jobs") ? jobs : fake).fetch(input, init),
    );
    expect(r.error).toBeNull();
    expect(r.step.names.slice(0, 3)).toEqual([
      "start",
      'deploy snapshot version (Worker "cut-jobs")',
      "deploy snapshot version",
    ]);
    expect(jobs.state.deployForced).toEqual([true]);
    expect(jobs.state.deployments[0]?.versions).toEqual([
      { version_id: JOBS_OLD, percentage: 100 },
    ]);
    expect(jobs.state.schedules).toEqual(["*/5 * * * *"]);
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: OLD_VERSION, percentage: 100 },
    ]);
    // Both versions keep it on workers.dev: its address is left alone.
    expect(jobs.state.subdomainCalls).toEqual([]);
  });

  it("puts 17 other Workers back on Workers Free, spread over invocations of 50 requests", async () => {
    const names = Array.from({ length: 17 }, (_, i) => `gk-${i + 1}`);
    const others = (crons: string[], workersDev: boolean) =>
      names.map((name) => ({
        name,
        bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
        crons,
        ...(workersDev ? {} : { workersDev }),
      }));
    const before = await buildArtifactFixture({
      otherWorkers: others(["*/5 * * * *"], false),
      catalog: { plan: "free" },
    });
    const after = await buildArtifactFixture({
      version: "1.1.0",
      otherWorkers: others(["*/15 * * * *"], true),
      catalog: { plan: "free" },
    });
    const versionOf = (prefix: string, i: number) =>
      `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const record = (prefix: string) =>
      JSON.stringify(Object.fromEntries(names.map((n, i) => [`cut-${n}`, versionOf(prefix, i)])));
    await env.DB.prepare(
      "UPDATE installs SET manifest_json = ?1, worker_versions_json = ?2 WHERE id = ?3",
    )
      .bind(JSON.stringify(after.manifest), record("44444444"), INSTALL_ID)
      .run();
    await env.DB.prepare(
      "UPDATE snapshots SET manifest_json = ?1, worker_versions_json = ?2 WHERE id = 'upd1'",
    )
      .bind(JSON.stringify(before.manifest), record("33333333"))
      .run();
    const accounts = new Map(
      names.map((n, i) => [
        `cut-${n}`,
        fakeAccount(null, {
          worker: `cut-${n}`,
          deployments: [
            {
              id: `dep-${i}-2`,
              versions: [{ version_id: versionOf("44444444", i), percentage: 100 }],
            },
            {
              id: `dep-${i}-1`,
              versions: [{ version_id: versionOf("33333333", i), percentage: 100 }],
            },
          ],
          schedules: ["*/15 * * * *"],
        }),
      ]),
    );
    const engine = fakeEngine();
    const r = await rollback(
      {},
      (fake) => async (input, init) => {
        const name = /\/workers\/scripts\/(cut-[a-z0-9-]+)/.exec(input)?.[1];
        return ((name === undefined ? undefined : accounts.get(name)) ?? fake).fetch(input, init);
      },
      {},
      undefined,
      engine,
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(engine.invocations.length).toBeGreaterThan(1);
    expect(Math.max(...engine.invocations)).toBeLessThanOrEqual(50);
    const ran = engine.ran.map((s) => s.name);
    expect(new Set(ran).size).toBe(ran.length);
    for (const [i, n] of names.entries()) {
      const account = accounts.get(`cut-${n}`);
      // Off workers.dev before its snapshot version serves, then on it, with its crons back.
      expect(account?.state.deployments[0]?.versions).toEqual([
        { version_id: versionOf("33333333", i), percentage: 100 },
      ]);
      expect(account?.state.schedules).toEqual(["*/5 * * * *"]);
      expect(ran.indexOf(`deploy snapshot version (Worker "cut-${n}")`)).toBeLessThan(
        ran.indexOf("deploy snapshot version"),
      );
    }
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: OLD_VERSION, percentage: 100 },
    ]);
    // Every Worker back on its version in one invocation, the primary one last.
    const moves = engine.ran.filter(
      (s) =>
        s.name.startsWith("deploy snapshot version") || s.name.startsWith("turn off workers.dev"),
    );
    expect(moves).toHaveLength(2 * names.length + 1);
    expect(new Set(moves.map((s) => s.invocation)).size).toBe(1);
  });

  /** Rolls back from a version with `jobs` on workers.dev as `now` says to one as `then` says. */
  async function rollbackAcross(
    then: boolean,
    now: boolean,
    worlds: {
      primary?: Partial<FakeAccount>;
      jobs?: Partial<FakeAccount>;
      /** Refuses turning `jobs`'s workers.dev URL on. */
      refuseEnable?: boolean;
    } = {},
  ) {
    const jobsWorker = (workersDev: boolean) => ({
      name: "jobs",
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
      ...(workersDev ? {} : { workersDev }),
    });
    const before = await buildArtifactFixture({ otherWorkers: [jobsWorker(then)] });
    const after = await buildArtifactFixture({
      version: "1.1.0",
      otherWorkers: [jobsWorker(now)],
    });
    await env.DB.prepare(
      "UPDATE installs SET manifest_json = ?1, worker_versions_json = ?2 WHERE id = ?3",
    )
      .bind(JSON.stringify(after.manifest), JSON.stringify({ "cut-jobs": JOBS_NEW }), INSTALL_ID)
      .run();
    await env.DB.prepare(
      "UPDATE snapshots SET manifest_json = ?1, worker_versions_json = ?2 WHERE id = 'upd1'",
    )
      .bind(JSON.stringify(before.manifest), JSON.stringify({ "cut-jobs": JOBS_OLD }))
      .run();
    const jobs = fakeAccount(null, {
      worker: "cut-jobs",
      deployments: [
        { id: "dep-j2", versions: [{ version_id: JOBS_NEW, percentage: 100 }] },
        { id: "dep-j1", versions: [{ version_id: JOBS_OLD, percentage: 100 }] },
      ],
      ...worlds.jobs,
    });
    const r = await rollback(worlds.primary ?? {}, (fake) => async (input, init) => {
      if (
        worlds.refuseEnable === true &&
        input.endsWith("/workers/scripts/cut-jobs/subdomain") &&
        String(init?.body).includes('"enabled":true')
      ) {
        return Response.json(
          { success: false, errors: [{ code: 10000, message: "injected refusal" }] },
          { status: 400 },
        );
      }
      return (input.includes("/workers/scripts/cut-jobs") ? jobs : fake).fetch(input, init);
    });
    return { ...r, jobs };
  }

  it("puts a Worker's address back when turning it off fails", async () => {
    const r = await rollbackAcross(false, true, {
      jobs: { failOnce: new Map([["POST /workers/scripts/cut-jobs/subdomain", 400]]) },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^turn off workers\.dev route \(Worker "cut-jobs"\):/);
    // Never moved; its address is turned back on for the version it serves.
    expect(r.jobs.state.deployments[0]?.versions[0]?.version_id).toBe(JOBS_NEW);
    expect(r.jobs.state.subdomainCalls).toEqual([{ enabled: true, previews_enabled: true }]);
    expect(r.step.names).toContain('enable workers.dev route (Worker "cut-jobs")');
  });

  it("returns a Worker it moved, with its address, when the primary Worker's rollback fails", async () => {
    const r = await rollbackAcross(false, true, {
      primary: { failOnce: new Map([["POST /workers/scripts/cut/deployments", 400]]) },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^deploy snapshot version:/);
    expect(r.jobs.state.deployments.map((d) => d.versions[0]?.version_id)).toEqual([
      JOBS_NEW,
      JOBS_OLD,
      JOBS_NEW,
      JOBS_OLD,
    ]);
    expect(r.jobs.state.subdomainCalls).toEqual([
      { enabled: false, previews_enabled: false },
      { enabled: true, previews_enabled: true },
    ]);
    expect(JSON.parse(String(r.install?.worker_versions_json))).toEqual({ "cut-jobs": JOBS_NEW });
  });

  it("reports a Worker whose address it could not put back", async () => {
    const r = await rollbackAcross(false, true, {
      primary: { failOnce: new Map([["POST /workers/scripts/cut/deployments", 400]]) },
      refuseEnable: true,
    });
    expect(r.job?.status).toBe("failed");
    // Back on its version; only its address stays off.
    expect(r.jobs.state.deployments[0]?.versions[0]?.version_id).toBe(JOBS_NEW);
    const logs = (
      await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'rb1'").all<{
        message: string;
      }>()
    ).results.map((l) => l.message);
    expect(
      logs.some((m) => m.includes('could not turn the workers.dev URL of "cut-jobs" back on')),
    ).toBe(true);
  });

  it("takes a Worker off workers.dev before the snapshot version that keeps it private serves", async () => {
    const r = await rollbackAcross(false, true);
    expect(r.error).toBeNull();
    expect(r.jobs.state.subdomainCalls).toEqual([{ enabled: false, previews_enabled: false }]);
    const names = r.step.names;
    expect(names.indexOf('turn off workers.dev route (Worker "cut-jobs")')).toBeLessThan(
      names.indexOf('deploy snapshot version (Worker "cut-jobs")'),
    );
  });

  describe("of 18 Workers", () => {
    const OTHER_NAMES = [
      "backend",
      ...Array.from({ length: 16 }, (_, i) => `gk-${String(i + 1).padStart(2, "0")}`),
    ];
    const oldOf = (i: number) => `22222222-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const newOf = (i: number) => `33333333-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const others = OTHER_NAMES.map((name) => ({
      name,
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
    }));

    /**
     * Rolls back 18 Workers, a fake account per other Worker serving its new
     * version; `refuse` answers 400 to the n-th deployment call of a Worker.
     */
    async function rollbackMany(refuse: Record<string, number> = {}) {
      const before = await buildArtifactFixture({ otherWorkers: others });
      const after = await buildArtifactFixture({ version: "1.1.0", otherWorkers: others });
      const versions = (of: (i: number) => string) =>
        JSON.stringify(Object.fromEntries(OTHER_NAMES.map((n, i) => [`cut-${n}`, of(i)])));
      await env.DB.prepare(
        "UPDATE installs SET manifest_json = ?1, worker_versions_json = ?2 WHERE id = ?3",
      )
        .bind(JSON.stringify(after.manifest), versions(newOf), INSTALL_ID)
        .run();
      await env.DB.prepare(
        "UPDATE snapshots SET manifest_json = ?1, worker_versions_json = ?2 WHERE id = 'upd1'",
      )
        .bind(JSON.stringify(before.manifest), versions(oldOf))
        .run();
      const accounts = new Map(
        OTHER_NAMES.map((name, i) => [
          `cut-${name}`,
          fakeAccount(null, {
            worker: `cut-${name}`,
            deployments: [
              { id: `dep-${i}-2`, versions: [{ version_id: newOf(i), percentage: 100 }] },
              { id: `dep-${i}-1`, versions: [{ version_id: oldOf(i), percentage: 100 }] },
            ],
          }),
        ]),
      );
      const deploys = new Map<string, number>();
      const r = await rollback({}, (fake) => async (input, init) => {
        const name = /\/workers\/scripts\/(cut-[a-z0-9-]+)/.exec(input)?.[1];
        const account = name === undefined ? undefined : accounts.get(name);
        if (name !== undefined && init?.method === "POST" && input.includes("/deployments")) {
          const n = (deploys.get(name) ?? 0) + 1;
          deploys.set(name, n);
          if (refuse[name] === n) {
            return Response.json(
              { success: false, errors: [{ code: 10000, message: "injected refusal" }] },
              { status: 400 },
            );
          }
        }
        return (account ?? fake).fetch(input, init);
      });
      const serving = (name: string) =>
        accounts.get(name)?.state.deployments[0]?.versions[0]?.version_id;
      return { ...r, serving };
    }

    it("puts all 17 other Workers back on their snapshot versions, then the primary one", async () => {
      const r = await rollbackMany();
      expect(r.error).toBeNull();
      const names = r.step.names;
      expect(new Set(names).size).toBe(names.length);
      for (const [i, name] of OTHER_NAMES.entries()) {
        expect(r.serving(`cut-${name}`)).toBe(oldOf(i));
        expect(names.indexOf(`deploy snapshot version (Worker "cut-${name}")`)).toBeLessThan(
          names.indexOf("deploy snapshot version"),
        );
      }
      // Each Worker is one deployment step; nothing else of it runs when its
      // workers.dev address, crons and consumers are unchanged.
      expect(names.filter((n) => n.includes('(Worker "cut-'))).toHaveLength(17);
      expect(JSON.parse(String(r.install?.worker_versions_json))).toEqual(
        Object.fromEntries(OTHER_NAMES.map((n, i) => [`cut-${n}`, oldOf(i)])),
      );
    });

    it("returns the Workers it moved when one fails midway, and records one it cannot return", async () => {
      // gk-08 refuses its rollback; backend then refuses its return.
      const r = await rollbackMany({ "cut-gk-08": 1, "cut-backend": 2 });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(/^deploy snapshot version \(Worker "cut-gk-08"\):/);
      const moved = OTHER_NAMES.slice(0, OTHER_NAMES.indexOf("gk-08") + 1);
      for (const [i, name] of OTHER_NAMES.entries()) {
        const expected = name === "backend" ? oldOf(i) : newOf(i);
        expect(r.serving(`cut-${name}`)).toBe(expected);
        if (moved.includes(name)) {
          expect(r.step.names).toContain(`return to serving version (Worker "cut-${name}")`);
        }
      }
      // The primary Worker was never touched.
      expect(r.fake.state.deployments[0]?.versions[0]?.version_id).toBe(NEW_VERSION);
      expect(JSON.parse(String(r.install?.worker_versions_json))).toEqual(
        Object.fromEntries(
          OTHER_NAMES.map((n, i) => [`cut-${n}`, n === "backend" ? oldOf(i) : newOf(i)]),
        ),
      );
      expect(r.install).toMatchObject({ status: "installed", catalog_version: "1.1.0" });
      const logs = (
        await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'rb1'").all<{
          message: string;
        }>()
      ).results.map((l) => l.message);
      expect(logs.some((m) => m.includes("are back on the versions they served"))).toBe(true);
      expect(logs.some((m) => m.includes('"cut-backend" may still serve the snapshot'))).toBe(true);
    });
  });

  it("puts a Worker back on workers.dev once the snapshot version that wants it serves", async () => {
    const r = await rollbackAcross(true, false);
    expect(r.error).toBeNull();
    expect(r.jobs.state.subdomainCalls).toEqual([{ enabled: true, previews_enabled: true }]);
    const names = r.step.names;
    expect(names.indexOf('enable workers.dev route (Worker "cut-jobs")')).toBeGreaterThan(
      names.indexOf('deploy snapshot version (Worker "cut-jobs")'),
    );
  });
});

describe("rollback job, an app protected with Cloudflare Access", () => {
  const AUTH = "auth-secret-0123456789abcdef0123456789";
  const JOBS_OLD = "11111111-2222-4333-8444-555555555555";
  const JOBS_NEW = "11111111-2222-4333-8444-666666666666";

  /**
   * The install at 1.1.0 (public paths `/s/*` and `/old/*`), protected, and a
   * snapshot of 1.0.0 (public path `/s/*`, a var filled in with
   * `{{accessAud}}`) deployed before the app was protected.
   */
  async function protectedWorld(
    snapshotAud: string | null,
    /** Both versions' entries say it in a revision recorded for their release, not when built. */
    revised = false,
    extra: {
      /** A second Worker, `cut-jobs`, in both versions, answered by this account. */
      jobs?: ReturnType<typeof fakeAccount>;
      /** The snapshot's version's cron triggers (the current one has none). */
      snapshotCrons?: string[];
    } = {},
  ) {
    const { jobs } = extra;
    const others =
      jobs === undefined
        ? {}
        : {
            otherWorkers: [{ name: "jobs", bindings: [{ type: "kv_namespace", name: "CUT_KV" }] }],
          };
    const currentEntry = { access: { bypass: ["/s/*", "/old/*"] } };
    const beforeEntry = {
      vars: [{ name: "POLICY_AUD", label: "Audience", default: "{{accessAud}}", optional: true }],
      requires: ["access" as const],
      access: { bypass: ["/s/*"] },
    };
    const current = await buildArtifactFixture({
      version: "1.1.0",
      ...(revised ? { revision: currentEntry } : { catalog: currentEntry }),
      ...others,
    });
    const before = await buildArtifactFixture({
      version: "1.0.0",
      ...(revised ? { revision: beforeEntry } : { catalog: beforeEntry }),
      ...others,
      ...(extra.snapshotCrons === undefined ? {} : { crons: extra.snapshotCrons }),
    });
    const manifestText = (f: typeof current) => new TextDecoder().decode(f.manifestBytes);
    await env.DB.prepare(
      "UPDATE installs SET manifest_json = ?2, artifact_digest = ?3 WHERE id = ?1",
    )
      .bind(INSTALL_ID, manifestText(current), current.digest)
      .run();
    await env.DB.prepare(
      "UPDATE snapshots SET manifest_json = ?2, artifact_digest = ?4, access_aud = ?3, config_json = '{}' WHERE id = 'upd1'",
    )
      .bind(INSTALL_ID, manifestText(before), snapshotAud, before.digest)
      .run();
    if (jobs !== undefined) {
      await env.DB.prepare("UPDATE snapshots SET worker_versions_json = ?1 WHERE id = 'upd1'")
        .bind(JSON.stringify({ "cut-jobs": JOBS_OLD }))
        .run();
    }
    if (revised) {
      await recordFixtureRevision(current);
      await recordFixtureRevision(before);
    }
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:worker:cut', ?1, 'worker', NULL, 'cut', 'cut', 1)`,
    )
      .bind(INSTALL_ID)
      .run();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, role) VALUES ('u1', 'Owner', 'owner@example.com', 'admin')",
    ).run();
    const access = fakeAccessAccount();
    access.scripts.push({ id: "cut", tag: "tag-cut" });
    await protectInstall(
      { db: env.DB, client: access.client, authSecret: AUTH },
      { installId: INSTALL_ID },
    );
    const route =
      (fake: ReturnType<typeof fakeAccount>): FetchLike =>
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.includes("/access/") || path.endsWith("/workers/scripts")) {
          return access.fetch(String(input), init);
        }
        if (jobs !== undefined && path.includes("/workers/scripts/cut-jobs")) {
          return jobs.fetch(String(input), init);
        }
        return fake.fetch(String(input), init);
      };
    return { access, route };
  }

  const syncFailedAt = async () =>
    (
      await env.DB.prepare("SELECT access_sync_failed_at FROM install_access WHERE install_id = ?1")
        .bind(INSTALL_ID)
        .first<{ access_sync_failed_at: number | null }>()
    )?.access_sync_failed_at ?? null;

  const bypassUris = (access: ReturnType<typeof fakeAccessAccount>) =>
    [...access.apps.values()]
      .filter((a) => String(a.name).endsWith("public paths"))
      .flatMap((a) => (a.destinations as Array<{ uri: string }>).map((d) => d.uri));

  it("takes dropped public paths off before the old version serves, and refreshes its Access values", async () => {
    const w = await protectedWorld("");
    expect(bypassUris(w.access)).toEqual([
      "cut.appflare-dev.workers.dev/s/*",
      "cut.appflare-dev.workers.dev/old/*",
    ]);
    const created: Array<{ id: string; params: unknown }> = [];
    const r = await rollback({}, w.route, {
      JOBS: {
        create: async (o: { id: string; params: unknown }) => {
          created.push(o);
          return { id: o.id };
        },
      },
    });
    expect(r.error).toBeNull();
    const at = (name: string) => r.step.names.indexOf(name);
    expect(at("take dropped public paths off Cloudflare Access")).toBeLessThan(
      at("deploy snapshot version"),
    );
    expect(at("update Cloudflare Access destinations")).toBeGreaterThan(at("record rollback"));
    expect(at("settings for the current Cloudflare Access protection")).toBeGreaterThan(
      at("finish"),
    );
    expect(bypassUris(w.access)).toEqual(["cut.appflare-dev.workers.dev/s/*"]);
    // The old version was deployed unprotected: its settings get the current audience tag.
    expect(created).toHaveLength(1);
    expect(created[0]?.params).toMatchObject({ kind: "reconfigure", refreshVars: ["access"] });
  });

  it("fails before any Worker moves when the public paths the old version drops cannot be taken off", async () => {
    const jobs = fakeAccount(null, {
      worker: "cut-jobs",
      deployments: [
        { id: "dep-j2", versions: [{ version_id: JOBS_NEW, percentage: 100 }] },
        { id: "dep-j1", versions: [{ version_id: JOBS_OLD, percentage: 100 }] },
      ],
    });
    const w = await protectedWorld("", false, { jobs });
    w.access.forbidden.add("PUT /accounts/*");
    const r = await rollback({}, w.route);
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String((r.job as { error: string }).error)).toMatch(
      /^take dropped public paths off Cloudflare Access:/,
    );
    // Neither the other Worker nor the primary one was deployed.
    expect(r.step.names.filter((n) => n.includes('(Worker "cut-jobs")'))).toEqual([]);
    expect(jobs.state.deployments.map((d) => d.id)).toEqual(["dep-j2", "dep-j1"]);
    expect(r.step.names).not.toContain("deploy snapshot version");
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
    expect(r.install?.status).toBe("installed");
    // The current version keeps its public paths; the cron brings Access in step again.
    expect(bypassUris(w.access)).toEqual([
      "cut.appflare-dev.workers.dev/s/*",
      "cut.appflare-dev.workers.dev/old/*",
    ]);
    expect(await syncFailedAt()).not.toBeNull();
    const logs = await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'rb1'").all<{
      message: string;
    }>();
    expect(logs.results.map((l) => l.message)).toContain(
      'Rollback failed at "take dropped public paths off Cloudflare Access". Nothing was deployed; the current version keeps serving all traffic.',
    );
    // Nothing was taken off, so there is nothing to put back.
    expect(r.step.names).not.toContain("public paths back for the serving version");
  });

  it("marks the public paths it took off for the cron when it fails later, before the old version serves", async () => {
    const w = await protectedWorld("");
    const r = await rollback(
      { failOnce: new Map([["POST /workers/scripts/cut/deployments", 400]]) },
      w.route,
    );
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String((r.job as { error: string }).error)).toMatch(/^deploy snapshot version:/);
    expect(r.install?.status).toBe("installed");
    expect(r.step.names).toContain("public paths back for the serving version");
    expect(bypassUris(w.access)).toEqual(["cut.appflare-dev.workers.dev/s/*"]);
    expect(await syncFailedAt()).not.toBeNull();
    // The cron makes the current version's public paths public again.
    expect(
      await resyncInstallAccessIfFailed({ db: env.DB, client: async () => w.access.client }),
    ).toEqual([{ installId: INSTALL_ID, outcome: "unchanged" }]);
    expect(bypassUris(w.access)).toEqual([
      "cut.appflare-dev.workers.dev/s/*",
      "cut.appflare-dev.workers.dev/old/*",
    ]);
    expect(await syncFailedAt()).toBeNull();
  });

  it("leaves the public paths it took off when it fails after the old version serves", async () => {
    const w = await protectedWorld("", false, { snapshotCrons: ["*/5 * * * *"] });
    const r = await rollback(
      { failOnce: new Map([["PUT /workers/scripts/cut/schedules", 400]]) },
      w.route,
    );
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String((r.job as { error: string }).error)).toMatch(/^set cron triggers:/);
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: OLD_VERSION, percentage: 100 },
    ]);
    expect(r.step.names).not.toContain("public paths back for the serving version");
    expect(await syncFailedAt()).toBeNull();
    expect(bypassUris(w.access)).toEqual(["cut.appflare-dev.workers.dev/s/*"]);
  });

  it("reads both versions' public paths and settings from the revisions recorded for their releases", async () => {
    const w = await protectedWorld("", true);
    expect(bypassUris(w.access)).toEqual([
      "cut.appflare-dev.workers.dev/s/*",
      "cut.appflare-dev.workers.dev/old/*",
    ]);
    const created: Array<{ id: string; params: unknown }> = [];
    const r = await rollback({}, w.route, {
      JOBS: {
        create: async (o: { id: string; params: unknown }) => {
          created.push(o);
          return { id: o.id };
        },
      },
    });
    expect(r.error).toBeNull();
    expect(r.step.names.indexOf("take dropped public paths off Cloudflare Access")).toBeLessThan(
      r.step.names.indexOf("deploy snapshot version"),
    );
    expect(bypassUris(w.access)).toEqual(["cut.appflare-dev.workers.dev/s/*"]);
    // The rollback accepted the snapshot's version's public paths.
    expect(await readAcceptedBypass(createDb(env.DB), INSTALL_ID)).toEqual(["/s/*"]);
    // The revision's var reads the Access values: deployed again with the current ones.
    expect(created[0]?.params).toMatchObject({ kind: "reconfigure", refreshVars: ["access"] });
  });

  it("leaves the settings alone when the old version was deployed with the protection the app has", async () => {
    const w = await protectedWorld(null);
    const aud = (
      await env.DB.prepare("SELECT access_aud FROM install_access").first<{ access_aud: string }>()
    )?.access_aud;
    await env.DB.prepare("UPDATE snapshots SET access_aud = ?1 WHERE id = 'upd1'").bind(aud).run();
    const created: unknown[] = [];
    const r = await rollback({}, w.route, {
      JOBS: {
        create: async (o: { id: string }) => {
          created.push(o);
          return { id: o.id };
        },
      },
    });
    expect(r.error).toBeNull();
    expect(r.step.names).not.toContain("settings for the current Cloudflare Access protection");
    expect(created).toEqual([]);
  });
});

describe("rollback job, a version that must run behind Cloudflare Access", () => {
  it("refuses before anything changes when the app lost its protection after the rollback started", async () => {
    await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
      .bind(JSON.stringify({ version: "1.0.0", catalog: { access: { mode: "required" } } }))
      .run();
    await recordProtectedInstall({
      installId: INSTALL_ID,
      authSecret: "a".repeat(32),
      secret: "s",
    });
    const r = await rollback({}, undefined, {}, async () => {
      await env.DB.prepare("DELETE FROM install_access").run();
    });
    expect(r.job).toMatchObject({ status: "failed" });
    expect(String((r.job as { error: string }).error)).toContain(
      "This version must run behind Cloudflare Access. Turn protection on for the app first, then roll back.",
    );
    expect(r.step.names).not.toContain("deploy snapshot version");
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
  });
});
