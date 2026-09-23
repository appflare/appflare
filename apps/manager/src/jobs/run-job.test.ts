import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { fakeStep } from "../test/fake-step";
import { JOB_HANDLERS, NOT_IMPLEMENTED, runJob } from "./run-job";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await env.DB.prepare(
    "INSERT INTO jobs (id, kind, status, started_at) VALUES ('job1', 'install', 'running', ?1)",
  )
    .bind(Date.now())
    .run();
});

describe("runJob", () => {
  it("marks a job of an unimplemented kind failed and ends without retries", async () => {
    const step = fakeStep();
    await expect(runJob({ kind: "self_update", jobId: "job1" }, step, env)).rejects.toThrow(
      /not implemented/,
    );
    expect(step.names).toEqual(["mark job failed"]);
    const row = await env.DB.prepare(
      "SELECT status, error, finished_at FROM jobs WHERE id = 'job1'",
    ).first<{ status: string; error: string; finished_at: number | null }>();
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(NOT_IMPLEMENTED);
    expect(row?.finished_at).not.toBeNull();
  });

  it("rejects a payload without a known kind", async () => {
    await expect(runJob({ kind: "explode", jobId: "job1" }, fakeStep(), env)).rejects.toThrow(
      /invalid job payload/,
    );
  });

  it("dispatches install to the install handler, which rejects a payload without its fields", async () => {
    expect(JOB_HANDLERS.install.name).toBe("runInstall");
    await expect(runJob({ kind: "install", jobId: "job1" }, fakeStep(), env)).rejects.toThrow(
      /invalid install job payload/,
    );
  });

  it("dispatches uninstall to the uninstall handler, which rejects a payload without its fields", async () => {
    expect(JOB_HANDLERS.uninstall.name).toBe("runUninstall");
    await expect(runJob({ kind: "uninstall", jobId: "job1" }, fakeStep(), env)).rejects.toThrow(
      /invalid uninstall job payload/,
    );
  });

  it("dispatches update and rollback to their handlers, which reject payloads without their fields", async () => {
    expect(JOB_HANDLERS.update.name).toBe("runUpdate");
    expect(JOB_HANDLERS.rollback.name).toBe("runRollback");
    await expect(runJob({ kind: "update", jobId: "job1" }, fakeStep(), env)).rejects.toThrow(
      /invalid update job payload/,
    );
    await expect(runJob({ kind: "rollback", jobId: "job1" }, fakeStep(), env)).rejects.toThrow(
      /invalid rollback job payload/,
    );
  });
});
