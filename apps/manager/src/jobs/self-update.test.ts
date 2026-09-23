import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { MAX_WORKER_MODULES } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { refreshManagerReleases } from "../catalog/manager-releases.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { startUpdateCore, VersionActionError } from "../installs/versions.server";
import { type ArtifactFixture, buildArtifactFixture } from "../test/artifact-fixture";
import {
  ACC,
  type FakeAccount,
  fakeAccount,
  NEW_VERSION,
  SUBDOMAIN,
  TOKEN,
} from "../test/fake-account";
import { fakeGithub, GITHUB_TOKEN, githubRelease } from "../test/fake-releases";
import { fakeStep } from "../test/fake-step";
import { INSTALL_ID, seedInstall } from "../test/seed-install";
import { reconcileJobs } from "./reconcile.server";
import type { JobEnv } from "./run-job";
import { runSelfUpdate, type SelfUpdateJobParams } from "./self-update";
import { selfUpdateBusyMessage } from "./self-update/guard";
import { finalizeSelfUpdates } from "./self-update/record";
import { SelfUpdateError, startSelfUpdateCore } from "./self-update/start.server";

/**
 * End-to-end test of the self-update: the release feed read through a fake
 * private GitHub (token, API asset URLs, redirect to a storage host that
 * refuses the token), the start claim, and the job against a stateful fake of
 * the Cloudflare API, with the Workflow engine replaced by `fakeStep`. The
 * manager here was installed as "team-apps", so its Workflow is
 * "team-apps-jobs".
 */

const WORKER = "team-apps";
const OLD_WORKER_VERSION = "11111111-2222-4333-8444-555555555555";
const FROM = "0.1.0";
const TO = "0.2.0";
const NO_WORKFLOWS = {
  get: async () => {
    throw new Error("instance not_found");
  },
};

/** The running manager's bindings, as `GET /workers/scripts/team-apps/bindings` reports them. */
const RUNNING_BINDINGS = [
  { type: "assets", name: "ASSETS" },
  { type: "d1", name: "DB", database_id: "d1-manager" },
  { type: "kv_namespace", name: "KV", namespace_id: "kv-manager" },
  {
    type: "workflow",
    name: "JOBS",
    workflow_name: "team-apps-jobs",
    class_name: "JobWorkflow",
    script_name: WORKER,
  },
  { type: "plain_text", name: "APPFLARE_VERSION", text: FROM },
  { type: "secret_text", name: "BETTER_AUTH_SECRET" },
  { type: "secret_text", name: "CF_API_TOKEN" },
];

const healthy = (version: string) => ({
  status: 200,
  body: JSON.stringify({ version, db: "ok", schemaVersion: 5 }),
});

function managerRelease(
  version = TO,
  keyId = "appflare-test",
  tweak?: (manifest: ArtifactFixture["manifest"]) => void,
): Promise<ArtifactFixture> {
  return buildArtifactFixture({
    version,
    keyId,
    catalog: { slug: "appflare", name: "Appflare", secrets: [], vars: [] },
    bindings: [
      { type: "d1", name: "DB" },
      { type: "kv_namespace", name: "KV" },
      { type: "workflow", name: "JOBS", workflow_name: "appflare-jobs", class_name: "JobWorkflow" },
      { type: "plain_text", name: "APPFLARE_VERSION", text: version },
    ],
    assets: [{ route: "/index.html", content: `<html>Appflare ${version}</html>` }],
    tweak: (m) => {
      m.app = "appflare";
      m.worker.name = "appflare";
      m.worker.compatibilityFlags = ["nodejs_compat", "global_fetch_strictly_public"];
      m.worker.observability = { enabled: true };
      m.assets.binding = "ASSETS";
      m.assets.config = { not_found_handling: "single-page-application" };
      tweak?.(m);
    },
  });
}

