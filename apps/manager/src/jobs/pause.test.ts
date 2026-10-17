import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createClient } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { writeAccountPlan } from "../account/plan.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { ACC, TOKEN } from "../test/fake-account";
import { type FakeEngine, fakeEngine } from "../test/fake-invocations";
import { fakeStep } from "../test/fake-step";
import { addChannel, SLACK_URL } from "../test/notification-fixtures";
import { periodEnd } from "../usage/math";
import { type PauseRequest, startPause, startResume } from "../usage/pause.server";
import { listActivity } from "../usage/store/activity.server";
import { readAppSpendSettings, writeAppSpendSettings } from "../usage/store/app-settings.server";
import { findOpenPause, listPauses } from "../usage/store/pauses.server";
import { runPause } from "./pause";
import { activeInstancesOf } from "./pause/cloudflare";
import {
  type FakeScript,
  fakePauseAccount,
  fakeScript,
  type InstanceStatus,
  type PauseWorld,
  servingOf,
} from "./pause/fake-pause-account";
import type { PauseJobParams, ResumeJobParams } from "./pause/params";
import { resumeKeptQueuesPhase } from "./pause/phases";
import { runResume } from "./resume";
import type { JobParams, StepConfig, StepContext, StepRunner } from "./run-job";
import { createJobSteps } from "./steps";

/**
 * End-to-end tests of the pause and resume jobs against a stateful fake of
 * the Cloudflare API and the local D1: what a pause changes, what it
 * records, how Resume puts exactly that back, and how a pause that fails or
 * is interrupted leaves nothing in the way of the next one.
 */

const NOW = Date.UTC(2026, 9, 14, 10, 30);
const REAL = "11111111-1111-4111-8111-111111111111";
const REAL_API = "22222222-2222-4222-8222-222222222222";

/** The jobs' clock: a second later at every read, so what they record is in order. */
let clock = NOW;
const tick = () => {
  clock += 1_000;
  return clock;
};

beforeEach(async () => {
  clock = NOW;
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
});

/** Install `i1` (Worker `cut`), with its Workers, queue and Workflow recorded. */
async function seedApp(opts: { workers?: string[]; queues?: boolean; workflow?: boolean } = {}) {
  const r = (id: string, kind: string, name: string, cfId: string | null) =>
    env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES (?1, 'i1', ?2, NULL, ?3, ?4, 1)`,
    ).bind(id, kind, name, cfId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('i1', 'cut', 'cut', 'cut', '1.0.0', 'u', 'installed', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('j0', 'i1', 'install', 'succeeded', '{}')`,
    ),
    ...(opts.workers ?? ["cut"]).map((w) => r(`w-${w}`, "worker", w, w)),
    ...(opts.queues === false ? [] : [r("q", "queue", "cut-events", "q-1")]),
    ...(opts.workflow === false ? [] : [r("wf", "workflow", "cut-jobs", null)]),
  ]);
}

/** A Worker with a Durable Object class, a named entrypoint and a Workflow class. */
function cutWorker(): FakeScript {
  return fakeScript(REAL, {
    handlers: ["fetch", "queue"],
    named: [
      { name: "Counter", handlers: ["class"] },
      { name: "Admin", handlers: ["fetch", "stats"] },
      { name: "Jobs", handlers: ["__workflow_entrypoint", "run"] },
    ],
    bindings: [
      { type: "durable_object_namespace", name: "COUNTER", class_name: "Counter" },
      { type: "queue", name: "EVENTS", queue_name: "cut-events" },
      { type: "workflow", name: "JOBS", workflow_name: "cut-jobs", class_name: "Jobs" },
      { type: "secret_text", name: "ADMIN_PASSWORD" },
      { type: "plain_text", name: "HOME_PAGE", text: "admin" },
      { type: "assets", name: "ASSETS" },
    ],
    runtime: { compatibility_date: "2025-04-01", compatibility_flags: ["nodejs_compat"] },
  });
}

function world(over: Partial<PauseWorld> = {}) {
  return fakePauseAccount({
    scripts: new Map([["cut", cutWorker()]]),
    namespaces: [{ id: "ns-counter", script: "cut", class: "Counter" }],
    queues: new Map([["q-1", { name: "cut-events", paused: false }]]),
    workflows: new Map([
      [
        "cut-jobs",
        new Map([
          ["run-1", "running"],
          ["run-2", "waiting"],
          ["done-1", "complete"],
        ]),
      ],
    ]),
    ...over,
  });
}

/** A Workflow binding that hands the params to the test instead of starting an instance. */
function capturingJobs() {
  const created: JobParams[] = [];
  return {
    created,
    JOBS: {
      create: async ({ id, params }: { id: string; params: JobParams }) => {
        created.push(params);
        return { id };
      },
    },
  };
}

type Fake = ReturnType<typeof fakePauseAccount>;

/** A Cloudflare client on the fake account. */
function apiOf(fake: Fake) {
  return createClient({ accountId: ACC, token: TOKEN, fetch: fake.fetch });
}

interface RunOptions {
  step?: StepRunner;
  engine?: FakeEngine;
}

