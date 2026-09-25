import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { capabilitiesView } from "../capabilities/capabilities";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import {
  NO_SANDBOX_JOBS,
  type SandboxReadiness,
  sandboxReadinessOf,
  withSandboxJobs,
} from "./readiness";
import { readSandboxJobState, readSandboxReadiness } from "./readiness.server";

const READY: SandboxReadiness = { state: "ready-auto", missing: null, confirmed: true };
const ON: SandboxReadiness = { state: "on", missing: null, confirmed: true };
const NEEDS_PLAN: SandboxReadiness = { state: "needs-plan", missing: "Upgrade.", confirmed: true };
const FAILED_ENABLE = { id: "j1", kind: "sandbox_enable", message: "deploy failed: 500" };

describe("withSandboxJobs", () => {
  it("is enabling while an enable job is queued or running, with its id", () => {
    expect(withSandboxJobs(READY, { activeEnable: { id: "j2" }, lastFailure: null })).toEqual({
      state: "enabling",
      missing: null,
      confirmed: true,
      jobId: "j2",
    });
    // A running enable wins over an older failure.
    expect(
      withSandboxJobs(NEEDS_PLAN, { activeEnable: { id: "j2" }, lastFailure: FAILED_ENABLE }).state,
    ).toBe("enabling");
  });

  it("is on once the enable succeeded and the binding serves", () => {
    expect(withSandboxJobs(ON, { activeEnable: { id: "j2" }, lastFailure: FAILED_ENABLE })).toBe(
      ON,
    );
  });

  it("falls back to the probes' state with the failed enable attached", () => {
    expect(withSandboxJobs(READY, { activeEnable: null, lastFailure: FAILED_ENABLE })).toEqual({
      ...READY,
      failure: { id: "j1", message: "deploy failed: 500" },
    });
    expect(withSandboxJobs(NEEDS_PLAN, { activeEnable: null, lastFailure: FAILED_ENABLE })).toEqual(
      { ...NEEDS_PLAN, failure: { id: "j1", message: "deploy failed: 500" } },
    );
  });

  it("ignores failed update and disable jobs, and nothing at all", () => {
    const update = { ...FAILED_ENABLE, kind: "sandbox_update" };
    expect(withSandboxJobs(READY, { activeEnable: null, lastFailure: update })).toBe(READY);
    expect(withSandboxJobs(READY, NO_SANDBOX_JOBS)).toBe(READY);
  });
});

describe("readSandboxJobState and readSandboxReadiness", () => {
  beforeEach(async () => {
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), {
      [SETTING.accountCapabilities]: JSON.stringify({
        checkedAt: "2026-09-25T12:00:00.000Z",
        r2: { state: "enabled" },
        containers: { state: "available" },
        workersPlan: { state: "paid" },
      }),
    });
  });

  async function seedJob(id: string, kind: string, status: string, error: string | null = null) {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, error, started_by) VALUES (?1, NULL, ?2, ?3, ?4, 'admin')",
    )
      .bind(id, kind, status, error)
      .run();
  }

  const readiness = () => readSandboxReadiness({ DB: env.DB }, createDb(env.DB));

  it("reads a queued or running enable as enabling, so a reload keeps showing it", async () => {
    expect((await readiness()).state).toBe("ready-auto");
    await seedJob("01J0000000000000000000000A", "sandbox_enable", "queued");
    expect(await readiness()).toMatchObject({
      state: "enabling",
      jobId: "01J0000000000000000000000A",
    });
    await env.DB.prepare("UPDATE jobs SET status = 'running'").run();
    expect((await readiness()).state).toBe("enabling");
  });

  it("does not count an update or disable in progress as enabling", async () => {
    await seedJob("01J0000000000000000000000A", "sandbox_update", "running");
    expect(await readSandboxJobState(env.DB)).toEqual({ activeEnable: null, lastFailure: null });
    expect((await readiness()).state).toBe("ready-auto");
  });

  it("goes back to the probes' state with the failure once the enable failed", async () => {
    await seedJob("01J0000000000000000000000A", "sandbox_enable", "failed", "deploy: boom");
    expect(await readiness()).toMatchObject({
      state: "ready-auto",
      failure: { id: "01J0000000000000000000000A", message: "deploy: boom" },
    });
  });

  it("is on when the binding serves, whatever the jobs say", async () => {
    await seedJob("01J0000000000000000000000A", "sandbox_enable", "succeeded");
    const on = await readSandboxReadiness({ DB: env.DB, SANDBOX: {} }, createDb(env.DB));
    expect(on).toEqual(sandboxReadinessOf(capabilitiesView(undefined, null), true));
  });
});
