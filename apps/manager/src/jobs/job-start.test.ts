import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { TOKEN } from "../test/fake-account";
import { fakeStep } from "../test/fake-step";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { type JobContext, type JobParams, runJob } from "./run-job";
import { createJobSteps, JOB_ALREADY_ENDED_LINE } from "./steps";

const JOB = "job1";
const DIGEST = "a".repeat(64);
const ASSETS = {
  zip: "https://releases.test/app.zip",
  manifest: "https://releases.test/manifest.json",
  sig: "https://releases.test/manifest.sig",
};

/** One payload per job kind, as each kind's handler parses it. */
const PAYLOADS: Record<string, JobParams> = {
  install: {
    kind: "install",
    jobId: JOB,
    installId: INSTALL_ID,
    slug: "cut",
    version: "1.0.0",
    workerName: "cut",
    artifacts: { ...ASSETS, digest: DIGEST },
    digest: DIGEST,
    secrets: {},
    vars: {},
    paidConfirmed: false,
  },
  update: { kind: "update", jobId: JOB, installId: INSTALL_ID, version: "1.1.0" },
  uninstall: { kind: "uninstall", jobId: JOB, installId: INSTALL_ID, deleteResources: [] },
  sandbox_enable: { kind: "sandbox_enable", jobId: JOB, version: "0.1.0", managerVersion: "1.0.0" },
  sandbox_disable: { kind: "sandbox_disable", jobId: JOB, managerVersion: "1.0.0" },
  self_update: {
    kind: "self_update",
    jobId: JOB,
    version: "1.1.0",
    fromVersion: "1.0.0",
    tag: "manager@1.1.0",
    artifacts: ASSETS,
  },
};

/** The install row each kind finds while its job is under way. */
const INSTALL_STATUS: Record<string, string | null> = {
  install: "installing",
  update: "updating",
  uninstall: "uninstalling",
  sandbox_enable: null,
  sandbox_disable: null,
  self_update: null,
};

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

async function seedJob(kind: string, status: string): Promise<void> {
  const install = INSTALL_STATUS[kind] ?? null;
  if (install !== null) await seedInstall({ status: install });
  await env.DB.prepare(
    `INSERT INTO jobs (id, install_id, kind, status, error, started_at, finished_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      JOB,
      install === null ? null : INSTALL_ID,
      kind,
      status,
      status === "failed" ? "gone" : null,
      status === "running" ? 1 : null,
      status === "failed" ? 5 : null,
    )
    .run();
}

/** Every row of every table but the job log, to compare before and after. */
async function everyRow(): Promise<Record<string, unknown[]>> {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'job_logs'
     ORDER BY name`,
  ).all<{ name: string }>();
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables.results) {
    rows[name] = (await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results;
  }
  return rows;
}

async function logLines(): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = ?1 ORDER BY id")
    .bind(JOB)
    .all<{ message: string }>();
  return rows.results.map((r) => r.message);
}

/** Runs the job as the Workflow does; any request to the network fails the test. */
async function run(payload: JobParams) {
  const step = fakeStep();
  const fetched: string[] = [];
  let error: unknown = null;
  try {
    await runJob(
      payload,
      step,
      { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, APPFLARE_VERSION: "1.0.0" },
      undefined,
      {
        fetch: async (input) => {
          fetched.push(String(input));
          throw new Error("no request is expected");
        },
      },
    );
  } catch (e) {
    error = e;
  }
  return { step, fetched, error };
}

describe("a job that had already ended before its instance started", () => {
  for (const kind of Object.keys(PAYLOADS)) {
    it(`${kind}: stays failed, and nothing else is written`, async () => {
      await seedJob(kind, "failed");
      const before = await everyRow();
      const payload = PAYLOADS[kind];
      if (payload === undefined) throw new Error(`no payload for ${kind}`);
      const { step, fetched, error } = await run(payload);
      expect(error).toBeNull();
      expect(step.names).toEqual(["start"]);
      expect(fetched).toEqual([]);
      expect(await everyRow()).toEqual(before);
      expect(await logLines()).toEqual([JOB_ALREADY_ENDED_LINE]);
    });
  }
});

describe("a job whose row is gone before its instance started", () => {
  it("stops at its start without a log line, and writes nothing", async () => {
    // Reconcile deletes the row of a sandbox enable it found stranded.
    const before = await everyRow();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { step, fetched, error } = await run(PAYLOADS.sandbox_enable as JobParams);
    // A log line would have no job to belong to, and its write would fail.
    expect(logged).not.toHaveBeenCalled();
    logged.mockRestore();
    expect(error).toBeNull();
    expect(step.names).toEqual(["start"]);
    expect(step.retried).toEqual({});
    expect(fetched).toEqual([]);
    expect(await everyRow()).toEqual(before);
    expect(await logLines()).toEqual([]);
  });
});

describe("a job whose start step runs again", () => {
  it("carries on when its own earlier try marked it running", async () => {
    await seedJob("install", "queued");
    const ctx: JobContext = {
      params: { kind: "install", jobId: JOB },
      step: fakeStep(),
      env: { DB: env.DB },
      deps: {},
    };
    let tries = 0;
    const started = await createJobSteps(ctx, JOB).start(async ({ log }) => {
      tries += 1;
      // The engine retries a step that failed this way.
      if (tries === 1) throw new Error("D1_ERROR: database unavailable");
      log.info("Started.");
      return { tries };
    });
    expect(started).toEqual({ tries: 2 });
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1")
      .bind(JOB)
      .first<{ status: string }>("status");
    expect(job).toBe("running");
    expect(await logLines()).toContain("Started.");
  });

  it("goes on past its start when it was marked running already", async () => {
    await seedJob("update", "running");
    const { step } = await run(PAYLOADS.update as JobParams);
    // Past the guard, the update's own start reads the install, and then
    // its catalog listing, which this test's empty catalog cache lacks.
    expect(step.names[0]).toBe("start");
    const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = ?1")
      .bind(JOB)
      .first<{ status: string; error: string }>();
    expect(job).toEqual({ status: "failed", error: "start: the app is no longer in the catalog" });
    expect(await logLines()).not.toContain(JOB_ALREADY_ENDED_LINE);
  });
});