async function runJob(
  run: typeof runPause,
  params: JobParams,
  fake: Fake,
  opts: RunOptions = {},
): Promise<unknown> {
  const jobEnv = { DB: env.DB, CF_API_TOKEN: TOKEN };
  try {
    if (opts.engine !== undefined) {
      const engine = opts.engine;
      await engine.run(() =>
        run({
          params,
          step: engine.step,
          env: jobEnv,
          deps: { fetch: engine.fetch(fake.fetch), now: tick },
        }),
      );
    } else {
      await run({
        params,
        step: opts.step ?? fakeStep(),
        env: jobEnv,
        deps: { fetch: fake.fetch, now: tick },
      });
    }
    return null;
  } catch (error) {
    return error;
  }
}

async function pause(
  fake: Fake,
  request: Partial<PauseRequest> = {},
  opts: RunOptions = {},
): Promise<{ jobId: string; error: unknown; params: PauseJobParams }> {
  const jobs = capturingJobs();
  const { jobId } = await startPause(
    { DB: env.DB, JOBS: jobs.JOBS },
    { installId: "i1", reason: "manual", by: "u-ada", ...request } as PauseRequest,
    { now: () => new Date(NOW) },
  );
  const params = jobs.created[0] as PauseJobParams;
  return { jobId, params, error: await runJob(runPause, params, fake, opts) };
}

async function resume(
  fake: Fake,
  request: { by?: string; untilCapResets?: boolean } = {},
  opts: RunOptions = {},
): Promise<{ jobId: string; error: unknown }> {
  const jobs = capturingJobs();
  const { jobId } = await startResume(
    { DB: env.DB, JOBS: jobs.JOBS },
    { installId: "i1", by: request.by ?? "u-ada", untilCapResets: request.untilCapResets },
    { now: () => new Date(NOW) },
  );
  const params = jobs.created[0] as ResumeJobParams;
  return { jobId, error: await runJob(runResume, params, fake, opts) };
}

async function job(id: string) {
  return env.DB.prepare("SELECT kind, status, error, started_by FROM jobs WHERE id = ?1")
    .bind(id)
    .first<{ kind: string; status: string; error: string | null; started_by: string }>();
}

async function logs(id: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT message FROM job_logs WHERE job_id = ?1 ORDER BY id",
  )
    .bind(id)
    .all<{ message: string }>();
  return results.map((r) => r.message);
}

async function activityKinds(): Promise<string[]> {
  return (await listActivity(createDb(env.DB), { installId: "i1" })).map((a) => a.kind).reverse();
}

