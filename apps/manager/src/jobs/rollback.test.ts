import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { listSnapshotsCore, startRollbackCore } from "../installs/versions.server";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { type FakeAccount, fakeAccount, NEW_VERSION, TOKEN } from "../test/fake-account";
import { fakeStep } from "../test/fake-step";
import { INSTALL_ID, OLD_MANIFEST, OLD_VERSION, seedInstall } from "../test/seed-install";
import { type RollbackJobParams, runRollback } from "./rollback";

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
  const step = fakeStep();
  let error: unknown = null;
  try {
    await runRollback({
      params,
      step,
      env: { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN },
      deps: { fetch: wrapFetch?.(fake) ?? fake.fetch },
    });
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