async function selfUpdate(opts: {
  release?: ArtifactFixture;
  keys?: ArtifactFixture["keys"];
  world?: Partial<FakeAccount>;
}) {
  const release = opts.release ?? (await managerRelease());
  const fake = fakeAccount(release, {
    worker: WORKER,
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_WORKER_VERSION, percentage: 100 }] }],
    bindings: RUNNING_BINDINGS,
    bookmarks: { "d1-manager": "00000042-bookmark" },
    previews: [{ status: 404, body: "error code: 1042" }, healthy(TO)],
    ...opts.world,
  });
  const github = fakeGithub(release, [githubRelease(FROM), githubRelease(TO)]);
  /** What the new code's boot finalization did on each preview request (the canary). */
  const previewFinalizations: number[] = [];
  const fetch: FetchLike = async (input, init) => {
    if (new URL(input).host.endsWith(`-${WORKER}.${SUBDOMAIN}.workers.dev`)) {
      // The preview runs the new version against the same database; model its
      // first-request finalization (without the host check, the marker alone must hold).
      const done = await finalizeSelfUpdates({ DB: env.DB, APPFLARE_VERSION: TO });
      previewFinalizations.push(done.completed);
    }
    return github.serve(input, init) ?? fake.fetch(input, init);
  };

  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: WORKER,
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
  const latest = await refreshManagerReleases(
    { KV: env.KV, APPFLARE_VERSION: FROM, GITHUB_TOKEN },
    { fetch },
  );
  let params: SelfUpdateJobParams | null = null;
  const { jobId } = await startSelfUpdateCore(
    {
      db: env.DB,
      latest,
      currentVersion: FROM,
      hasToken: true,
      workflows: NO_WORKFLOWS,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => "job1",
    },
    { version: TO },
  );
  if (params === null) throw new Error("no Workflow params");

  const step = fakeStep();
  const jobEnv: JobEnv = {
    DB: env.DB,
    KV: env.KV,
    CF_API_TOKEN: TOKEN,
    APPFLARE_VERSION: FROM,
    GITHUB_TOKEN,
  };
  let error: unknown = null;
  try {
    await runSelfUpdate({
      params,
      step,
      env: jobEnv,
      deps: { fetch, signingKeys: opts.keys ?? release.keys },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(jobId).first<{
    status: string;
    error: string | null;
    worker_version_id: string | null;
    promoting_version: string | null;
  }>();
  const snapshot = await env.DB.prepare("SELECT * FROM snapshots WHERE job_id = ?1")
    .bind(jobId)
    .first<Record<string, unknown>>();
  const history = await env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
    .bind(SETTING.managerVersionHistory)
    .first<{ value: string }>();
  const logs = (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ level: string; message: string }>()
  ).results;
  return {
    release,
    fake,
    github,
    step,
    error,
    job,
    snapshot,
    history,
    logs,
    params,
    previewFinalizations,
  };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("self_update job", () => {
  it("uploads the release with the running Worker's bindings, checks its preview, and promotes it last", async () => {
    const r = await selfUpdate({});
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({
      status: "succeeded",
      error: null,
      worker_version_id: NEW_VERSION,
      promoting_version: TO,
    });
    // The canary's preview requests ran the new code, which completed nothing.
    expect(r.previewFinalizations).toEqual([0, 0]);
    expect(r.step.names).toEqual([
      "start",
      "verify release manifest",
      "check release shape",
      "read current deployment",
      "read current bindings",
      "bookmark Appflare database",
      "record snapshot",
      "open assets upload session",
      "upload assets bucket 1/1",
      "upload Worker version",
      "record Worker version",
      "look up workers.dev subdomain",
      "enable version previews",
      "canary check 1",
      "canary check 2",
      "mark promotion",
      "promote version",
      "record",
    ]);

    // The version: own bindings (renamed Workflow kept), new version var, assets, secrets kept.
    const uploaded = r.fake.state.versions[0];
    expect(uploaded?.modules).toEqual(["worker.js"]);
    expect(uploaded?.metadata).toMatchObject({
      main_module: "worker.js",
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
      keep_bindings: ["secret_text"],
      assets: { jwt: "completion-jwt", config: { not_found_handling: "single-page-application" } },
      observability: { enabled: true },
      annotations: { "workers/tag": TO },
    });
    expect(uploaded?.metadata.bindings).toEqual([
      { type: "d1", name: "DB", id: "d1-manager" },
      { type: "kv_namespace", name: "KV", namespace_id: "kv-manager" },
      {
        type: "workflow",
        name: "JOBS",
        workflow_name: "team-apps-jobs",
        class_name: "JobWorkflow",
      },
      { type: "plain_text", name: "APPFLARE_VERSION", text: TO },
      { type: "assets", name: "ASSETS" },
    ]);

    // Canary on the version's own preview, then promotion.
    expect(r.fake.state.previewHosts).toEqual([
      `0a1b2c3d-${WORKER}.${SUBDOMAIN}.workers.dev`,
      `0a1b2c3d-${WORKER}.${SUBDOMAIN}.workers.dev`,
    ]);
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
    expect(r.fake.state.calls.at(-1)).toBe(`POST /workers/scripts/${WORKER}/deployments`);

    // The snapshot has no install and records both versions.
    expect(r.snapshot).toMatchObject({
      id: "job1",
      install_id: null,
      worker_version_id: OLD_WORKER_VERSION,
      d1_bookmarks_json: '{"d1-manager":"00000042-bookmark"}',
      catalog_version: FROM,
      target_catalog_version: TO,
    });
    expect(JSON.parse(r.history?.value ?? "[]")).toEqual([
      expect.objectContaining({
        version: TO,
        from: FROM,
        jobId: "job1",
        workerVersionId: NEW_VERSION,
      }),
    ]);
    expect(r.logs.at(-1)?.message).toBe(`Appflare ${TO} serves all traffic (was ${FROM}).`);

    // The GitHub token went to api.github.com only, never to the asset storage host.
    expect(r.github.requests.some((q) => q.url.includes("release-assets.test"))).toBe(true);
    for (const q of r.github.requests) {
      expect(q.authorized).toBe(q.url.startsWith("https://api.github.com/"));
    }
    // Neither token appears in the log.
    const text = JSON.stringify(r.logs);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(GITHUB_TOKEN);
  });

  it("fails before promotion when the preview reports another version", async () => {
    const r = await selfUpdate({ world: { previews: [healthy(FROM)] } });
    expect(r.error).not.toBeNull();
    expect(r.job?.status).toBe("failed");
    expect(r.job?.promoting_version).toBeNull();
    expect(r.previewFinalizations).toEqual([0]);
    expect(r.job?.error).toBe(`canary check 1: the preview reports version ${FROM}, not ${TO}`);
    expect(r.step.names).not.toContain("promote version");
    expect(r.step.names).not.toContain("record");
    expect(r.fake.state.calls).not.toContain(`POST /workers/scripts/${WORKER}/deployments`);
    expect(r.fake.state.deployments).toHaveLength(1);
    expect(r.history).toBeNull();
    expect(r.logs.at(-1)?.message).toBe(
      `Self-update failed at "canary check 1". Version ${NEW_VERSION} was uploaded but never promoted; Appflare ${FROM} keeps serving all traffic.`,
    );
  });

  it("refuses a release with more modules than one upload can fetch, before touching Cloudflare", async () => {
    const release = await managerRelease(TO, "appflare-test", (m) => {
      // A code-split server build: 84 chunks. The entries are never fetched.
      const first = m.worker.modules[0];
      if (first === undefined) throw new Error("the fixture has no module");
      for (let i = 1; i < 84; i++) m.worker.modules.push({ ...first, name: `chunk-${i}.js` });
    });
    const r = await selfUpdate({ release });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      `check release shape: The release has 84 Worker modules, but one upload can fetch at most ${MAX_WORKER_MODULES} within the free plan's 50 subrequests per invocation (2 per module from a release asset). It must be built as ${MAX_WORKER_MODULES} or fewer modules, for example as one bundled module.`,
    );
    expect(r.step.names).toEqual([
      "start",
      "verify release manifest",
      "check release shape",
      "mark self-update failed",
    ]);
    expect(r.fake.state.calls).toEqual([]);
    expect(r.snapshot).toBeNull();
    expect(r.logs.at(-1)?.message).toBe(
      `Self-update failed at "check release shape". Nothing was deployed; Appflare ${FROM} keeps serving all traffic.`,
    );
  });

  it("fails without touching Cloudflare when the signature does not verify", async () => {
    const other = await managerRelease();
    const r = await selfUpdate({ keys: other.keys });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^verify release manifest: manifest signature does not verify/);
    expect(r.fake.state.calls).toEqual([]);
    expect(r.snapshot).toBeNull();
  });

  it("only records the end when it resumes on the version it promoted", async () => {
    await env.DB.prepare(
      `INSERT INTO jobs (id, kind, status, input_json, worker_version_id, promoting_version)
       VALUES ('job1', 'self_update', 'running', ?1, ?2, ?3)`,
    )
      .bind(JSON.stringify({ version: TO, fromVersion: FROM }), NEW_VERSION, TO)
      .run();
    const release = await managerRelease();
    const step = fakeStep();
    await runSelfUpdate({
      params: {
        kind: "self_update",
        jobId: "job1",
        version: TO,
        fromVersion: FROM,
        tag: `manager@${TO}`,
        artifacts: release.index.artifacts,
      },
      step,
      env: { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN, APPFLARE_VERSION: TO },
      deps: {},
    });
    expect(step.names).toEqual(["record"]);
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 'job1'").first();
    expect(job).toEqual({ status: "succeeded" });
  });
});

