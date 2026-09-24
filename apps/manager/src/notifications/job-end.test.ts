import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { JOB_KINDS, type JobKind } from "../db/schema";
import { type JobEnv, type JobHandler, runJob, type StepRunner } from "../jobs/run-job";
import type { JobUnitsApi } from "../jobs/units/units";
import { fakeStep } from "../test/fake-step";
import { addChannel, SECRET, SLACK_URL, services } from "../test/notification-fixtures";
import { seedInstall } from "../test/seed-install";
import { NOTIFY_STEP_NAME } from "./job-end";
import { createNotificationUnits } from "./units";

/**
 * The step every install, update and uninstall job ends with, driven through
 * `runJob` with stand-in handlers that settle the job row the way the real
 * ones do. The delivery unit runs in this process in place of `SELF`,
 * against a recording fake of the chat service.
 */

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await seedInstall();
});

function settles(status: "succeeded" | "failed", fail = false): JobHandler {
  return async ({ params }) => {
    await env.DB.prepare("UPDATE jobs SET status = ?2, finished_at = ?3 WHERE id = ?1")
      .bind(params.jobId, status, Date.now())
      .run();
    if (fail) throw new NonRetryableError("update step: boom");
  };
}

function handlersWith(kind: JobKind, handler: JobHandler): Record<JobKind, JobHandler> {
  const all = {} as Record<JobKind, JobHandler>;
  for (const k of JOB_KINDS) all[k] = k === kind ? handler : settles("succeeded");
  return all;
}

