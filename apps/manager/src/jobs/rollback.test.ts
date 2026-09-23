import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { listSnapshotsCore, startRollbackCore } from "../installs/versions.server";
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

async function rollback(world: Partial<FakeAccount> = {}) {
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
      deps: { fetch: fake.fetch },
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
    });
    // D1 is never touched by a rollback.
    expect(r.fake.state.calls.some((c) => c.includes("/d1/"))).toBe(false);
    expect(r.fake.state.restores).toEqual([]);
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
});