describe("finalizeSelfUpdates", () => {
  const insert = (id: string, version: string, promoting: string | null) =>
    env.DB.prepare(
      "INSERT INTO jobs (id, kind, status, input_json, promoting_version) VALUES (?1, 'self_update', 'running', ?2, ?3)",
    )
      .bind(id, JSON.stringify({ version, fromVersion: FROM }), promoting)
      .run();
  const statuses = async () =>
    (
      await env.DB.prepare("SELECT id, status FROM jobs ORDER BY id").all<{
        id: string;
        status: string;
      }>()
    ).results;
  const history = async () =>
    env.DB.prepare("SELECT value FROM settings WHERE key = ?1")
      .bind(SETTING.managerVersionHistory)
      .first<{ value: string }>();

  it("completes a promoted self-update left running whose target is the running version, and only that", async () => {
    await insert("to-0.2.0", TO, TO);
    await insert("to-0.3.0", "0.3.0", "0.3.0");
    const new_ = { DB: env.DB, APPFLARE_VERSION: TO };
    expect(await finalizeSelfUpdates(new_)).toEqual({ completed: 1, previewHost: false });
    expect(await finalizeSelfUpdates(new_)).toEqual({ completed: 0, previewHost: false });
    expect(await statuses()).toEqual([
      { id: "to-0.2.0", status: "succeeded" },
      { id: "to-0.3.0", status: "running" },
    ]);
    const log = await env.DB.prepare(
      "SELECT message FROM job_logs WHERE job_id = 'to-0.2.0'",
    ).first();
    expect(log).toEqual({
      message: `Completed by the new version: Appflare ${TO} serves all traffic.`,
    });
    expect(JSON.parse((await history())?.value ?? "[]")).toHaveLength(1);
  });

  it("changes nothing while the new version only serves its preview (the canary, before promotion)", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.workerName]: WORKER });
    // The job is between upload and promotion: no marker yet.
    await insert("canary", TO, null);
    const preview = `0a1b2c3d-${WORKER}.${SUBDOMAIN}.workers.dev`;
    expect(
      await finalizeSelfUpdates({ DB: env.DB, APPFLARE_VERSION: TO }, { host: preview }),
    ).toEqual({
      completed: 0,
      previewHost: false,
    });
    expect(await finalizeSelfUpdates({ DB: env.DB, APPFLARE_VERSION: TO })).toEqual({
      completed: 0,
      previewHost: false,
    });
    expect(await statuses()).toEqual([{ id: "canary", status: "running" }]);
    expect(await history()).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM job_logs").first()).toEqual({ n: 0 });
  });

  it("never completes a job from a preview host, even once the job is marked", async () => {
    await writeSettings(createDb(env.DB), { [SETTING.workerName]: WORKER });
    await insert("marked", TO, TO);
    const preview = `0a1b2c3d-${WORKER}.${SUBDOMAIN}.workers.dev`;
    expect(
      await finalizeSelfUpdates({ DB: env.DB, APPFLARE_VERSION: TO }, { host: preview }),
    ).toEqual({
      completed: 0,
      previewHost: true,
    });
    expect(await statuses()).toEqual([{ id: "marked", status: "running" }]);
    const live = `${WORKER}.${SUBDOMAIN}.workers.dev`;
    expect(await finalizeSelfUpdates({ DB: env.DB, APPFLARE_VERSION: TO }, { host: live })).toEqual(
      {
        completed: 1,
        previewHost: false,
      },
    );
  });

  it("appends the history when reconciliation finds a promoted instance complete", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, kind, status, input_json, promoting_version, workflow_instance_id) VALUES ('done', 'self_update', 'running', ?1, ?2, 'done')",
    )
      .bind(JSON.stringify({ version: TO, fromVersion: FROM }), TO)
      .run();
    const rows = (await env.DB.prepare("SELECT * FROM jobs").all()).results as never[];
    const complete = { get: async () => ({ status: async () => ({ status: "complete" }) }) };
    expect(await reconcileJobs(env.DB, complete, rows)).toBe(true);
    expect(await statuses()).toEqual([{ id: "done", status: "succeeded" }]);
    expect(JSON.parse((await history())?.value ?? "[]")).toEqual([
      expect.objectContaining({ version: TO, from: FROM, jobId: "done" }),
    ]);
  });
});

