import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { startUninstallCore } from "../installs/start-uninstall.server";
import {
  type ActiveJobRow,
  RESTORE_STALE_MS,
  reconcileJobs,
  type WorkflowLookup,
} from "./reconcile.server";

const NOW = new Date("2026-09-23T12:00:00.000Z");

/** A Workflow binding whose instances report fixed statuses; missing ids throw like the engine. */
function fakeWorkflows(statuses: Record<string, { status: string; error?: { message: string } }>) {
  const asked: string[] = [];
  const binding: WorkflowLookup = {
    async get(id) {
      asked.push(id);
      const reported = statuses[id];
      if (reported === undefined) throw new Error(`instance.not_found: ${id}`);
      return { status: async () => reported };
    },
  };
  return { binding, asked };
}

async function seed(installStatus: string, jobs: Array<[string, string, string, string | null]>) {
  await env.DB.prepare(
    `INSERT INTO installs (id, app_slug, worker_name, catalog_version, artifact_url, status, installed_at, updated_at)
     VALUES ('i1', 'cut', 'cut', '1', 'u', ?1, 1, 1)`,
  )
    .bind(installStatus)
    .run();
  for (const [id, kind, status, instance] of jobs) {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, workflow_instance_id) VALUES (?1, 'i1', ?2, ?3, ?4)",
    )
      .bind(id, kind, status, instance)
      .run();
  }
}

async function rows(): Promise<ActiveJobRow[]> {
  return (
    await env.DB.prepare(
      "SELECT id, kind, status, install_id, workflow_instance_id FROM jobs ORDER BY id",
    ).all<ActiveJobRow>()
  ).results;
}

