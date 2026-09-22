import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { NOT_IMPLEMENTED, runJob, type StepRunner } from "./run-job";

/** Runs step callbacks inline and records the step names. */
function fakeStep(): StepRunner & { names: string[] } {
  const names: string[] = [];
  return {
    names,
    async do<T>(name: string, callback: () => Promise<T>): Promise<T> {
      names.push(name);
      return callback();
    },
  };
}

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
    await expect(runJob({ kind: "install", jobId: "job1" }, step, env.DB)).rejects.toThrow(
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
    await expect(runJob({ kind: "explode", jobId: "job1" }, fakeStep(), env.DB)).rejects.toThrow(
      /invalid job payload/,
    );
  });
});
