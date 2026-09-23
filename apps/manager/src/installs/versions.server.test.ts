import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient, type RequestLog } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, fakeAccount, NEW_VERSION, TOKEN } from "../test/fake-account";
import { INSTALL_ID, OLD_VERSION, seedInstall } from "../test/seed-install";
import {
  listSnapshotsCore,
  restoreDatabaseCore,
  startRollbackCore,
  startUpdateCore,
  VersionActionError,
} from "./versions.server";

const NOW = new Date("2026-09-23T12:00:00.000Z");
/** The secret the fixture's catalog declares, already set on the Worker. */
const ADMIN_SECRET = { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" };

async function seedWithSnapshot(status = "installed"): Promise<void> {
  await seedInstall({
    status,
    version: "1.1.0",
    currentVersionId: NEW_VERSION,
    resources: [
      { kind: "d1", binding: "DB", name: "cut-db", cfId: "d1-1" },
      { kind: "d1", binding: "LOGS", name: "cut-logs", cfId: "d1-2" },
      { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
    ],
  });
  await env.DB.prepare(
    "INSERT INTO jobs (id, install_id, kind, status, worker_version_id) VALUES ('upd1', ?1, 'update', 'succeeded', ?2)",
  )
    .bind(INSTALL_ID, NEW_VERSION)
    .run();
  await env.DB.prepare(
    `INSERT INTO snapshots (id, install_id, job_id, worker_version_id, d1_bookmarks_json, taken_at,
       catalog_version, target_catalog_version)
     VALUES ('upd1', ?1, 'upd1', ?2, '{"d1-1":"bm-before"}', ?3, '1.0.0', '1.1.0')`,
  )
    .bind(INSTALL_ID, OLD_VERSION, NOW.getTime())
    .run();
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("startUpdateCore", () => {
  it("claims the install and starts an update to the catalog's newer version", async () => {
    const fixture = await buildArtifactFixture({ version: "1.1.0" });
    await seedInstall({ resources: [ADMIN_SECRET] });
    const created: unknown[] = [];
    const result = await startUpdateCore(
      {
        db: env.DB,
        loadApp: async () => fixture.index,
        loadManifest: async () => fixture.manifest,
        createJob: async (id, params) => {
          created.push(params);
          return { id: `wf-${id}` };
        },
        newId: () => "job1",
      },
      { installId: INSTALL_ID },
    );
    expect(result).toEqual({ jobId: "job1" });
    expect(created).toEqual([
      { kind: "update", jobId: "job1", installId: INSTALL_ID, version: "1.1.0", secrets: {} },
    ]);
    const job = await env.DB.prepare(
      "SELECT kind, status, workflow_instance_id, input_json FROM jobs WHERE id = 'job1'",
    ).first();
    expect(job).toEqual({
      kind: "update",
      status: "queued",
      workflow_instance_id: "wf-job1",
      input_json: JSON.stringify({
        installId: INSTALL_ID,
        fromVersion: "1.0.0",
        version: "1.1.0",
        secrets: [],
      }),
    });
    const install = await env.DB.prepare("SELECT status FROM installs").first();
    expect(install).toEqual({ status: "updating" });
  });

  it("refuses when the catalog has nothing newer, and while another job runs", async () => {
    const same = await buildArtifactFixture({ version: "1.0.0" });
    await seedInstall({ resources: [ADMIN_SECRET] });
    const deps = {
      db: env.DB,
      loadApp: async () => same.index,
      loadManifest: async () => same.manifest,
      createJob: async (id: string) => ({ id }),
    };
    await expect(startUpdateCore(deps, { installId: INSTALL_ID })).rejects.toThrow(
      "There is no newer version to update to: version 1.0.0 is already installed.",
    );
    const newer = await buildArtifactFixture({ version: "1.1.0" });
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('busy', ?1, 'uninstall', 'running')",
    )
      .bind(INSTALL_ID)
      .run();
    await expect(
      startUpdateCore(
        { ...deps, loadApp: async () => newer.index, loadManifest: async () => newer.manifest },
        { installId: INSTALL_ID },
      ),
    ).rejects.toThrow(/Another job of this install is queued or running/);
    const install = await env.DB.prepare("SELECT status FROM installs").first();
    expect(install).toEqual({ status: "installed" });
  });

  it("puts the install back when the Workflow cannot be created", async () => {
    const fixture = await buildArtifactFixture({ version: "1.1.0" });
    await seedInstall({ resources: [ADMIN_SECRET] });
    await expect(
      startUpdateCore(
        {
          db: env.DB,
          loadApp: async () => fixture.index,
          loadManifest: async () => fixture.manifest,
          createJob: async () => {
            throw new Error("binding down");
          },
          newId: () => "job1",
        },
        { installId: INSTALL_ID },
      ),
    ).rejects.toThrow("start: could not create the job: binding down");
    expect(await env.DB.prepare("SELECT status FROM installs").first()).toEqual({
      status: "installed",
    });
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = 'job1'").first()).toEqual({
      status: "failed",
    });
  });
});