async function job(kind: JobKind, input: Record<string, unknown>): Promise<string> {
  const id = `job-${kind}`;
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status, input_json, started_at)
     VALUES (?1, 'i1', ?2, 'running', ?3, ?4)`,
  )
    .bind(id, kind, JSON.stringify(input), Date.now())
    .run();
  return id;
}

function withSelf(fetch = services().fetch): JobEnv {
  const units = createNotificationUnits({ DB: env.DB, BETTER_AUTH_SECRET: SECRET }, { fetch });
  return { DB: env.DB, SELF: units as unknown as JobUnitsApi };
}

async function logLines(jobId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT message FROM job_logs WHERE job_id = ?1 ORDER BY id",
  )
    .bind(jobId)
    .all<{ message: string }>();
  return results.map((r) => r.message);
}

describe("notifyJobEnd", () => {
  it("adds no step when there are no channels", async () => {
    const id = await job("update", { fromVersion: "1.0.0", version: "1.1.0" });
    const step = fakeStep();
    await runJob(
      { kind: "update", jobId: id },
      step,
      withSelf(),
      handlersWith("update", settles("succeeded")),
    );
    expect(step.names).toEqual([]);
  });

  it("tells the channels an update was applied, through the delivery unit, and logs it", async () => {
    await addChannel({
      label: "Team",
      events: ["update_applied"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const svc = services();
    const id = await job("update", { fromVersion: "1.0.0", version: "1.1.0" });
    const step = fakeStep();
    await runJob(
      { kind: "update", jobId: id },
      step,
      withSelf(svc.fetch),
      handlersWith("update", settles("succeeded")),
    );
    expect(step.names).toEqual([NOTIFY_STEP_NAME]);
    expect(svc.posted).toHaveLength(1);
    expect(JSON.parse(svc.posted[0]?.body ?? "").text).toContain(
      "now runs cut 1.1.0, updated from 1.0.0",
    );
    expect(await logLines(id)).toEqual(["Notified 1 of 1 channel."]);
  });

  it("still tells about a failed job, and the job's error still ends the run", async () => {
    await addChannel({
      label: "Team",
      events: ["update_failed"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const svc = services();
    const id = await job("update", { fromVersion: "1.0.0", version: "1.1.0" });
    await expect(
      runJob(
        { kind: "update", jobId: id },
        fakeStep(),
        withSelf(svc.fetch),
        handlersWith("update", settles("failed", true)),
      ),
    ).rejects.toThrow("update step: boom");
    expect(JSON.parse(svc.posted[0]?.body ?? "").text).toContain("Update failed: cut");
  });

  it("without SELF only queues, for the scheduled run to send", async () => {
    await addChannel({
      label: "Team",
      events: ["install_finished"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const id = await job("install", { slug: "cut", version: "1.0.0" });
    await runJob(
      { kind: "install", jobId: id },
      fakeStep(),
      { DB: env.DB },
      handlersWith("install", settles("succeeded")),
    );
    const pending = await env.DB.prepare(
      "SELECT count(*) AS n FROM notification_deliveries WHERE status = 'pending'",
    ).first<{ n: number }>();
    expect(pending?.n).toBe(1);
    expect(await logLines(id)).toEqual(["Queued 1 notification; the next scheduled run sends it."]);
  });

  it("never runs for a self-update, a rollback, or a deletion of kept data", async () => {
    await addChannel();
    for (const [kind, input] of [
      ["self_update", {}],
      ["rollback", {}],
      ["uninstall", { deleteRetained: true }],
    ] as const) {
      const id = await job(kind, input);
      const step = fakeStep();
      await runJob({ kind, jobId: id }, step, withSelf(), handlersWith(kind, settles("succeeded")));
      const events = await env.DB.prepare("SELECT count(*) AS n FROM notification_events").first<{
        n: number;
      }>();
      expect(events?.n).toBe(0);
      expect(step.names.length).toBeLessThanOrEqual(kind === "uninstall" ? 1 : 0);
    }
  });

  it("an early unwind records no step, so the real end is not answered from a cached result", async () => {
    await addChannel({
      label: "Team",
      events: ["update_applied"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const svc = services();
    const id = await job("update", { fromVersion: "1.0.0", version: "1.1.0" });
    // A step runner that keeps results across runs, as the engine does on replay.
    const cache = new Map<string, unknown>();
    const inner = fakeStep();
    const replaying: StepRunner = {
      async do<T>(name: string, a: unknown, b?: unknown): Promise<T> {
        if (cache.has(name)) return cache.get(name) as T;
        const result = await (inner.do as (n: string, x: unknown, y?: unknown) => Promise<T>)(
          name,
          a,
          b,
        );
        cache.set(name, result);
        return result;
      },
      sleep: (name, duration) => inner.sleep(name, duration),
    };
    // First run: the engine unwinds the run mid-job (as a suspension would).
    const unwinding: JobHandler = async () => {
      throw new Error("suspended");
    };
    await expect(
      runJob(
        { kind: "update", jobId: id },
        replaying,
        withSelf(svc.fetch),
        handlersWith("update", unwinding),
      ),
    ).rejects.toThrow("suspended");
    expect(inner.names).toEqual([]);
    // The replay finishes the job.
    await runJob(
      { kind: "update", jobId: id },
      replaying,
      withSelf(svc.fetch),
      handlersWith("update", settles("succeeded")),
    );
    // A third pass (a replay after the end) is answered from the cache.
    await runJob(
      { kind: "update", jobId: id },
      replaying,
      withSelf(svc.fetch),
      handlersWith("update", settles("succeeded")),
    );
    expect(inner.names).toEqual([NOTIFY_STEP_NAME]);
    expect(svc.posted).toHaveLength(1);
  });

  it("run twice without a cache, it still sends once per channel", async () => {
    await addChannel({
      label: "Team",
      events: ["update_applied"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const svc = services();
    const id = await job("update", { fromVersion: "1.0.0", version: "1.1.0" });
    for (let i = 0; i < 2; i++) {
      await runJob(
        { kind: "update", jobId: id },
        fakeStep(),
        withSelf(svc.fetch),
        handlersWith("update", settles("succeeded")),
      );
    }
    expect(svc.posted).toHaveLength(1);
  });

  it("a job whose handler never settled it (an invalid payload) makes no event", async () => {
    await addChannel();
    const id = await job("update", {});
    await expect(runJob({ kind: "update", jobId: id }, fakeStep(), withSelf())).rejects.toThrow(
      /invalid update job payload/,
    );
    const events = await env.DB.prepare("SELECT count(*) AS n FROM notification_events").first<{
      n: number;
    }>();
    expect(events?.n).toBe(0);
  });
});
