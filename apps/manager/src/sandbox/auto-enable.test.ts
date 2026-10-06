import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient, type FetchLike } from "@appflare/cf-api";
import { SANDBOX_PROTOCOL_VERSION } from "@appflare/schema";
import { inArray } from "drizzle-orm";
import { ulid } from "ulidx";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { jobs } from "../db/schema";
import { SETTING, writeSettings } from "../db/settings";
import type { StartInstallInput } from "../installs/install-input";
import {
  catalogOnlyManifest,
  StartInstallError,
  startInstallCore,
} from "../installs/start-install.server";
import type { InstallJobParams } from "../jobs/install";
import { reconcileJobs, STRANDED_ENABLE_MS } from "../jobs/reconcile.server";
import type { JobEnv } from "../jobs/run-job";
import { awaitSandboxEnabledPhase, SANDBOX_ENABLE_WAIT } from "../jobs/sandbox-enable-wait";
import { createJobSteps } from "../jobs/steps";
import { baseCatalog, buildArtifactFixture } from "../test/artifact-fixture";
import { ACC, type FakeAccount, SUBDOMAIN, TOKEN } from "../test/fake-account";
import { publishedCatalog, sandboxIndexApp } from "../test/fake-sandbox";
import {
  DANGLING_SANDBOX,
  fakeSandboxAccount,
  MANAGER,
  MANAGER_SERVING,
  type SandboxAccountState,
  sandboxRelease,
} from "../test/fake-sandbox-account";
import { fakeStep } from "../test/fake-step";
import { seedInstall } from "../test/seed-install";
import { readSandboxConnection } from "./connection.server";
import type { SandboxEnableJobParams } from "./enable-job";
import { SANDBOX_CAPABILITY_HREF } from "./readiness";
import { sandboxReleaseProblem } from "./release";

/**
 * Sandbox builds turned on at first need: an install of a sandbox tier app
 * started while they are off claims a `sandbox_enable` job (after live
 * probes of the account against a stateful fake), or refuses naming what is
 * missing; the install job then waits for that job.
 */

const VERSION = "0.1.3";
const MANAGER_VERSION = "0.5.0";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: MANAGER,
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
});

/** A `SANDBOX` binding to the sandbox Worker, answering. */
const answering = {
  info: async () => ({
    protocol: SANDBOX_PROTOCOL_VERSION,
    sandboxVersion: VERSION,
    image: `appflare/sandbox:${VERSION}`,
  }),
};
/** One to a sandbox Worker that was deleted: there, but every call fails. */
const deleted = {
  info: async () => {
    throw new Error("Network connection lost.");
  },
};

/** Answers Containers as a free account does: refused, naming Workers Paid. */
function freePlan(inner: FetchLike): FetchLike {
  return async (input, init) => {
    if (new URL(input).pathname.includes("/containers/")) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "Containers requires Workers Paid plan" }],
          messages: [],
        },
        { status: 401 },
      );
    }
    return inner(input, init);
  };
}