describe("pause job", () => {
  it("serves a stand-in, pauses the queue and the running Workflow instances, and records it all", async () => {
    await seedApp();
    const fake = world();
    const { jobId, error } = await pause(fake);
    expect(error).toBeNull();
    expect(await job(jobId)).toMatchObject({
      kind: "pause",
      status: "succeeded",
      started_by: "admin",
    });

    // The stand-in: uploaded with every binding type kept but static assets, no migrations.
    expect(fake.world.uploads).toHaveLength(1);
    const [upload] = fake.world.uploads;
    expect(upload?.metadata).toMatchObject({
      main_module: "appflare-paused.mjs",
      bindings: [],
      keep_bindings: ["durable_object_namespace", "plain_text", "queue", "secret_text", "workflow"],
      observability: { enabled: true, head_sampling_rate: 1 },
      annotations: { "workers/tag": "appflare-paused" },
    });
    expect(upload?.metadata).not.toHaveProperty("migrations");
    expect(upload?.source).toContain("export class Counter extends __appflarePausedObject {}");
    expect(upload?.source).toContain("export class Admin extends __appflareWorkerEntrypoint {");
    expect(upload?.source).toContain('async "stats"() {');
    expect(upload?.source).toContain("export class Jobs extends __appflareWorkflowEntrypoint {");
    // Deployed at 100%, forced.
    expect(fake.world.deploys).toEqual([
      { script: "cut", versionId: "standin-cut-1", force: true },
    ]);
    expect(servingOf(fake.world, "cut")).toBe("standin-cut-1");
    // The queue waits; the running Workflow instances wait; the finished one is untouched.
    expect(fake.world.queues.get("q-1")?.paused).toBe(true);
    expect(Object.fromEntries(fake.world.workflows.get("cut-jobs") ?? [])).toEqual({
      "run-1": "paused",
      "run-2": "paused",
      "done-1": "complete",
    });
    // The queue's delivery and the Workflow instances stop before the Worker
    // switches to its stand-in: an instance started on it would fail for good.
    const queuePatch = fake.world.calls.indexOf("PATCH /queues/q-1");
    const instancePause = fake.world.calls.indexOf(
      "PATCH /workflows/cut-jobs/instances/run-1/status",
    );
    const deploy = fake.world.calls.indexOf("POST /workers/scripts/cut/deployments");
    expect(queuePatch).toBeGreaterThan(-1);
    expect(queuePatch).toBeLessThan(deploy);
    expect(instancePause).toBeGreaterThan(-1);
    expect(instancePause).toBeLessThan(deploy);
    // The app's compatibility settings, so a binding that needs a flag validates.
    expect(upload?.metadata).toMatchObject({
      compatibility_date: "2025-04-01",
      compatibility_flags: ["nodejs_compat"],
    });

    const pauseRow = await findOpenPause(createDb(env.DB), "i1");
    expect(pauseRow).toMatchObject({
      pausedBy: "u-ada",
      reason: "manual",
      detailJson: null,
      workerVersions: { cut: REAL },
      containersJson: null,
      queuesJson: JSON.stringify([{ id: "q-1", name: "cut-events" }]),
      workflowsJson: JSON.stringify({ "cut-jobs": ["run-1", "run-2"] }),
      jobId,
      resumeJobId: null,
    });
    expect(await activityKinds()).toEqual(["paused"]);
    expect(await logs(jobId)).toContain(
      'Worker "cut" serves its stand-in: requests get the paused page.',
    );
  });

  it("tells notification channels once, and nothing more at the job's end", async () => {
    await seedApp();
    await addChannel({
      label: "Team",
      events: ["app_paused", "app_resumed"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const fake = world();
    await pause(fake, {
      reason: "cap",
      by: null,
      detail: { amount: 5, period: "day", spent: 5.4 },
    } as PauseRequest);
    const pauseRow = await findOpenPause(createDb(env.DB), "i1");
    expect(pauseRow).toMatchObject({
      pausedBy: "auto",
      reason: "cap",
      detailJson: JSON.stringify({ amount: 5, period: "day", spent: 5.4 }),
    });
    const { results } = await env.DB.prepare(
      "SELECT type, dedupe_key, facts_json FROM notification_events",
    ).all<{ type: string; dedupe_key: string; facts_json: string }>();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "app_paused",
      dedupe_key: `app_paused:${pauseRow?.id}`,
    });
    expect(JSON.parse(results[0]?.facts_json ?? "{}")).toMatchObject({
      by: null,
      cause: { reason: "cap", amount: 5, period: "day", spent: 5.4 },
    });
  });

  it("pauses every Worker of an app of several, and Resume brings each version back", async () => {
    await seedApp({ workers: ["cut", "cut-api"] });
    const fake = world({
      scripts: new Map([
        ["cut", cutWorker()],
        ["cut-api", fakeScript(REAL_API, { bindings: [{ type: "service", name: "CUT" }] }, null)],
      ]),
    });
    const paused = await pause(fake);
    expect(paused.error).toBeNull();
    expect(fake.world.deploys.map((d) => d.script)).toEqual(["cut", "cut-api"]);
    expect(servingOf(fake.world, "cut-api")).toMatch(/^standin-cut-api-/);
    const api = fake.world.uploads.find((u) => u.script === "cut-api");
    // A Worker that never had Workers Logs settings gets none.
    expect(api?.metadata).not.toHaveProperty("observability");
    expect(api?.metadata.keep_bindings).toEqual(["service"]);
    expect((await findOpenPause(createDb(env.DB), "i1"))?.workerVersions).toEqual({
      cut: REAL,
      "cut-api": REAL_API,
    });

    const resumed = await resume(fake, { by: "u-grace" });
    expect(resumed.error).toBeNull();
    expect(servingOf(fake.world, "cut")).toBe(REAL);
    expect(servingOf(fake.world, "cut-api")).toBe(REAL_API);
    expect(fake.world.deploys.slice(2)).toEqual([
      { script: "cut", versionId: REAL, force: true },
      { script: "cut-api", versionId: REAL_API, force: true },
    ]);
    expect(fake.world.queues.get("q-1")?.paused).toBe(false);
    expect(Object.fromEntries(fake.world.workflows.get("cut-jobs") ?? [])).toEqual({
      "run-1": "running",
      "run-2": "running",
      "done-1": "complete",
    });
    expect(await findOpenPause(createDb(env.DB), "i1")).toBeNull();
    const [closed] = await listPauses(createDb(env.DB), "i1");
    expect(closed).toMatchObject({ resumedBy: "u-grace", resumeJobId: resumed.jobId });
    expect(closed?.resumedAt).toBeGreaterThan(NOW);
    expect(await job(resumed.jobId)).toMatchObject({ kind: "resume", status: "succeeded" });
    expect(await activityKinds()).toEqual(["paused", "resumed"]);
  });

  it("uploads the stand-ins side by side, then switches every Worker", async () => {
    const workers = ["cut", "cut-api", "cut-jobs", "cut-mail"];
    await seedApp({ workers, queues: false, workflow: false });
    const fake = world({
      scripts: new Map(workers.map((w, i) => [w, i === 0 ? cutWorker() : fakeScript(`real-${w}`)])),
    });
    const step = fakeStep();
    expect((await pause(fake, {}, { step })).error).toBeNull();
    // Workers Free: three per step (two requests each), the fourth in a step of its own.
    expect(step.names.filter((n) => n.startsWith("upload"))).toEqual([
      "upload the stand-ins of Workers cut, cut-api, cut-jobs",
      "upload the stand-in of Worker cut-mail",
    ]);
    expect(fake.world.mostUploadsAtOnce).toBe(3);
    const lastUpload = fake.world.calls.findLastIndex((c) => /^POST .*\/versions$/.test(c));
    const firstDeploy = fake.world.calls.findIndex((c) => /^POST .*\/deployments$/.test(c));
    expect(lastUpload).toBeLessThan(firstDeploy);
    expect(fake.world.deploys.map((d) => d.script)).toEqual(workers);
  });

  it("lets container applications run no instances, and Resume restores how many they allowed", async () => {
    await seedApp({ queues: false, workflow: false });
    const fake = world({
      containers: [
        { id: "app-1", name: "cut-box", namespaceId: "ns-counter", maxInstances: 3 },
        { id: "app-other", name: "someone-else", namespaceId: "ns-other", maxInstances: 5 },
      ],
    });
    expect((await pause(fake)).error).toBeNull();
    const containers = fake.world.containers as Array<{ id: string; maxInstances: number }>;
    expect(containers.map((c) => c.maxInstances)).toEqual([0, 5]);
    // The stand-in names the container class as wrangler does, so the application stays linked.
    expect(fake.world.uploads[0]?.metadata.containers).toEqual([
      { name: "cut-box", class_name: "Counter" },
    ]);
    expect((await findOpenPause(createDb(env.DB), "i1"))?.containersJson).toBe(
      JSON.stringify([{ id: "app-1", name: "cut-box", maxInstances: 3 }]),
    );
    expect((await resume(fake)).error).toBeNull();
    expect(containers.map((c) => c.maxInstances)).toEqual([3, 5]);
    // Containers allow instances again before the Worker serves the app's code.
    const patch = fake.world.calls.lastIndexOf("PATCH /containers/applications/app-1");
    const deploy = fake.world.calls.lastIndexOf("POST /workers/scripts/cut/deployments");
    expect(patch).toBeLessThan(deploy);
  });

  it("still pauses when the Workers Logs setting cannot be read", async () => {
    await seedApp({ queues: false, workflow: false });
    const fake = world({
      failAlways: new Map([["GET /workers/scripts/cut/script-settings", 403]]),
    });
    const { jobId, error } = await pause(fake);
    expect(error).toBeNull();
    // A version upload leaves the script's setting alone, so the stand-in goes without it.
    expect(fake.world.uploads[0]?.metadata).not.toHaveProperty("observability");
    expect(servingOf(fake.world, "cut")).toBe("standin-cut-1");
    expect(await logs(jobId)).toContain(
      'Could not read whether Workers Logs are on for "cut"; a version upload leaves that setting as it is, so the stand-in went without it.',
    );
  });

  it("leaves a queue an admin paused before as it was", async () => {
    await seedApp({ workflow: false });
    const fake = world({ queues: new Map([["q-1", { name: "cut-events", paused: true }]]) });
    const { jobId } = await pause(fake);
    expect((await findOpenPause(createDb(env.DB), "i1"))?.queuesJson).toBeNull();
    expect(await logs(jobId)).toContain(
      'The queue "cut-events" was paused already; Resume leaves it paused.',
    );
    await resume(fake);
    expect(fake.world.queues.get("q-1")?.paused).toBe(true);
  });

  it("finds a queue recorded without its id by its name", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url, status, installed_at, updated_at)
         VALUES ('i1', 'cut', 'cut', 'cut', '1.0.0', 'u', 'installed', 1, 1)`,
      ),
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES ('q', 'i1', 'queue', NULL, 'cut-events', NULL, 1)`,
      ),
    ]);
    const fake = world();
    expect((await pause(fake)).error).toBeNull();
    // No Worker recorded: the install's own Worker is paused.
    expect(fake.world.deploys.map((d) => d.script)).toEqual(["cut"]);
    expect(fake.world.queues.get("q-1")?.paused).toBe(true);
  });

  it("refuses a Worker that already serves a stand-in it has no record of", async () => {
    await seedApp({ queues: false, workflow: false });
    const fake = world();
    const cut = fake.world.scripts.get("cut") as FakeScript;
    cut.versions.set("stray", {
      annotations: { "workers/tag": "appflare-paused" },
      handlers: ["fetch"],
      named: [],
      bindings: [],
    });
    cut.deployments.unshift({ id: "dep-x", versions: [{ version_id: "stray", percentage: 100 }] });
    const { jobId, error } = await pause(fake);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect((await job(jobId))?.error).toContain("serves a stand-in of an earlier pause");
    expect(fake.world.uploads).toEqual([]);
    expect(await findOpenPause(createDb(env.DB), "i1")).toBeNull();
  });
});

