import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient, type RequestLog } from "@appflare/cf-api";
import { generateVapidPrivateKey, vapidPublicKey } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { readAccountPlan, writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, fakeAccount, NEW_VERSION, TOKEN } from "../test/fake-account";
import { recordProtectedInstall } from "../test/protected-install";
import { recordFixtureRevision } from "../test/recorded-revision";
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

  it("refuses a version that must run behind Cloudflare Access while the app is not protected", async () => {
    const fixture = await buildArtifactFixture({
      version: "1.1.0",
      catalog: { access: { mode: "required" }, requires: ["access"] },
    });
    await seedInstall({ resources: [ADMIN_SECRET] });
    const created: unknown[] = [];
    const deps = {
      db: env.DB,
      loadApp: async () => fixture.index,
      loadManifest: async () => fixture.manifest,
      createJob: async (id: string, params: unknown) => {
        created.push(params);
        return { id };
      },
      newId: () => "job1",
    };
    await expect(startUpdateCore(deps, { installId: INSTALL_ID })).rejects.toThrow(
      "This version must run behind Cloudflare Access. Turn protection on for the app first, then update.",
    );
    expect(created).toEqual([]);
    // Once protected, it updates.
    await recordProtectedInstall({
      installId: INSTALL_ID,
      authSecret: "a".repeat(32),
      secret: "s",
    });
    expect(await startUpdateCore(deps, { installId: INSTALL_ID })).toEqual({ jobId: "job1" });
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
    { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" as const },
    { name: "API_KEY", label: "API key" },
  ];

  async function start(
    fixture: Awaited<ReturnType<typeof buildArtifactFixture>>,
    request: {
      secrets?: Record<string, string>;
      confirmNoPreview?: boolean;
      paidConfirmed?: boolean;
      rememberPaidPlan?: boolean;
    } = {},
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

  it("takes a new keyed secret by its key", async () => {
    await seedInstall({
      resources: [{ kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" }],
    });
    const fixture = await buildArtifactFixture({
      version: "1.1.0",
      catalog: {
        requires: ["secret-keys"],
        secrets: [
          { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" as const },
          { key: "APP_API_KEY", name: "API_KEY", label: "API key" },
        ],
      },
    });
    const { result, created } = await start(fixture, { secrets: { APP_API_KEY: "value" } });
    expect(result).toEqual({ jobId: "job1" });
    expect(created).toEqual([expect.objectContaining({ secrets: { APP_API_KEY: "value" } })]);
  });

  it("asks for the secrets a new version introduces, then carries them only in the params", async () => {
    await seedInstall({
      resources: [{ kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" }],
    });
    const fixture = await buildArtifactFixture({ version: "1.1.0", catalog: { secrets } });
    const first = await start(fixture);
    expect(first.result).toEqual({
      version: "1.1.0",
      needsSecrets: [expect.objectContaining({ name: "API_KEY", label: "API key" })],
      skipsPreview: null,
      build: null,
      cronTriggers: null,
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

  it("asks for a VAPID private key again when a version adds its public key var, and carries the var", async () => {
    await seedInstall({
      resources: [
        { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
        { kind: "secret", binding: "VAPID_PRIVATE_KEY", name: "VAPID_PRIVATE_KEY" },
      ],
    });
    const vapid = {
      name: "VAPID_PRIVATE_KEY",
      label: "Push signing key",
      generate: "vapid-private-key" as const,
    };
    const fixture = await buildArtifactFixture({
      version: "1.1.0",
      catalog: {
        secrets: [{ name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" }, vapid],
        vars: [
          {
            name: "VAPID_PUBLIC_KEY",
            label: "Push public key",
            derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
          },
        ],
      },
    });
    // The Worker has the private key, but its value cannot be read back.
    const first = await start(fixture);
    // Held: the form leaves it empty, so the key is never rotated unasked.
    expect(first.result).toMatchObject({
      needsSecrets: [vapid],
      heldSecrets: ["VAPID_PRIVATE_KEY"],
      derivedVars: [
        {
          name: "VAPID_PUBLIC_KEY",
          derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
        },
      ],
    });
    await expect(start(fixture, { secrets: { VAPID_PRIVATE_KEY: "hunter2" } })).rejects.toThrow(
      "Push signing key (VAPID_PRIVATE_KEY) must be a VAPID private key",
    );
    const privateKey = generateVapidPrivateKey();
    const second = await start(fixture, { secrets: { VAPID_PRIVATE_KEY: privateKey } });
    expect(second.created).toEqual([
      expect.objectContaining({
        secrets: { VAPID_PRIVATE_KEY: privateKey },
        vars: { VAPID_PUBLIC_KEY: await vapidPublicKey(privateKey) },
      }),
    ]);
    const job = await env.DB.prepare("SELECT input_json FROM jobs WHERE id = 'job1'").first<{
      input_json: string;
    }>();
    expect(job?.input_json).not.toContain(privateKey);
    expect(JSON.parse(job?.input_json ?? "{}").vars).toEqual(["VAPID_PUBLIC_KEY"]);
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

  it("notes the cron triggers a new version adds and asks whether the account is on Workers Paid", async () => {
    await seedInstall({
      resources: [ADMIN_SECRET, { kind: "cron", binding: null, name: "0 1 * * *" }],
    });
    const fixture = await buildArtifactFixture({
      version: "1.1.0",
      crons: ["0 1 * * *", "*/15 * * * *", "*/15 * * * *"],
    });
    const first = await start(fixture);
    expect(first.result).toEqual({
      version: "1.1.0",
      needsSecrets: [],
      skipsPreview: null,
      build: null,
      cronTriggers: 2,
    });
    expect(first.created).toEqual([]);
    // Either answer starts the job; the job counts the account's triggers unless it is yes.
    const free = await start(fixture, { paidConfirmed: false });
    expect(free.result).toEqual({ jobId: "job1" });
    expect(free.created).toEqual([expect.objectContaining({ paidConfirmed: false })]);
  });

  it("does not ask about cron triggers when Settings records Workers Paid", async () => {
    await seedInstall({ resources: [ADMIN_SECRET] });
    await writeAccountPlan(createDb(env.DB), "paid");
    const fixture = await buildArtifactFixture({ version: "1.1.0", crons: ["0 1 * * *"] });
    expect((await start(fixture)).result).toEqual({ jobId: "job1" });
  });

  it("records Workers Paid for the account when asked to remember the confirmation", async () => {
    await seedInstall({ resources: [ADMIN_SECRET] });
    const fixture = await buildArtifactFixture({ version: "1.1.0", crons: ["0 1 * * *"] });
    const started = await start(fixture, { paidConfirmed: true, rememberPaidPlan: true });
    expect(started.created).toEqual([expect.objectContaining({ paidConfirmed: true })]);
    expect(await readAccountPlan(createDb(env.DB))).toBe("paid");
  });

  it("leaves the plan unchanged when the update cannot be claimed", async () => {
    await seedInstall({ resources: [ADMIN_SECRET] });
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('busy', ?1, 'uninstall', 'running')",
    )
      .bind(INSTALL_ID)
      .run();
    const fixture = await buildArtifactFixture({ version: "1.1.0", crons: ["0 1 * * *"] });
    await expect(start(fixture, { paidConfirmed: true, rememberPaidPlan: true })).rejects.toThrow(
      /Another job of this install is queued or running/,
    );
    expect(await readAccountPlan(createDb(env.DB))).toBe("free");
  });

  it("does not ask about cron triggers when the count does not grow", async () => {
    await seedInstall({
      resources: [ADMIN_SECRET, { kind: "cron", binding: null, name: "0 1 * * *" }],
    });
    const same = await buildArtifactFixture({ version: "1.1.0", crons: ["0 2 * * *"] });
    const kept = await start(same);
    expect(kept.result).toEqual({ jobId: "job1" });
    expect(kept.created).toEqual([
      expect.not.objectContaining({ paidConfirmed: expect.anything() }),
    ]);
  });

  it("does not ask about cron triggers for an app that needs Workers Paid", async () => {
    await seedInstall({ resources: [ADMIN_SECRET] });
    const paid = await buildArtifactFixture({
      version: "1.1.0",
      catalog: { plan: "paid" },
      crons: ["0 1 * * *", "0 2 * * *"],
    });
    expect((await start(paid)).result).toEqual({ jobId: "job1" });
  });
});

describe("startRollbackCore", () => {
  it("refuses a version that must run behind Cloudflare Access while the app is not protected", async () => {
    await seedWithSnapshot();
    await env.DB.prepare("UPDATE snapshots SET manifest_json = ?1 WHERE id = 'upd1'")
      .bind(JSON.stringify({ version: "1.0.0", catalog: { access: { mode: "required" } } }))
      .run();
    const deps = {
      db: env.DB,
      createJob: async (id: string) => ({ id }),
      newId: () => "rb1",
    };
    await expect(
      startRollbackCore(deps, { installId: INSTALL_ID, snapshotId: "upd1" }),
    ).rejects.toThrow(
      "This version must run behind Cloudflare Access. Turn protection on for the app first, then roll back.",
    );
    await recordProtectedInstall({
      installId: INSTALL_ID,
      authSecret: "a".repeat(32),
      secret: "s",
    });
    expect(await startRollbackCore(deps, { installId: INSTALL_ID, snapshotId: "upd1" })).toEqual({
      jobId: "rb1",
    });
  });

  it("reads whether the snapshot's version must be protected from the revision recorded for its release", async () => {
    await seedWithSnapshot();
    // Released without a word about Access; a revision requires protection.
    const f = await buildArtifactFixture({
      revision: { requires: ["access"], access: { mode: "required" } },
    });
    await env.DB.prepare(
      "UPDATE snapshots SET manifest_json = ?1, artifact_digest = ?2 WHERE id = 'upd1'",
    )
      .bind(new TextDecoder().decode(f.manifestBytes), f.digest)
      .run();
    await recordFixtureRevision(f);
    const deps = {
      db: env.DB,
      createJob: async (id: string) => ({ id }),
      newId: () => "rb1",
    };
    await expect(
      startRollbackCore(deps, { installId: INSTALL_ID, snapshotId: "upd1" }),
    ).rejects.toThrow(
      "This version must run behind Cloudflare Access. Turn protection on for the app first, then roll back.",
    );
  });

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
    ).rejects.toThrow(/update, rollback or settings change of this install is running/);
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
        jobKind: "update",
        isCurrent: false,
        sameCode: false,
        crossesDoMigration: false,
        lostDatabase: null,
        emailNote: null,
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
    // A settings change of the installed version and artifact: only settings to put back.
    await env.DB.prepare(
      "UPDATE snapshots SET catalog_version = '1.1.0', artifact_digest = ?1 WHERE id = 'upd1'",
    )
      .bind("0".repeat(64))
      .run();
    expect((await listSnapshotsCore(env.DB, INSTALL_ID))[0]?.sameCode).toBe(true);
    // Members see the history without bookmarks.
    const [member] = await listSnapshotsCore(env.DB, INSTALL_ID, { withBookmarks: false });
    expect(member?.databases[0]?.bookmark).toBeNull();
  });
});