async function start(
  opts: {
    account?: Partial<SandboxAccountState>;
    /** The release GitHub has; defaults to the pinned one. */
    releaseVersion?: string;
    wrapFetch?: (f: FetchLike) => FetchLike;
    input?: Partial<StartInstallInput>;
    /** Workers Paid as an admin set it (the fake detects no plan). */
    paid?: boolean;
    /** Runs while the start checks the release, as another request could. */
    duringPlan?: () => Promise<void>;
    /**
     * The manager's `SANDBOX` binding, read as the install start reads it;
     * without it, sandbox builds are off.
     */
    sandbox?: unknown;
    /** Appflare's own Worker (its serving version's bindings). */
    manager?: Partial<FakeAccount>;
  } = {},
) {
  if (opts.paid === true) {
    await writeSettings(createDb(env.DB), { [SETTING.accountPlan]: "paid" });
  }
  const release = await sandboxRelease(opts.releaseVersion ?? VERSION);
  const world = fakeSandboxAccount(release, opts.account ?? {}, opts.manager ?? {});
  const fetch = opts.wrapFetch?.(world.fetch) ?? world.fetch;
  const client = async () => createClient({ accountId: ACC, token: TOKEN, fetch });
  const fixture = await buildArtifactFixture({
    keyId: "unsigned",
    catalog: { install: { ...baseCatalog().install, tier: "sandbox" } },
  });
  const catalog = fixture.manifest.catalog;
  const app = await sandboxIndexApp(fixture, {
    manifestDigest: (await publishedCatalog(catalog)).digest,
  });
  const created: Array<{ id: string; params: unknown }> = [];
  let n = 0;
  const run = () =>
    startInstallCore(
      {
        db: env.DB,
        loadApp: async () => ({ app, manifest: catalogOnlyManifest(catalog) }),
        sandboxConnected: async () =>
          opts.sandbox !== undefined &&
          (await readSandboxConnection({ DB: env.DB, SANDBOX: opts.sandbox }, client)).connected,
        sandboxAutoEnable: {
          client,
          releaseProblem: async (version) => {
            // After the start decided to turn sandbox builds on, before its batch.
            await opts.duringPlan?.();
            return sandboxReleaseProblem(fetch, {}, version, { viaApi: false });
          },
          createJob: async (id, params) => {
            created.push({ id, params });
            return { id };
          },
          currentVersion: MANAGER_VERSION,
          sandboxVersion: VERSION,
        },
        createJob: async (id, params) => {
          created.push({ id, params });
          return { id };
        },
        newId: () => `id${++n}`,
      },
      {
        slug: "cut",
        workerName: "cut",
        secrets: { ADMIN_PASSWORD: "pw" },
        vars: {},
        paidConfirmed: true,
        requirementsConfirmed: true,
        buildConfirmed: true,
        ...opts.input,
      },
    );
  return { world, created, run };
}

async function jobRows() {
  return (
    await env.DB.prepare("SELECT id, kind, status, input_json FROM jobs ORDER BY id").all<{
      id: string;
      kind: string;
      status: string;
      input_json: string;
    }>()
  ).results;
}