describe("pause job: failures", () => {
  it("puts back what it changed when a step fails, and closes the pause so the next can start", async () => {
    await seedApp({ workers: ["cut", "cut-api"] });
    const fake = world({
      scripts: new Map([
        ["cut", cutWorker()],
        ["cut-api", fakeScript(REAL_API)],
      ]),
      failOnce: new Map([["POST /workers/scripts/cut-api/deployments", 400]]),
    });
    await addChannel({
      label: "Team",
      events: ["app_paused", "app_pause_failed"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const { jobId, error } = await pause(fake, {
      reason: "cap",
      by: null,
      detail: { amount: 5, period: "day" },
    } as PauseRequest);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(await job(jobId)).toMatchObject({ status: "failed" });
    // The channels hear that the pause did not happen: the app keeps spending.
    const { results: events } = await env.DB.prepare(
      "SELECT type, dedupe_key, facts_json FROM notification_events",
    ).all<{ type: string; dedupe_key: string; facts_json: string }>();
    expect(events.map((e) => e.type)).toEqual(["app_pause_failed"]);
    expect(events[0]?.dedupe_key).toMatch(new RegExp(`^app_pause_failed:[0-9A-Z]+:${jobId}$`));
    expect(JSON.parse(events[0]?.facts_json ?? "{}")).toMatchObject({
      jobId,
      by: null,
      cause: { reason: "cap", amount: 5, period: "day" },
      left: [],
    });
    expect((await job(jobId))?.error).toMatch(/^serve the stand-in of Worker cut-api: /);
    // The Worker that switched serves the app's version again, and the queue delivers.
    expect(servingOf(fake.world, "cut")).toBe(REAL);
    expect(servingOf(fake.world, "cut-api")).toBe(REAL_API);
    expect(fake.world.queues.get("q-1")?.paused).toBe(false);
    // Nothing stays open: the pause is closed by no one.
    expect(await findOpenPause(createDb(env.DB), "i1")).toBeNull();
    const [closed] = await listPauses(createDb(env.DB), "i1");
    expect(closed).toMatchObject({ resumedBy: null });
    expect(await activityKinds()).toEqual(["pause_failed"]);
    const failed = (await listActivity(createDb(env.DB), { installId: "i1" }))[0];
    expect(failed?.facts).toMatchObject({ reason: "cap", jobId });
    expect((await logs(jobId)).at(-1)).toContain(
      "Everything it had changed is back as it was, and the app runs as before.",
    );

    // The next pause starts and succeeds.
    fake.world.failAlways.clear();
    const again = await pause(fake);
    expect(again.error).toBeNull();
    expect(servingOf(fake.world, "cut-api")).toMatch(/^standin-cut-api-/);
  });

  it("keeps the pause open when something cannot be put back, and Resume finishes it", async () => {
    await seedApp();
    const fake = world();
    // Reading the Workflow fails, after the Worker switched; then the
    // queue's delivery cannot be resumed while the pause is undone.
    fake.world.failAlways.set("GET /workflows/cut-jobs", 400);
    let undoing = false;
    const refusing: Fake["fetch"] = async (input, init) => {
      if (undoing && init?.method === "PATCH" && input.endsWith("/queues/q-1")) {
        return Response.json(
          { success: false, errors: [{ code: 10000, message: "refused" }], messages: [] },
          { status: 403 },
        );
      }
      if (input.includes("/workflows/cut-jobs")) undoing = true;
      return fake.fetch(input, init);
    };
    const { jobId, error } = await pause({ ...fake, fetch: refusing });
    expect(error).toBeInstanceOf(NonRetryableError);
    // The Worker is back; the queue stays paused and recorded; the pause stays open.
    expect(servingOf(fake.world, "cut")).toBe(REAL);
    expect(fake.world.queues.get("q-1")?.paused).toBe(true);
    const open = await findOpenPause(createDb(env.DB), "i1");
    expect(open).not.toBeNull();
    expect((await logs(jobId)).at(-1)).toContain('could not put back: queue "cut-events"');
    expect(await activityKinds()).toEqual(["pause_failed"]);

    // Resume puts the rest back and closes it.
    fake.world.failAlways.clear();
    expect((await resume(fake)).error).toBeNull();
    expect(fake.world.queues.get("q-1")?.paused).toBe(false);
    expect(await findOpenPause(createDb(env.DB), "i1")).toBeNull();
  });

  it("carries on a pause whose job was stopped before it finished", async () => {
    await seedApp();
    const fake = world();
    // The first pause dies after its Worker switched: the engine stops running it.
    const jobs = capturingJobs();
    const first = await startPause(
      { DB: env.DB, JOBS: jobs.JOBS },
      { installId: "i1", reason: "manual", by: "u-ada" },
    );
    const stopping = stoppingStep("list running instances of Workflow cut-jobs");
    void runJob(runPause, jobs.created[0] as PauseJobParams, fake, { step: stopping.step });
    await stopping.stopped;
    // The engine reports the instance gone; the job is failed from outside.
    await env.DB.prepare("UPDATE jobs SET status = 'failed', error = 'terminated' WHERE id = ?1")
      .bind(first.jobId)
      .run();
    expect((await findOpenPause(createDb(env.DB), "i1"))?.jobId).toBe(first.jobId);

    const second = await pause(fake);
    expect(second.error).toBeNull();
    const open = await findOpenPause(createDb(env.DB), "i1");
    // The same pause, carried on, with the version recorded before anything changed.
    expect(open?.jobId).toBe(second.jobId);
    expect(open?.workerVersions).toEqual({ cut: REAL });
    expect(fake.world.queues.get("q-1")?.paused).toBe(true);
    expect(servingOf(fake.world, "cut")).toMatch(/^standin-cut-/);
    expect(await logs(second.jobId)).toContain(
      "An earlier pause of the app did not finish. This one carries on from what it recorded.",
    );
    // Resume brings the app's own version back, never a stand-in.
    expect((await resume(fake)).error).toBeNull();
    expect(servingOf(fake.world, "cut")).toBe(REAL);
  });

  it("resumes where it was when the engine runs an interrupted job again", async () => {
    await seedApp({ workers: ["cut", "cut-api"] });
    const fake = world({
      scripts: new Map([
        ["cut", cutWorker()],
        ["cut-api", fakeScript(REAL_API)],
      ]),
    });
    const jobs = capturingJobs();
    const { jobId } = await startPause(
      { DB: env.DB, JOBS: jobs.JOBS },
      { installId: "i1", reason: "manual", by: "u-ada" },
    );
    const params = jobs.created[0] as PauseJobParams;
    const recorded = new Map<string, unknown>();
    // The first run stops for good after the first stand-in serves.
    const first = replayingStep(recorded, "serve the stand-in of Worker cut");
    void runJob(runPause, params, fake, { step: first.step });
    await first.stopped;
    expect(fake.world.deploys).toHaveLength(1);
    // The engine runs it again: recorded steps return their results without running.
    const second = replayingStep(recorded);
    expect(await runJob(runPause, params, fake, { step: second.step })).toBeNull();
    expect(await job(jobId)).toMatchObject({ status: "succeeded" });
    expect(fake.world.uploads).toHaveLength(2);
    expect(fake.world.deploys.map((d) => d.script)).toEqual(["cut", "cut-api"]);
    expect(await activityKinds()).toEqual(["paused"]);
  });

  it("spreads a large pause over invocations on Workers Free", async () => {
    await seedApp({ workers: ["cut", "cut-api", "cut-worker"] });
    const instances = new Map<string, InstanceStatus>(
      Array.from({ length: 40 }, (_, i) => [`run-${i}`, "running"]),
    );
    const fake = world({
      scripts: new Map([
        ["cut", cutWorker()],
        ["cut-api", fakeScript(REAL_API)],
        ["cut-worker", fakeScript("33333333-3333-4333-8333-333333333333")],
      ]),
      workflows: new Map([["cut-jobs", instances]]),
    });
    const engine = fakeEngine();
    const { jobId, error } = await pause(fake, {}, { engine });
    expect(error).toBeNull();
    expect(await job(jobId)).toMatchObject({ status: "succeeded" });
    expect(engine.invocations.length).toBeGreaterThan(1);
    expect(Math.max(...engine.invocations)).toBeLessThanOrEqual(50);
    expect([...instances.values()].every((s) => s === "paused")).toBe(true);
  });
});

describe("pause job: a pause carried on", () => {
  /**
   * A first pause switches the Worker to its stand-in, then fails, and can
   * put back neither the Worker nor the container: its pause stays open,
   * the Worker on its stand-in.
   */
  async function strandedPause(fake: Fake): Promise<void> {
    const strand = (name: string) => {
      if (name !== "serve the stand-in of Worker cut") return Promise.resolve();
      fake.world.failAlways.set("POST /workers/scripts/cut/deployments", 400);
      fake.world.failAlways.set("PATCH /containers/applications/app-1", 400);
      return Promise.resolve();
    };
    const first = await pause(fake, {}, { step: fakeStep({ afterStep: strand }) });
    expect(first.error).toBeInstanceOf(NonRetryableError);
    expect(servingOf(fake.world, "cut")).toMatch(/^standin-cut-/);
    expect(await findOpenPause(createDb(env.DB), "i1")).not.toBeNull();
    fake.world.failAlways.clear();
  }

  function containerWorld() {
    return world({
      containers: [{ id: "app-1", name: "cut-box", namespaceId: "ns-counter", maxInstances: 3 }],
    });
  }

  it("puts back what the earlier job changed when it fails too", async () => {
    await seedApp();
    const fake = containerWorld();
    await strandedPause(fake);
    // The second pause carries the first on, then fails before changing anything itself.
    fake.world.failOnce.set("GET /workers/durable_objects/namespaces", 400);
    const second = await pause(fake);
    expect(second.error).toBeInstanceOf(NonRetryableError);
    expect(servingOf(fake.world, "cut")).toBe(REAL);
    const containers = fake.world.containers as Array<{ maxInstances: number }>;
    expect(containers[0]?.maxInstances).toBe(3);
    expect(fake.world.queues.get("q-1")?.paused).toBe(false);
    expect(await findOpenPause(createDb(env.DB), "i1")).toBeNull();
  });

  it("puts back what the earlier job changed when its start fails after taking the pause over", async () => {
    await seedApp();
    const fake = containerWorld();
    await strandedPause(fake);
    // The start records the takeover, then its answer is lost, every time.
    const lost = async (name: string) => {
      if (name === "start") throw new Error("the answer was lost");
    };
    const second = await pause(fake, {}, { step: fakeStep({ afterStep: lost }) });
    expect(second.error).toBeInstanceOf(NonRetryableError);
    // Never closed with the Worker on its stand-in: put back, then closed.
    expect(servingOf(fake.world, "cut")).toBe(REAL);
    expect(await findOpenPause(createDb(env.DB), "i1")).toBeNull();
  });

  it("leaves the pause open when what the earlier job changed still cannot be put back", async () => {
    await seedApp();
    const fake = containerWorld();
    await strandedPause(fake);
    fake.world.failOnce.set("GET /workers/durable_objects/namespaces", 400);
    fake.world.failAlways.set("POST /workers/scripts/cut/deployments", 400);
    const second = await pause(fake);
    expect(second.error).toBeInstanceOf(NonRetryableError);
    expect(servingOf(fake.world, "cut")).toMatch(/^standin-cut-/);
    expect(await findOpenPause(createDb(env.DB), "i1")).not.toBeNull();
  });
});

describe("pause job: notifications and limits", () => {
  it("still succeeds when the notification cannot be recorded", async () => {
    await seedApp({ queues: false, workflow: false });
    const fake = world();
    const step = fakeStep({ failing: ["tell notification channels"] });
    const { jobId, error } = await pause(fake, {}, { step });
    expect(error).toBeNull();
    expect(await job(jobId)).toMatchObject({ status: "succeeded" });
    expect(await findOpenPause(createDb(env.DB), "i1")).not.toBeNull();
    expect(servingOf(fake.world, "cut")).toMatch(/^standin-cut-/);
  });

  it("lists at most 1,000 Workflow instances, and no status past them", async () => {
    const instances = new Map<string, InstanceStatus>(
      Array.from({ length: 1_000 }, (_, i) => [`q-${i}`, "queued"]),
    );
    instances.set("r-1", "running");
    instances.set("w-1", "waiting");
    const fake = world({ workflows: new Map([["cut-jobs", instances]]) });
    const found = await activeInstancesOf(apiOf(fake), "cut-jobs");
    expect(found?.ids).toHaveLength(1_000);
    expect(found?.capped).toBe(true);
    // The queued ones filled it: the running and waiting ones were not asked for.
    expect(fake.world.calls.filter((c) => c.endsWith("/instances"))).toHaveLength(1);
  });

  it("resumes the delivery of a queue the uninstall keeps", async () => {
    await seedApp({ workflow: false });
    const fake = world();
    await pause(fake);
    expect(fake.world.queues.get("q-1")?.paused).toBe(true);
    await env.DB.prepare("UPDATE resources SET retained_at = 2 WHERE id = 'q'").run();
    const steps = createJobSteps(
      {
        params: { kind: "uninstall", jobId: "ju" },
        step: fakeStep(),
        env: { DB: env.DB, CF_API_TOKEN: TOKEN },
        deps: { fetch: fake.fetch, now: tick },
      },
      "ju",
    );
    steps.setAccountId(ACC);
    await resumeKeptQueuesPhase(steps, env.DB, "i1");
    expect(fake.world.queues.get("q-1")?.paused).toBe(false);
  });
});

describe("resume job", () => {
  it("leaves a Worker someone deployed while the app was paused as it is", async () => {
    await seedApp({ queues: false, workflow: false });
    const fake = world();
    await pause(fake);
    const cut = fake.world.scripts.get("cut") as FakeScript;
    cut.versions.set("newer", { handlers: ["fetch"], named: [], bindings: [] });
    cut.deployments.unshift({
      id: "dep-dash",
      versions: [{ version_id: "newer", percentage: 100 }],
    });
    const { jobId, error } = await resume(fake);
    expect(error).toBeNull();
    expect(servingOf(fake.world, "cut")).toBe("newer");
    expect(await logs(jobId)).toContain(
      `Worker "cut" serves version newer, deployed while the app was paused; it keeps serving it instead of version ${REAL}.`,
    );
    expect(await findOpenPause(createDb(env.DB), "i1")).toBeNull();
  });

  it("sets the cap aside until its period resets when asked", async () => {
    await seedApp({ queues: false, workflow: false });
    await writeAccountPlan(createDb(env.DB), "paid");
    await writeAppSpendSettings(
      createDb(env.DB),
      "i1",
      { autoPause: "on", customTriggers: true, capOn: true, capAmount: 10, capPeriod: "week" },
      { userId: "u-ada" },
    );
    const fake = world();
    await pause(fake, {
      reason: "cap",
      by: null,
      detail: { amount: 10, period: "week" },
    } as PauseRequest);
    const { jobId, error } = await resume(fake, { by: "u-grace", untilCapResets: true });
    expect(error).toBeNull();
    const until = periodEnd("week", NOW);
    expect((await readAppSpendSettings(createDb(env.DB), "i1")).capSetAsideUntil).toBe(until);
    const activity = await listActivity(createDb(env.DB), { installId: "i1" });
    // Recorded at the same instant: in either order.
    expect(activity.at(-1)?.kind).toBe("paused");
    expect(
      activity
        .slice(0, 2)
        .map((a) => a.kind)
        .sort(),
    ).toEqual(["cap_set_aside", "resumed"]);
    expect(activity.find((a) => a.kind === "cap_set_aside")).toMatchObject({
      by: "u-grace",
      facts: { until },
    });
    expect((await logs(jobId)).at(-1)).toContain("Its spending cap is set aside until");
  });

  it("keeps the app paused when a step fails, and a second Resume carries on", async () => {
    await seedApp({ workers: ["cut", "cut-api"] });
    await addChannel({
      label: "Team",
      events: ["app_resumed"],
      settings: { kind: "slack", webhookUrl: SLACK_URL },
    });
    const fake = world({
      scripts: new Map([
        ["cut", cutWorker()],
        ["cut-api", fakeScript(REAL_API)],
      ]),
    });
    await pause(fake, {
      by: null,
      reason: "loop",
      detail: { level: "standard", plan: "paid" },
    } as PauseRequest);
    fake.world.failAlways.set("POST /workers/scripts/cut-api/deployments", 400);
    const failed = await resume(fake);
    expect(failed.error).toBeInstanceOf(NonRetryableError);
    expect(await job(failed.jobId)).toMatchObject({ status: "failed" });
    const open = await findOpenPause(createDb(env.DB), "i1");
    expect(open?.resumeJobId).toBe(failed.jobId);
    expect(servingOf(fake.world, "cut")).toBe(REAL);
    expect(await activityKinds()).toEqual(["paused", "resume_failed"]);
    expect((await logs(failed.jobId)).at(-1)).toContain(
      "The app stays paused; resume it again to carry on from there.",
    );

    fake.world.failAlways.clear();
    const again = await resume(fake);
    expect(again.error).toBeNull();
    expect(servingOf(fake.world, "cut-api")).toBe(REAL_API);
    expect(await activityKinds()).toEqual(["paused", "resume_failed", "resumed"]);
    // Someone resumed what a trigger paused: news, once.
    const { results } = await env.DB.prepare(
      "SELECT type FROM notification_events WHERE type = 'app_resumed'",
    ).all();
    expect(results).toHaveLength(1);
  });
});

describe("pause and resume of an app whose Worker was deleted by hand", () => {
  it("refuses to pause, in a sentence, before changing anything", async () => {
    await seedApp();
    const fake = world({ scripts: new Map() });
    const { jobId, error } = await pause(fake);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect((await job(jobId))?.error).toBe(
      'read Worker cut: the app\'s Worker "cut" is gone from the account (it was deleted outside Appflare), so there is nothing of it to pause. Uninstall the app to remove what is left of it',
    );
    // Nothing changed: the queue still delivers, the Workflow still runs.
    expect(fake.world.queues.get("q-1")?.paused).toBe(false);
    expect(fake.world.workflows.get("cut-jobs")?.get("run-1")).toBe("running");
    expect(await findOpenPause(createDb(env.DB), "i1")).toBeNull();
  });

  it("refuses to resume, in a sentence, and keeps the pause open", async () => {
    await seedApp({ queues: false, workflow: false });
    const fake = world();
    expect((await pause(fake)).error).toBeNull();
    fake.world.scripts.delete("cut");
    const { jobId, error } = await resume(fake);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect((await job(jobId))?.error).toBe(
      "check the app's Workers: the app's Worker \"cut\" is gone from the account (it was deleted outside Appflare), so the app cannot run again. Uninstall the app to remove what is left of it",
    );
    expect(await findOpenPause(createDb(env.DB), "i1")).not.toBeNull();
  });
});

/**
 * A step runner whose run stops for good (its promise never settles, as an
 * isolate that is gone) once the named step is about to run.
 */
function stoppingStep(stopAt: string): { step: StepRunner; stopped: Promise<void> } {
  let signal: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const inner = fakeStep();
  const step: StepRunner = {
    async do<T>(
      name: string,
      configOrCallback: StepConfig | ((ctx?: StepContext) => Promise<T>),
      maybeCallback?: (ctx?: StepContext) => Promise<T>,
    ): Promise<T> {
      if (name === stopAt) {
        signal();
        return new Promise<T>(() => {});
      }
      return typeof configOrCallback === "function"
        ? inner.do(name, configOrCallback)
        : inner.do(name, configOrCallback, maybeCallback as (ctx?: StepContext) => Promise<T>);
    },
    sleep: (name, duration) => inner.sleep(name, duration),
  };
  return { step, stopped };
}

/**
 * The engine's replay: a step already recorded returns its result without
 * running. With `stopAfter`, the run stops for good once that step has run
 * and been recorded.
 */
function replayingStep(
  recorded: Map<string, unknown>,
  stopAfter?: string,
): { step: StepRunner; stopped: Promise<void> } {
  let signal: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const inner = fakeStep();
  const step: StepRunner = {
    async do<T>(
      name: string,
      configOrCallback: StepConfig | ((ctx?: StepContext) => Promise<T>),
      maybeCallback?: (ctx?: StepContext) => Promise<T>,
    ): Promise<T> {
      if (recorded.has(name)) return recorded.get(name) as T;
      const result =
        typeof configOrCallback === "function"
          ? await inner.do(name, configOrCallback)
          : await inner.do(
              name,
              configOrCallback,
              maybeCallback as (ctx?: StepContext) => Promise<T>,
            );
      recorded.set(name, result);
      if (name === stopAfter) {
        signal();
        return new Promise<T>(() => {});
      }
      return result;
    },
    sleep: (name, duration) => inner.sleep(name, duration),
  };
  return { step, stopped };
}