describe("startUpdateCore: what an update needs first", () => {
  const secrets = [
    { name: "ADMIN_PASSWORD", label: "Admin password", generate: true },
    { name: "API_KEY", label: "API key", generate: false },
  ];

  async function start(
    fixture: Awaited<ReturnType<typeof buildArtifactFixture>>,
    request: { secrets?: Record<string, string>; confirmNoPreview?: boolean } = {},
  ) {
    const created: unknown[] = [];
    const result = await startUpdateCore(
      {
        db: env.DB,
        loadApp: async () => fixture.index,
        loadManifest: async () => fixture.manifest,
        createJob: async (id, params) => {
          created.push(params);
          return { id };
        },
        newId: () => "job1",
      },
      { installId: INSTALL_ID, ...request },
    );
    return { result, created };
  }

  it("asks for the secrets a new version introduces, then carries them only in the params", async () => {
    await seedInstall({
      resources: [{ kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" }],
    });
    const fixture = await buildArtifactFixture({ version: "1.1.0", catalog: { secrets } });
    const first = await start(fixture);
    expect(first.result).toEqual({
      version: "1.1.0",
      needsSecrets: [{ name: "API_KEY", label: "API key", generate: false }],
      skipsPreview: null,
      build: null,
    });
    expect(first.created).toEqual([]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first()).toEqual({ n: 0 });

    await expect(start(fixture, { secrets: { API_KEY: "" } })).rejects.toThrow(
      "API key (API_KEY) is required.",
    );
    await expect(start(fixture, { secrets: { API_KEY: "x", OTHER: "y" } })).rejects.toThrow(
      "This update does not take: OTHER.",
    );

    const second = await start(fixture, { secrets: { API_KEY: "value-DO-NOT-LEAK" } });
    expect(second.result).toEqual({ jobId: "job1" });
    expect(second.created).toEqual([
      expect.objectContaining({ secrets: { API_KEY: "value-DO-NOT-LEAK" } }),
    ]);
    const job = await env.DB.prepare("SELECT input_json FROM jobs WHERE id = 'job1'").first<{
      input_json: string;
    }>();
    expect(job?.input_json).not.toContain("value-DO-NOT-LEAK");
    expect(JSON.parse(job?.input_json ?? "{}").secrets).toEqual(["API_KEY"]);
  });

  it("asks to confirm an update that cannot be checked on a preview", async () => {
    await seedInstall({
      resources: [{ kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" }],
    });
    const fixture = await buildArtifactFixture({
      version: "1.1.0",
      bindings: [{ type: "durable_object_namespace", name: "ROOMS", class_name: "Room" }],
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
    });
    const first = await start(fixture);
    expect(first.result).toMatchObject({ needsSecrets: [] });
    expect((first.result as { skipsPreview: string }).skipsPreview).toMatch(
      /changes Durable Object classes/,
    );
    expect((await start(fixture, { confirmNoPreview: true })).result).toEqual({ jobId: "job1" });
  });
});

describe("startRollbackCore", () => {
  it("refuses a snapshot of the version that serves now, or of another install", async () => {
    await seedWithSnapshot();
    await env.DB.prepare("UPDATE installs SET current_version_id = ?1").bind(OLD_VERSION).run();
    const deps = { db: env.DB, createJob: async (id: string) => ({ id }) };
    await expect(
      startRollbackCore(deps, { installId: INSTALL_ID, snapshotId: "upd1" }),
    ).rejects.toThrow("The Worker already runs the version this snapshot recorded.");
    await expect(
      startRollbackCore(deps, { installId: INSTALL_ID, snapshotId: "nope" }),
    ).rejects.toBeInstanceOf(VersionActionError);
  });
});

describe("restoreDatabaseCore", () => {
  function deps() {
    const fake = fakeAccount(null, { bookmarks: { "d1-1": "bm-now" } });
    /** Log lines already written when the restore call went out. */
    const loggedBeforeCall: string[] = [];
    return {
      fake,
      loggedBeforeCall,
      deps: {
        db: env.DB,
        async restore(
          databaseId: string,
          bookmark: string,
          onRequest: (entry: RequestLog) => void,
        ) {
          const rows = await env.DB.prepare(
            "SELECT message FROM job_logs WHERE job_id = 'rs1' ORDER BY id",
          ).all<{ message: string }>();
          loggedBeforeCall.push(...rows.results.map((r) => r.message));
          return createClient({
            accountId: ACC,
            token: TOKEN,
            fetch: fake.fetch,
            onRequest,
          }).d1.restore(databaseId, { bookmark });
        },
        now: () => NOW,
        newId: () => "rs1",
      },
    };
  }

  it("restores a database to the snapshot's bookmark and records it as a restore", async () => {
    await seedWithSnapshot();
    const { fake, deps: d, loggedBeforeCall } = deps();
    const result = await restoreDatabaseCore(d, {
      installId: INSTALL_ID,
      snapshotId: "upd1",
      databaseResourceId: `${INSTALL_ID}:d1:DB`,
    });
    expect(result).toEqual({
      jobId: "rs1",
      databaseName: "cut-db",
      bookmark: "bm-before",
      previousBookmark: "bm-now",
    });
    expect(fake.state.restores).toEqual([{ databaseId: "d1-1", bookmark: "bm-before" }]);
    // The bookmark is in the history before Cloudflare is asked to restore.
    expect(loggedBeforeCall).toEqual([
      `Restoring D1 database cut-db to the bookmark taken ${NOW.toISOString()} (bm-before).`,
    ]);
    const job = await env.DB.prepare(
      "SELECT kind, status, input_json, workflow_instance_id FROM jobs WHERE id = 'rs1'",
    ).first<{ kind: string; status: string; input_json: string; workflow_instance_id: null }>();
    expect(job).toMatchObject({
      kind: "rollback",
      status: "succeeded",
      workflow_instance_id: null,
    });
    expect(JSON.parse(job?.input_json ?? "{}")).toMatchObject({
      restore: true,
      databaseId: "d1-1",
      bookmark: "bm-before",
    });
    const logs = (
      await env.DB.prepare(
        "SELECT message, data_json FROM job_logs WHERE job_id = 'rs1' ORDER BY id",
      ).all<{
        message: string;
        data_json: string;
      }>()
    ).results;
    expect(logs.at(-1)?.message).toBe(
      "Restored cut-db to bm-before. To undo this, restore it to bm-now.",
    );
    expect(JSON.parse(logs.at(-1)?.data_json ?? "{}")).toEqual({
      restore: true,
      bookmark: "bm-before",
      previous_bookmark: "bm-now",
      requests: [`POST /accounts/${ACC}/d1/database/d1-1/time_travel/restore -> 200`],
    });
    // The install's state and Worker are untouched.
    expect(await env.DB.prepare("SELECT status, current_version_id FROM installs").first()).toEqual(
      {
        status: "installed",
        current_version_id: NEW_VERSION,
      },
    );
  });

  it("refuses a database without a bookmark, a foreign resource, and a busy install", async () => {
    await seedWithSnapshot();
    const { fake, deps: d } = deps();
    await expect(
      restoreDatabaseCore(d, {
        installId: INSTALL_ID,
        snapshotId: "upd1",
        databaseResourceId: `${INSTALL_ID}:d1:LOGS`,
      }),
    ).rejects.toThrow("The snapshot has no bookmark for cut-logs.");
    await expect(
      restoreDatabaseCore(d, {
        installId: INSTALL_ID,
        snapshotId: "upd1",
        databaseResourceId: `${INSTALL_ID}:kv:CUT_KV`,
      }),
    ).rejects.toThrow("That is not a D1 database of this install.");
    await env.DB.prepare("UPDATE installs SET status = 'updating'").run();
    await expect(
      restoreDatabaseCore(d, {
        installId: INSTALL_ID,
        snapshotId: "upd1",
        databaseResourceId: `${INSTALL_ID}:d1:DB`,
      }),
    ).rejects.toThrow(/update or rollback of this install is running/);
    expect(fake.state.restores).toEqual([]);
  });

  it("records a failed restore and reports Cloudflare's reason", async () => {
    await seedWithSnapshot();
    const { fake, deps: d } = deps();
    fake.state.failOnce.set("POST /d1/database/d1-1/time_travel/restore", 400);
    await expect(
      restoreDatabaseCore(d, {
        installId: INSTALL_ID,
        snapshotId: "upd1",
        databaseResourceId: `${INSTALL_ID}:d1:DB`,
      }),
    ).rejects.toThrow(/^Cloudflare did not restore cut-db: .*injected failure/);
    const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = 'rs1'").first<{
      status: string;
      error: string;
    }>();
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/^restore D1 cut-db: /);
  });
});

describe("listSnapshotsCore", () => {
  it("lists snapshots with their versions and the databases they can restore", async () => {
    await seedWithSnapshot();
    expect(await listSnapshotsCore(env.DB, INSTALL_ID)).toEqual([
      {
        id: "upd1",
        takenAt: NOW.toISOString(),
        fromVersionId: OLD_VERSION,
        toVersionId: NEW_VERSION,
        fromCatalogVersion: "1.0.0",
        toCatalogVersion: "1.1.0",
        jobId: "upd1",
        jobStatus: "succeeded",
        isCurrent: false,
        crossesDoMigration: false,
        databases: [
          {
            resourceId: `${INSTALL_ID}:d1:DB`,
            name: "cut-db",
            databaseId: "d1-1",
            bookmark: "bm-before",
          },
        ],
      },
    ]);
    expect(await listSnapshotsCore(env.DB, "nope")).toEqual([]);
    // Members see the history without bookmarks.
    const [member] = await listSnapshotsCore(env.DB, INSTALL_ID, { withBookmarks: false });
    expect(member?.databases[0]?.bookmark).toBeNull();
  });
});