describe("an install that needs sandbox builds while they are off", () => {
  it("claims a sandbox_enable job, creates it first, and has the install job wait for it", async () => {
    const s = await start();
    const ids = await s.run();
    expect(ids).toEqual({ installId: "id1", jobId: "id2" });

    const rows = await jobRows();
    expect(rows.map((r) => [r.id, r.kind, r.status])).toEqual([
      ["id2", "install", "queued"],
      ["id3", "sandbox_enable", "queued"],
    ]);
    expect(JSON.parse(rows[1]?.input_json ?? "")).toEqual({
      version: VERSION,
      fromVersion: null,
      neededBy: { jobId: "id2", kind: "install" },
    });
    expect(JSON.parse(rows[0]?.input_json ?? "")).toMatchObject({ sandboxEnableJob: "id3" });

    // The enable job's Workflow first, then the install's.
    expect(s.created.map((c) => c.id)).toEqual(["id3", "id2"]);
    expect(s.created[0]?.params).toEqual({
      kind: "sandbox_enable",
      jobId: "id3",
      version: VERSION,
      managerVersion: MANAGER_VERSION,
      neededBy: { jobId: "id2", kind: "install" },
    } satisfies SandboxEnableJobParams);
    expect(s.created[1]?.params).toMatchObject({
      kind: "install",
      sandboxEnableJob: "id3",
    } satisfies Partial<InstallJobParams>);
    // Two reads of the account, nothing changed.
    expect(s.world.state.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("turns them on first when Appflare is still bound to a sandbox Worker that was deleted", async () => {
    const s = await start({
      sandbox: deleted,
      manager: { versionBindings: { [MANAGER_SERVING]: [DANGLING_SANDBOX] } },
    });
    await s.run();
    expect((await jobRows()).map((r) => [r.id, r.kind])).toEqual([
      ["id2", "install"],
      ["id3", "sandbox_enable"],
    ]);
    expect(s.created[1]?.params).toMatchObject({ kind: "install", sandboxEnableJob: "id3" });
  });

  it("takes a binding that answers as connected, without asking Cloudflare", async () => {
    const s = await start({ sandbox: answering });
    await s.run();
    expect((await jobRows()).map((r) => r.kind)).toEqual(["install"]);
    expect(s.created[0]?.params).not.toHaveProperty("sandboxEnableJob");
    expect(s.world.state.calls).toEqual([]);
    expect(s.world.manager.state.calls).toEqual([]);
  });

  it("takes a binding to the sandbox Worker that does not answer as connected", async () => {
    // What uses it reports the failure; turning sandbox builds on would not help.
    const s = await start({
      sandbox: deleted,
      manager: {
        versionBindings: {
          [MANAGER_SERVING]: [
            {
              type: "service",
              name: "SANDBOX",
              service: "appflare-sandbox",
              entrypoint: "SandboxBuilds",
            },
          ],
        },
      },
    });
    await s.run();
    expect((await jobRows()).map((r) => r.kind)).toEqual(["install"]);
  });

  it("waits for an enable job already queued or running instead of starting another", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('en1', NULL, 'sandbox_enable', 'running', '{}')",
    ).run();
    const s = await start();
    await s.run();
    expect((await jobRows()).map((r) => [r.id, r.kind])).toEqual([
      ["en1", "sandbox_enable"],
      ["id2", "install"],
    ]);
    expect(s.created.map((c) => c.id)).toEqual(["id2"]);
    expect(s.created[0]?.params).toMatchObject({ kind: "install", sandboxEnableJob: "en1" });
    // Nothing probed: the running job checks the account itself.
    expect(s.world.state.calls).toEqual([]);
  });

  it.each([
    [
      "R2 is not enabled",
      { account: { r2Enabled: false } },
      /cannot turn them on: R2 is not enabled on this account/,
    ],
    [
      "the token lacks Containers: Edit",
      { account: { containersAllowed: false }, paid: true },
      /cannot turn them on: Appflare's API token lacks Containers: Edit/,
    ],
    [
      "the account is on Workers Free",
      { wrapFetch: freePlan },
      /cannot turn them on: Sandbox builds need Workers Paid/,
    ],
    [
      "the sandbox Worker release is not on GitHub",
      { releaseVersion: "0.1.2" },
      /cannot turn them on: GitHub has no sandbox Worker release sandbox@0\.1\.3\./,
    ],
  ])(
    "refuses when %s, naming it and linking its row on Your account",
    async (_what, opts, message) => {
      const s = await start(opts);
      const refusal = s.run();
      await expect(refusal).rejects.toThrow(StartInstallError);
      await expect(refusal).rejects.toThrow(message);
      await expect(s.run()).rejects.toThrow(SANDBOX_CAPABILITY_HREF);
      expect(await jobRows()).toEqual([]);
      expect(await env.DB.prepare("SELECT id FROM installs").all()).toMatchObject({ results: [] });
      expect(s.created).toEqual([]);
    },
  );

  it("refuses while another job runs, leaving nothing behind", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('busy', NULL, 'update', 'running', '{}')",
    ).run();
    const s = await start();
    await expect(s.run()).rejects.toThrow(
      /Appflare turns them on first only while no other job is queued or running/,
    );
    expect((await jobRows()).map((r) => r.id)).toEqual(["busy"]);
    expect(await env.DB.prepare("SELECT id FROM installs").all()).toMatchObject({ results: [] });
    expect(s.created).toEqual([]);
  });

  it("leaves no enable job behind when the install itself is refused", async () => {
    await seedInstall();
    const s = await start();
    await expect(s.run()).rejects.toThrow(/Another install already uses the Worker name "cut"/);
    expect(await jobRows()).toEqual([]);
    expect(s.created).toEqual([]);
    // Nothing blocks the next start.
    await env.DB.prepare("UPDATE installs SET status = 'uninstalled'").run();
    await expect(s.run()).resolves.toMatchObject({ jobId: expect.any(String) });
  });

  it("waits for the enable job of a start that claimed first, instead of refusing", async () => {
    const s = await start({
      duringPlan: async () => {
        // Another start turns sandbox builds on between this one's checks and its batch.
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('other', NULL, 'source_build', 'queued', '{}')",
          ),
          env.DB.prepare(
            "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('en2', NULL, 'sandbox_enable', 'queued', '{}')",
          ),
        ]);
      },
    });
    await s.run();
    expect((await jobRows()).map((r) => [r.id, r.kind])).toEqual([
      ["en2", "sandbox_enable"],
      ["id2", "install"],
      ["other", "source_build"],
    ]);
    expect(s.created.map((c) => c.id)).toEqual(["id2"]);
    expect(s.created[0]?.params).toMatchObject({ sandboxEnableJob: "en2" });
  });

  it("refuses while sandbox builds are being disabled", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('dis', NULL, 'sandbox_disable', 'running', '{}')",
    ).run();
    const s = await start();
    await expect(s.run()).rejects.toThrow(/being updated or disabled now/);
  });

  it("records the install job as failed when the enable job cannot be created", async () => {
    const s = await start();
    let calls = 0;
    const failing = startInstallCore(
      {
        db: env.DB,
        loadApp: async () => {
          const fixture = await buildArtifactFixture({
            keyId: "unsigned",
            catalog: { install: { ...baseCatalog().install, tier: "sandbox" } },
          });
          const catalog = fixture.manifest.catalog;
          return {
            app: await sandboxIndexApp(fixture, {
              manifestDigest: (await publishedCatalog(catalog)).digest,
            }),
            manifest: catalogOnlyManifest(catalog),
          };
        },
        sandboxConnected: async () => false,
        sandboxAutoEnable: {
          client: async () => createClient({ accountId: ACC, token: TOKEN, fetch: s.world.fetch }),
          releaseProblem: async () => null,
          createJob: async () => {
            throw new Error("Workflows is down");
          },
          currentVersion: MANAGER_VERSION,
          sandboxVersion: VERSION,
        },
        createJob: async (id) => {
          calls += 1;
          return { id };
        },
        newId: (() => {
          let n = 0;
          return () => `f${++n}`;
        })(),
      },
      {
        slug: "cut",
        workerName: "cut",
        secrets: { ADMIN_PASSWORD: "pw" },
        vars: {},
        paidConfirmed: true,
        requirementsConfirmed: true,
        buildConfirmed: true,
      },
    );
    await expect(failing).rejects.toThrow(/Could not turn sandbox builds on: .*Workflows is down/);
    expect(calls).toBe(0);
    expect((await jobRows()).map((r) => [r.id, r.status])).toEqual([
      ["f2", "failed"],
      ["f3", "failed"],
    ]);
  });
});