describe("starting a self-update", () => {
  const deps = async () => {
    await writeSettings(createDb(env.DB), {
      [SETTING.accountId]: ACC,
      [SETTING.workerName]: WORKER,
    });
    const release = await managerRelease();
    return {
      db: env.DB,
      latest: {
        version: TO,
        tag: `manager@${TO}`,
        assets: release.index.artifacts,
        publishedAt: null,
        checkedAt: "2026-09-23T00:00:00.000Z",
      },
      currentVersion: FROM,
      hasToken: true,
      workflows: {
        get: async () => ({ status: async () => ({ status: "running" }) }),
      },
      createJob: async (id: string) => ({ id }),
    };
  };

  it("refuses an older or unknown release and while another job runs", async () => {
    const d = await deps();
    await expect(
      startSelfUpdateCore({ ...d, currentVersion: TO }, { version: TO }),
    ).rejects.toThrow(/not newer than the running version/);
    await expect(startSelfUpdateCore(d, { version: "0.3.0" })).rejects.toThrow(
      /not the newest Appflare release/,
    );
    await expect(startSelfUpdateCore({ ...d, latest: null }, { version: TO })).rejects.toThrow(
      SelfUpdateError,
    );
    await env.DB.prepare(
      "INSERT INTO jobs (id, kind, status, workflow_instance_id) VALUES ('busy', 'install', 'running', 'busy')",
    ).run();
    await expect(startSelfUpdateCore(d, { version: TO })).rejects.toThrow(
      /Another job is queued or running/,
    );
  });

  it("keeps other jobs from starting while it runs", async () => {
    const d = await deps();
    await startSelfUpdateCore({ ...d, newId: () => "self" }, { version: TO });
    await seedInstall();
    const fixture = await buildArtifactFixture({ version: "1.1.0" });
    await expect(
      startUpdateCore(
        {
          db: env.DB,
          loadApp: async () => fixture.index,
          loadManifest: async () => fixture.manifest,
          createJob: async (id: string) => ({ id }),
        },
        { installId: INSTALL_ID, secrets: { ADMIN_PASSWORD: "pw" } },
      ),
    ).rejects.toThrow(new VersionActionError(selfUpdateBusyMessage("self")));
  });

  it("is failed by reconciliation when its Workflow instance died", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, kind, status, workflow_instance_id) VALUES ('self', 'self_update', 'running', 'self')",
    ).run();
    const rows = (await env.DB.prepare("SELECT * FROM jobs").all()).results as never[];
    const changed = await reconcileJobs(
      env.DB,
      {
        get: async () => ({
          status: async () => ({ status: "errored", error: { message: "boom" } }),
        }),
      },
      rows,
    );
    expect(changed).toBe(true);
    const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = 'self'").first();
    expect(job).toEqual({ status: "failed", error: "the job's Workflow instance failed: boom" });
  });
});
