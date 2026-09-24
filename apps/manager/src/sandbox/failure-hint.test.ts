import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { firstLine, lastSandboxFailure } from "./failure-hint";
import { lastSandboxJobFailure } from "./jobs.server";

const job = (id: string, status: string, kind = "sandbox_enable") => ({ id, kind, status });

describe("lastSandboxFailure", () => {
  it("names the newest job when it failed", () => {
    const failed = job("j3", "failed", "sandbox_update");
    expect(lastSandboxFailure([failed, job("j2", "succeeded"), job("j1", "failed")])).toBe(failed);
  });

  it("names nothing once a newer job succeeded", () => {
    expect(lastSandboxFailure([job("j2", "succeeded"), job("j1", "failed")])).toBeNull();
    // A disable that succeeded after a failed enable clears it too.
    expect(
      lastSandboxFailure([job("j2", "succeeded", "sandbox_disable"), job("j1", "failed")]),
    ).toBeNull();
  });

  it("looks past a job still queued or running", () => {
    const failed = job("j1", "failed");
    expect(lastSandboxFailure([job("j3", "queued"), job("j2", "running"), failed])).toBe(failed);
    expect(lastSandboxFailure([job("j2", "running"), job("j1", "succeeded")])).toBeNull();
  });

  it("names nothing without a finished job", () => {
    expect(lastSandboxFailure([])).toBeNull();
    expect(lastSandboxFailure([job("j1", "running")])).toBeNull();
  });
});

describe("firstLine", () => {
  it("keeps the first non-empty line, trimmed", () => {
    expect(firstLine("\n  deploy failed: 500  \nstack")).toBe("deploy failed: 500");
    expect(firstLine("  \n ")).toBeNull();
    expect(firstLine(null)).toBeNull();
  });
});

describe("lastSandboxJobFailure", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
  });

  async function seedJob(id: string, kind: string, status: string, error: string | null = null) {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, error, started_by) VALUES (?1, NULL, ?2, ?3, ?4, 'admin')",
    )
      .bind(id, kind, status, error)
      .run();
  }

  async function seedLog(jobId: string, level: string, message: string) {
    await env.DB.prepare(
      "INSERT INTO job_logs (job_id, ts, level, message) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(jobId, Date.now(), level, message)
      .run();
  }

  it("names the failed job with its first error log line", async () => {
    await seedJob("01J0000000000000000000000A", "sandbox_enable", "succeeded");
    await seedJob("01J0000000000000000000000B", "sandbox_update", "failed", "deploy: boom");
    await seedLog("01J0000000000000000000000B", "info", "Found the release sandbox@0.1.2.");
    await seedLog(
      "01J0000000000000000000000B",
      "error",
      "deploy failed: 500 Internal\nmore detail",
    );
    await seedLog("01J0000000000000000000000B", "error", 'Stopped at "deploy".');
    // Another kind of job is not the sandbox Worker's.
    await seedJob("01J0000000000000000000000C", "install", "failed", "nope");

    expect(await lastSandboxJobFailure(env.DB)).toEqual({
      id: "01J0000000000000000000000B",
      kind: "sandbox_update",
      message: "deploy failed: 500 Internal",
    });
  });

  it("falls back to the recorded error when the job has no error log", async () => {
    await seedJob(
      "01J0000000000000000000000A",
      "sandbox_enable",
      "failed",
      "start: could not create the job: quota",
    );
    expect((await lastSandboxJobFailure(env.DB))?.message).toBe(
      "start: could not create the job: quota",
    );
  });

  it("names nothing once a newer job succeeded", async () => {
    await seedJob("01J0000000000000000000000A", "sandbox_enable", "failed", "preflight: no R2");
    await seedJob("01J0000000000000000000000B", "sandbox_enable", "succeeded");
    expect(await lastSandboxJobFailure(env.DB)).toBeNull();
  });
});