describe("waiting for sandbox builds to be turned on", () => {
  async function seedEnable(status: string, error: string | null = null) {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json, error) VALUES ('en1', NULL, 'sandbox_enable', ?1, '{}', ?2)",
    )
      .bind(status, error)
      .run();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('job1', NULL, 'source_build', 'running', '{}')",
    ).run();
  }

  async function enableLog(level: string, message: string) {
    await env.DB.prepare(
      "INSERT INTO job_logs (job_id, ts, level, message) VALUES ('en1', 1, ?1, ?2)",
    )
      .bind(level, message)
      .run();
  }

  async function wait(
    jobEnv: JobEnv,
    onSleep?: (name: string, duration: string | number) => Promise<void>,
  ) {
    const pending: Array<Promise<void>> = [];
    const step = fakeStep(
      onSleep === undefined
        ? {}
        : { onSleep: (name, duration) => void pending.push(onSleep(name, duration)) },
    );
    // The fake's `sleep` does not await `onSleep`; finish its writes before the next poll.
    const sleeping = step.sleep.bind(step);
    step.sleep = async (name, duration) => {
      await sleeping(name, duration);
      await Promise.all(pending.splice(0));
    };
    const steps = createJobSteps(
      { params: { kind: "source_build", jobId: "job1" }, step, env: jobEnv, deps: {} },
      "job1",
    );
    let error: unknown = null;
    try {
      await awaitSandboxEnabledPhase(steps, step, jobEnv, "en1");
    } catch (e) {
      error = e;
    }
    const logs = (
      await env.DB.prepare(
        "SELECT level, message FROM job_logs WHERE job_id = 'job1' ORDER BY id",
      ).all<{ level: string; message: string }>()
    ).results;
    return { step, error, logs };
  }

  it("polls until the enable job succeeded, copying its progress into this job's log", async () => {
    await seedEnable("queued");
    let sleeps = 0;
    const r = await wait({ DB: env.DB, SANDBOX: answering }, async () => {
      sleeps += 1;
      if (sleeps === 1) {
        await env.DB.prepare("UPDATE jobs SET status = 'running' WHERE id = 'en1'").run();
        await enableLog("info", "Enabling sandbox builds with the sandbox Worker 0.1.3.");
        await enableLog("debug", "GET /workers/scripts -> 200");
      } else {
        await enableLog("info", "Sandbox builds are on.");
        await env.DB.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = 'en1'").run();
      }
    });
    expect(r.error).toBeNull();
    expect(r.step.names.filter((n) => n.startsWith("wait for sandbox builds"))).toEqual([
      "wait for sandbox builds (1)",
      "wait for sandbox builds (2)",
      "wait for sandbox builds (3)",
    ]);
    expect(r.step.sleepDurations).toEqual([
      `${SANDBOX_ENABLE_WAIT.pollSeconds} seconds`,
      `${SANDBOX_ENABLE_WAIT.pollSeconds} seconds`,
    ]);
    expect(r.logs.map((l) => l.message)).toEqual([
      "Sandbox builds are off, so the job en1 turns them on first (about two minutes). Its progress follows.",
      "Sandbox builds: Enabling sandbox builds with the sandbox Worker 0.1.3.",
      "Sandbox builds: Sandbox builds are on.",
      "Sandbox builds are on; continuing.",
    ]);
  });

  it("fails with the enable job's reason when it failed", async () => {
    await seedEnable("failed", "check account: R2 is not enabled on this account.\nmore");
    const r = await wait({ DB: env.DB, SANDBOX: answering });
    expect(String(r.error)).toMatch(
      /sandbox builds could not be turned on \(job en1\): check account: R2 is not enabled on this account\.; nothing of this job was started/,
    );
  });

  it("sleeps until the instance runs on the connected version, and gives up after a few minutes", async () => {
    await seedEnable("succeeded");
    const unbound = await wait({ DB: env.DB });
    expect(unbound.step.sleepDurations).toEqual(
      Array(SANDBOX_ENABLE_WAIT.bindingPolls).fill("1 minute"),
    );
    expect(String(unbound.error)).toMatch(/start it again/);

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await seedEnable("succeeded");
    const jobEnv: JobEnv = { DB: env.DB };
    // The binding shows up once the instance resumed after its first sleep.
    const bound = await wait(jobEnv, async () => {
      jobEnv.SANDBOX = answering;
    });
    expect(bound.error).toBeNull();
    expect(bound.step.sleepDurations).toEqual(["1 minute"]);
  });

  it("does not take a binding to a deleted sandbox Worker for the connected version", async () => {
    await seedEnable("succeeded");
    const jobEnv: JobEnv = { DB: env.DB, SANDBOX: deleted };
    const stale = await wait(jobEnv);
    expect(stale.step.sleepDurations).toEqual(
      Array(SANDBOX_ENABLE_WAIT.bindingPolls).fill("1 minute"),
    );
    expect(String(stale.error)).toMatch(/start it again/);

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await seedEnable("succeeded");
    // The connected version's binding answers once the instance resumed on it.
    const resumed = await wait(jobEnv, async () => {
      jobEnv.SANDBOX = answering;
    });
    expect(resumed.error).toBeNull();
    expect(resumed.step.sleepDurations).toEqual(["1 minute"]);
  });
});