async function job(id: string) {
  return env.DB.prepare("SELECT status, error, finished_at FROM jobs WHERE id = ?1")
    .bind(id)
    .first<{ status: string; error: string | null; finished_at: number | null }>();
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("reconcileJobs", () => {
  it("fails an uninstall job whose instance errored, so the uninstall can be retried", async () => {
    await seed("uninstalling", [["j1", "uninstall", "running", "j1"]]);
    const wf = fakeWorkflows({ j1: { status: "errored", error: { message: "engine crashed" } } });
    expect(await reconcileJobs(env.DB, wf.binding, await rows(), () => NOW)).toBe(true);
    expect(await job("j1")).toEqual({
      status: "failed",
      error: "the job's Workflow instance failed: engine crashed",
      finished_at: NOW.getTime(),
    });
    const log = await env.DB.prepare(
      "SELECT level, message FROM job_logs WHERE job_id = 'j1'",
    ).first();
    expect(log).toEqual({
      level: "error",
      message: "Stopped: the job's Workflow instance failed: engine crashed.",
    });
    // The install stays uninstalling, and a retry is no longer blocked.
    await expect(
      startUninstallCore(
        { db: env.DB, createJob: async (id) => ({ id }), newId: () => "j2" },
        { installId: "i1", retry: true },
      ),
    ).resolves.toEqual({ jobId: "j2" });
  });

  it("fails an install job that was terminated or is gone, and its install with it", async () => {
    await seed("installing", [["j1", "install", "running", "j1"]]);
    const wf = fakeWorkflows({ j1: { status: "terminated" } });
    await reconcileJobs(env.DB, wf.binding, await rows(), () => NOW);
    expect((await job("j1"))?.error).toBe("the job's Workflow instance was terminated");
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first();
    expect(install).toEqual({ status: "failed" });

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await seed("installing", [["j1", "install", "queued", "j1"]]);
    await reconcileJobs(env.DB, fakeWorkflows({}).binding, await rows(), () => NOW);
    expect((await job("j1"))?.error).toBe("the job's Workflow instance no longer exists");
  });

  it("leaves a job alone when the binding fails for another reason than a missing instance", async () => {
    await seed("installing", [["j1", "install", "running", "j1"]]);
    const flaky: WorkflowLookup = {
      async get() {
        throw new Error("internal error; reference = abc123");
      },
    };
    expect(await reconcileJobs(env.DB, flaky, await rows(), () => NOW)).toBe(false);
    expect(await job("j1")).toEqual({ status: "running", error: null, finished_at: null });
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first();
    expect(install).toEqual({ status: "installing" });
  });

  it("succeeds a job whose instance completed without recording it", async () => {
    await seed("uninstalling", [["j1", "uninstall", "running", "j1"]]);
    await reconcileJobs(
      env.DB,
      fakeWorkflows({ j1: { status: "complete" } }).binding,
      await rows(),
    );
    expect((await job("j1"))?.status).toBe("succeeded");
  });

  it("leaves live instances, finished rows, and instances still being created alone", async () => {
    await seed("installed", [
      ["j1", "install", "succeeded", "j1"],
      ["j2", "uninstall", "running", "j2"],
      ["j3", "uninstall", "queued", "j3"],
      ["j4", "uninstall", "queued", null],
    ]);
    const wf = fakeWorkflows({
      j2: { status: "waiting" },
      j3: { status: "queued" },
    });
    expect(await reconcileJobs(env.DB, wf.binding, await rows())).toBe(false);
    expect(wf.asked).toEqual(["j2", "j3", "j4"]);
    expect((await job("j2"))?.status).toBe("running");
    expect((await job("j3"))?.status).toBe("queued");
    // No instance id recorded yet and none found: it may still be being created.
    expect((await job("j4"))?.status).toBe("queued");
  });

  it("returns an install from updating to installed when its update or rollback died", async () => {
    await seed("updating", [["j1", "update", "running", "j1"]]);
    await reconcileJobs(
      env.DB,
      fakeWorkflows({ j1: { status: "errored", error: { message: "boom" } } }).binding,
      await rows(),
      () => NOW,
    );
    expect((await job("j1"))?.status).toBe("failed");
    expect(await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first()).toEqual({
      status: "installed",
    });

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await seed("updating", [["j1", "rollback", "running", "j1"]]);
    await reconcileJobs(env.DB, fakeWorkflows({}).binding, await rows(), () => NOW);
    expect((await job("j1"))?.error).toBe("the job's Workflow instance no longer exists");
    expect(await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first()).toEqual({
      status: "installed",
    });

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await seed("updating", [["j1", "update", "running", "j1"]]);
    await reconcileJobs(
      env.DB,
      fakeWorkflows({ j1: { status: "complete" } }).binding,
      await rows(),
      () => NOW,
    );
    expect((await job("j1"))?.status).toBe("succeeded");
    expect(await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first()).toEqual({
      status: "installed",
    });
  });

  it("fails a database restore whose request never recorded its end, once it is stale", async () => {
    await seed("installed", []);
    const startedAt = NOW.getTime() - RESTORE_STALE_MS - 1;
    await env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at)
       VALUES ('r1', 'i1', 'rollback', 'running', '{"restore":true}', ?1),
              ('r2', 'i1', 'rollback', 'running', '{"restore":true}', ?2)`,
    )
      .bind(startedAt, NOW.getTime() - 1000)
      .run();
    const wf = fakeWorkflows({});
    const restoreRows = (
      await env.DB.prepare(
        "SELECT id, kind, status, install_id, workflow_instance_id, input_json, started_at FROM jobs ORDER BY id",
      ).all<ActiveJobRow & { started_at: number }>()
    ).results.map((r) => ({ ...r, started_at: new Date(r.started_at) }));
    expect(await reconcileJobs(env.DB, wf.binding, restoreRows, () => NOW)).toBe(true);
    // Restores have no Workflow instance to ask about.
    expect(wf.asked).toEqual([]);
    expect((await job("r1"))?.status).toBe("failed");
    expect((await job("r1"))?.error).toMatch(/^the restore request ended without recording/);
    expect((await job("r2"))?.status).toBe("running");
  });
});