describe("an enable job whose start never created its instance", () => {
  const NOT_FOUND = {
    get: async () => {
      throw new Error("instance.not_found");
    },
  };

  async function queuedEnable(id: string, instance: string | null = null) {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status, input_json, workflow_instance_id) VALUES (?1, NULL, 'sandbox_enable', 'queued', '{}', ?2)",
    )
      .bind(id, instance)
      .run();
  }

  it("is removed after five minutes, so it no longer blocks every start", async () => {
    const at = Date.now();
    const old = ulid(at - STRANDED_ENABLE_MS - 1000);
    const fresh = ulid(at - 60_000);
    const created = ulid(at - STRANDED_ENABLE_MS - 2000);
    await queuedEnable(old);
    await queuedEnable(fresh);
    await queuedEnable(created, created);
    const rows = await createDb(env.DB)
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]));
    expect(await reconcileJobs(env.DB, NOT_FOUND, rows, () => new Date(at))).toBe(true);
    const left = (
      await env.DB.prepare("SELECT id, status FROM jobs ORDER BY id").all<{
        id: string;
        status: string;
      }>()
    ).results;
    // The fresh one may still get its instance; one with an instance is failed as before.
    expect(left).toEqual([
      { id: created, status: "failed" },
      { id: fresh, status: "queued" },
    ]);
  });
});
