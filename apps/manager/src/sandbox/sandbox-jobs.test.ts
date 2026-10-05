import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createClient, type FetchLike } from "@appflare/cf-api";
import { SANDBOX_CONTAINERS } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { JobEnv } from "../jobs/run-job";
import type { ArtifactFixture } from "../test/artifact-fixture";
import { ACC, type FakeAccount, SUBDOMAIN, TOKEN } from "../test/fake-account";
import {
  type FakeContainerApp,
  fakeSandboxAccount,
  MANAGER,
  MANAGER_SERVING,
  type SandboxAccountState,
  sandboxRelease,
} from "../test/fake-sandbox-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { seedInstall } from "../test/seed-install";
import { runSandboxDisable, type SandboxDisableJobParams } from "./disable-job";
import { runSandboxEnable, type SandboxEnableJobParams } from "./enable-job";
import { SandboxJobError, startSandboxJobCore } from "./jobs.server";

/**
 * Enabling, updating and disabling sandbox builds end to end: the start
 * checks and claim, then the job against a stateful fake of the account (the
 * sandbox Worker, R2, Containers, and the manager's own Worker), with the
 * Workflow engine replaced by `fakeStep` and `SELF` by `fakeSelf`.
 */

const MANAGER_VERSION = "0.5.0";
const VERSION = "0.1.2";
const NO_WORKFLOWS = {
  get: async () => {
    throw new Error("instance not_found");
  },
};
const healthy = { status: 200, body: JSON.stringify({ version: MANAGER_VERSION, db: "ok" }) };
const SANDBOX_SERVICE = { type: "service", name: "SANDBOX", service: "appflare-sandbox" };

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), {
    [SETTING.accountId]: ACC,
    [SETTING.workerName]: MANAGER,
    [SETTING.accountSubdomain]: SUBDOMAIN,
  });
});

async function start(
  world: ReturnType<typeof fakeSandboxAccount>,
  request: Parameters<typeof startSandboxJobCore>[1],
) {
  let params: SandboxEnableJobParams | SandboxDisableJobParams | null = null;
  const { jobId } = await startSandboxJobCore(
    {
      db: env.DB,
      client: async () => createClient({ accountId: ACC, token: TOKEN, fetch: world.fetch }),
      workflows: NO_WORKFLOWS,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      currentVersion: MANAGER_VERSION,
      sandboxVersion: VERSION,
      newId: () => "job1",
    },
    request,
  );
  if (params === null) throw new Error("no Workflow params");
  return { jobId, params: params as SandboxEnableJobParams | SandboxDisableJobParams };
}

async function runJob(
  world: ReturnType<typeof fakeSandboxAccount>,
  params: SandboxEnableJobParams | SandboxDisableJobParams,
  release: ArtifactFixture,
  /** Whether the manager has its `SELF` binding (every one since job units). */
  withSelf = true,
) {
  /** Subrequests of the job's own invocation (units count theirs separately). */
  let own = 0;
  const jobFetch: FetchLike = async (input, init) => {
    own += 1;
    return world.fetch(input, init);
  };
  const step = fakeStep();
  const jobEnv: JobEnv = {
    DB: env.DB,
    KV: env.KV,
    CF_API_TOKEN: TOKEN,
    APPFLARE_VERSION: MANAGER_VERSION,
  };
  const self = fakeSelf(jobEnv, { fetch: world.fetch, sleep: async () => {} });
  let error: unknown = null;
  try {
    const run = params.kind === "sandbox_disable" ? runSandboxDisable : runSandboxEnable;
    await run({
      params,
      step,
      env: withSelf ? { ...jobEnv, SELF: self } : jobEnv,
      deps: { fetch: jobFetch, signingKeys: release.keys, sleep: async () => {} },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = 'job1'").first<{
    kind: string;
    status: string;
    error: string | null;
    input_json: string;
  }>();
  const logs = (
    await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'job1' ORDER BY id").all<{
      message: string;
    }>()
  ).results.map((r) => r.message);
  return { error, job, logs, step, self, own };
}

async function enable(
  over: Partial<SandboxAccountState> = {},
  managerOver: Partial<FakeAccount> = {},
  action: "enable" | "update" = "enable",
) {
  const release = await sandboxRelease(VERSION);
  const world = fakeSandboxAccount(release, over, { previews: [healthy], ...managerOver });
  const { params } = await start(world, { action });
  return { world, release, ...(await runJob(world, params, release)) };
}

/** The image of a sandbox Worker release. */
const image = (version: string) => `docker.io/mendylanda/appflare-sandbox:${version}`;

/** The container application of `SANDBOX_CONTAINERS[index]`, as an earlier enable created it. */
function app(
  index: number,
  version: string,
  over: Partial<FakeContainerApp> = {},
): FakeContainerApp {
  const c = SANDBOX_CONTAINERS[index];
  if (c === undefined) throw new Error(`no container ${index}`);
  return {
    id: `existing-${index + 1}`,
    name: c.name,
    max_instances: c.max_instances,
    configuration: { image: image(version), instance_type: c.instance_type },
    durable_objects: { namespace_id: `ns-${c.class_name.toLowerCase()}` },
    reads: 10,
    created: {},
    ...over,
  };
}

/**
 * An account where sandbox builds are on at `version`, as a finished enable
 * leaves it; with `classes` 2, as a sandbox Worker from before the
 * self-deploying container classes left it (migration tag v1).
 */
function enabledAt(version: string, classes: 2 | 4 = 4): Partial<SandboxAccountState> {
  const containers = SANDBOX_CONTAINERS.slice(0, classes);
  return {
    worker: {
      version,
      versionId: "5b000000-0000-4000-8000-000000000009",
      migrationTag: classes === 4 ? "v2" : "v1",
      metadata: {
        bindings: [
          ...containers.map((c) => ({
            type: "durable_object_namespace",
            name: c.class_name,
            class_name: c.class_name,
          })),
          { type: "r2_bucket", name: "BUILDS", bucket_name: "appflare-builds" },
          { type: "plain_text", name: "APPFLARE_VERSION", text: version },
        ],
      },
    },
    namespaces: Object.fromEntries(
      containers.map((c) => [c.class_name, `ns-${c.class_name.toLowerCase()}`]),
    ),
    buckets: new Set(["appflare-builds"]),
    apps: containers.map((_, i) => app(i, version)),
  };
}

const connected = { versionBindings: { [MANAGER_SERVING]: [SANDBOX_SERVICE] } };

describe("enable sandbox builds", () => {
  it("deploys the verified release, its bucket and container applications, then connects Appflare", async () => {
    const r = await enable();
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ kind: "sandbox_enable", status: "succeeded", error: null });
    expect(JSON.parse(r.job?.input_json ?? "null")).toEqual({
      version: VERSION,
      fromVersion: null,
    });

    // The bucket, then the Worker with its classes, migrations and container metadata.
    expect([...r.world.state.buckets]).toEqual(["appflare-builds"]);
    expect(r.world.state.uploads).toHaveLength(1);
    const metadata = r.world.state.uploads[0]?.metadata;
    expect(metadata).toMatchObject({
      main_module: "worker.js",
      keep_bindings: ["secret_text", "secret_key"],
      containers: [
        { name: "appflare-sandbox-standard-1", class_name: "Sandbox" },
        { name: "appflare-sandbox-standard-2", class_name: "LargeSandbox" },
        { name: "appflare-sandbox-self-deploying-standard-1", class_name: "SelfDeployingSandbox" },
        {
          name: "appflare-sandbox-self-deploying-standard-2",
          class_name: "LargeSelfDeployingSandbox",
        },
      ],
      migrations: {
        new_tag: "v2",
        steps: [
          { new_sqlite_classes: ["Sandbox", "LargeSandbox"] },
          { new_sqlite_classes: ["SelfDeployingSandbox", "LargeSelfDeployingSandbox"] },
        ],
      },
      observability: { enabled: true },
    });
    expect(metadata?.bindings).toEqual([
      { type: "durable_object_namespace", name: "Sandbox", class_name: "Sandbox" },
      { type: "durable_object_namespace", name: "LargeSandbox", class_name: "LargeSandbox" },
      {
        type: "durable_object_namespace",
        name: "SelfDeployingSandbox",
        class_name: "SelfDeployingSandbox",
      },
      {
        type: "durable_object_namespace",
        name: "LargeSelfDeployingSandbox",
        class_name: "LargeSelfDeployingSandbox",
      },
      { type: "r2_bucket", name: "BUILDS", bucket_name: "appflare-builds" },
      { type: "plain_text", name: "APPFLARE_VERSION", text: VERSION },
      { type: "version_metadata", name: "CF_VERSION_METADATA" },
    ]);
    expect(r.world.state.subdomainCalls).toEqual([{ enabled: false, previews_enabled: false }]);

    // Every application, bound to the namespace the upload created for its class.
    expect(r.world.state.apps.map((a) => a.created)).toEqual([
      {
        name: "appflare-sandbox-standard-1",
        scheduling_policy: "default",
        observability: { logs: { enabled: true } },
        configuration: {
          image: `docker.io/mendylanda/appflare-sandbox:${VERSION}`,
          instance_type: "standard-1",
        },
        instances: 0,
        max_instances: 2,
        constraints: { tiers: [1, 2] },
        durable_objects: { namespace_id: "ns-sandbox" },
        rollout_active_grace_period: 0,
      },
      expect.objectContaining({
        name: "appflare-sandbox-standard-2",
        max_instances: 1,
        configuration: {
          image: `docker.io/mendylanda/appflare-sandbox:${VERSION}`,
          instance_type: "standard-2",
        },
        durable_objects: { namespace_id: "ns-largesandbox" },
      }),
      expect.objectContaining({
        name: "appflare-sandbox-self-deploying-standard-1",
        max_instances: 2,
        configuration: {
          image: `docker.io/mendylanda/appflare-sandbox:${VERSION}`,
          instance_type: "standard-1",
        },
        durable_objects: { namespace_id: "ns-selfdeployingsandbox" },
      }),
      expect.objectContaining({
        name: "appflare-sandbox-self-deploying-standard-2",
        max_instances: 2,
        configuration: {
          image: `docker.io/mendylanda/appflare-sandbox:${VERSION}`,
          instance_type: "standard-2",
        },
        durable_objects: { namespace_id: "ns-largeselfdeployingsandbox" },
      }),
    ]);

    // Waited for them, then connected Appflare (after the wait, never before).
    const units = r.self.calls.map((c) => c.unit);
    expect(units).toEqual(["uploadWorker", "waitForSandboxContainers", "setSandboxBinding"]);
    expect(r.world.manager.state.versionPatches).toEqual([
      {
        env: {
          SANDBOX: { type: "service", service: "appflare-sandbox", entrypoint: "SandboxBuilds" },
        },
        annotations: {
          "workers/message": "Appflare: connect sandbox builds",
          "workers/tag": MANAGER_SERVING,
        },
      },
    ]);
    expect(r.logs.at(-1)).toMatch(/Sandbox builds are on: the sandbox Worker 0\.1\.2/);
    // Deploying the manager's own Worker is the last thing the job does: the
    // step that connects it also records the job, and no step follows it.
    const managerDeploy = r.world.order.indexOf(`POST /workers/scripts/${MANAGER}/deployments`);
    expect(managerDeploy).toBeGreaterThan(-1);
    expect(r.world.order.slice(managerDeploy + 1)).toEqual([]);
    expect(r.step.names.at(-1)).toBe("connect Appflare to the sandbox Worker");
    // The job's own invocation stays well within the free plan's 50 subrequests.
    expect(r.own).toBeLessThan(30);
  });

  it("changes nothing on an account where the same release is already on and connected", async () => {
    const r = await enable(enabledAt(VERSION), connected);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.world.state.uploads).toEqual([]);
    expect(r.world.state.apps.map((a) => a.id)).toEqual([
      "existing-1",
      "existing-2",
      "existing-3",
      "existing-4",
    ]);
    expect(r.world.state.rollouts).toEqual({});
    expect(r.world.manager.state.versionPatches).toEqual([]);
    expect(r.logs).toContain("The sandbox Worker already runs 0.1.2; it is not uploaded again.");
  });

  it("updates an older sandbox Worker: re-uploads it without migrations and rolls every application", async () => {
    const r = await enable(enabledAt("0.1.1"), connected, "update");
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ kind: "sandbox_update", status: "succeeded" });
    const metadata = r.world.state.uploads[0]?.metadata ?? {};
    // v1 is applied already: no migration is sent again.
    expect(metadata.migrations).toBeUndefined();
    expect(Object.values(r.world.state.rollouts).map((x) => [x.appId, x.body])).toEqual([
      [
        "existing-1",
        {
          description: "Progressive update",
          strategy: "rolling",
          kind: "full_auto",
          target_configuration: {
            image: `docker.io/mendylanda/appflare-sandbox:${VERSION}`,
            instance_type: "standard-1",
          },
          steps: [
            {
              step_size: { percentage: 10 },
              description: "Step 1 of 2 - rollout at 10% of instances",
            },
            {
              step_size: { percentage: 100 },
              description: "Step 2 of 2 - rollout at 100% of instances",
            },
          ],
        },
      ],
      [
        "existing-2",
        expect.objectContaining({
          step_percentage: 100,
          target_configuration: {
            image: `docker.io/mendylanda/appflare-sandbox:${VERSION}`,
            instance_type: "standard-2",
          },
        }),
      ],
      // The self-deploying applications run up to two instances: two steps.
      [
        "existing-3",
        expect.objectContaining({
          steps: [
            expect.objectContaining({ step_size: { percentage: 10 } }),
            expect.objectContaining({ step_size: { percentage: 100 } }),
          ],
          target_configuration: { image: image(VERSION), instance_type: "standard-1" },
        }),
      ],
      [
        "existing-4",
        expect.objectContaining({
          steps: [
            expect.objectContaining({ step_size: { percentage: 10 } }),
            expect.objectContaining({ step_size: { percentage: 100 } }),
          ],
          target_configuration: { image: image(VERSION), instance_type: "standard-2" },
        }),
      ],
    ]);
    // Waited until every rollout completed; Appflare was already connected.
    expect(Object.values(r.world.state.rollouts).map((x) => x.status)).toEqual(
      Array(4).fill("completed"),
    );
    expect(r.world.state.apps.map((a) => a.configuration.image)).toEqual(
      Array(4).fill(image(VERSION)),
    );
    expect(r.world.manager.state.versionPatches).toEqual([]);
  });

  it("adds the self-deploying classes to a sandbox Worker that has only the build classes", async () => {
    const r = await enable(enabledAt("0.1.1", 2), connected, "update");
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ kind: "sandbox_update", status: "succeeded" });
    // The Worker is at v1: only v2 is applied, which creates the new classes.
    expect(r.world.state.uploads[0]?.metadata.migrations).toEqual({
      old_tag: "v1",
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["SelfDeployingSandbox", "LargeSelfDeployingSandbox"] }],
    });
    expect(r.world.state.worker?.migrationTag).toBe("v2");
    // The build applications roll to the new image; the self-deploying ones are created.
    expect(Object.values(r.world.state.rollouts).map((x) => x.appId)).toEqual([
      "existing-1",
      "existing-2",
    ]);
    expect(r.world.state.apps.map((a) => [a.id, a.name, a.durable_objects.namespace_id])).toEqual([
      ["existing-1", "appflare-sandbox-standard-1", "ns-sandbox"],
      ["existing-2", "appflare-sandbox-standard-2", "ns-largesandbox"],
      ["app-3", "appflare-sandbox-self-deploying-standard-1", "ns-selfdeployingsandbox"],
      ["app-4", "appflare-sandbox-self-deploying-standard-2", "ns-largeselfdeployingsandbox"],
    ]);
    expect(r.world.state.apps.map((a) => a.configuration.image)).toEqual(
      Array(4).fill(image(VERSION)),
    );
  });

  it("resumes a rollout an earlier run started instead of starting another", async () => {
    const world = enabledAt("0.1.1");
    const image = `docker.io/mendylanda/appflare-sandbox:${VERSION}`;
    const apps = (world.apps ?? []).map((a) =>
      a.id === "existing-1" ? { ...a, active_rollout_id: "rollout-0" } : a,
    );
    const r = await enable(
      {
        ...world,
        apps,
        rollouts: {
          "rollout-0": {
            appId: "existing-1",
            body: { target_configuration: { image, instance_type: "standard-1" } },
            reads: 0,
            status: "progressing",
          },
        },
      },
      connected,
      "update",
    );
    expect(r.error).toBeNull();
    expect(Object.keys(r.world.state.rollouts)).toEqual([
      "rollout-0",
      "rollout-2",
      "rollout-3",
      "rollout-4",
    ]);
    expect(r.world.state.rollouts["rollout-2"]?.appId).toBe("existing-2");
  });

  it("sends the migration tag the Worker has when a retried upload follows a lost answer", async () => {
    // The first upload applied v1 and v2 but its answer was lost; the retry
    // must not send them as new again (Cloudflare would refuse the tag).
    const r = await enable({ lostUploadReplies: 1 });
    expect(r.error).toBeNull();
    expect(r.world.state.uploads.map((u) => u.metadata.migrations)).toEqual([
      {
        new_tag: "v2",
        steps: [
          { new_sqlite_classes: ["Sandbox", "LargeSandbox"] },
          { new_sqlite_classes: ["SelfDeployingSandbox", "LargeSelfDeployingSandbox"] },
        ],
      },
      undefined,
    ]);
    expect(r.job?.status).toBe("succeeded");
  });

  it("refuses to run without the SELF binding, before anything is created", async () => {
    const release = await sandboxRelease(VERSION);
    const world = fakeSandboxAccount(release);
    const { params } = await start(world, { action: "enable" });
    const r = await runJob(world, params, release, false);
    expect(String(r.error)).toMatch(/no SELF binding/);
    expect(world.state.buckets.size).toBe(0);
    expect(world.state.uploads).toEqual([]);
  });

  it("refuses to start when R2 is not enabled or the token lacks Containers, and says why", async () => {
    const release = await sandboxRelease(VERSION);
    for (const [over, reason] of [
      [{ r2Enabled: false }, /R2 is not enabled on this account/],
      [{ containersAllowed: false }, /token lacks Containers: Edit/],
    ] as const) {
      const world = fakeSandboxAccount(release, over);
      await expect(start(world, { action: "enable" })).rejects.toThrow(reason);
    }
    const count = await env.DB.prepare("SELECT count(*) AS n FROM jobs").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("stops before uploading when the account check fails inside the job", async () => {
    const release = await sandboxRelease(VERSION);
    const world = fakeSandboxAccount(release);
    const { params } = await start(world, { action: "enable" });
    world.state.r2Enabled = false;
    const r = await runJob(world, params, release);
    expect(String(r.error)).toMatch(/check account: R2 is not enabled/);
    expect(r.job?.status).toBe("failed");
    expect(world.state.uploads).toEqual([]);
    expect(r.logs.at(-1)).toMatch(/enable sandbox builds again to continue/);
  });

  it("refuses a release signed with a key that does not sign Appflare releases", async () => {
    const release = await sandboxRelease(VERSION, { keyId: "catalog-test" });
    const world = fakeSandboxAccount(release);
    const { params } = await start(world, { action: "enable" });
    const r = await runJob(world, params, release);
    expect(String(r.error)).toMatch(/does not sign Appflare releases/);
    expect(world.state.uploads).toEqual([]);
    expect(world.state.buckets.size).toBe(0);
  });

  it("leaves a Worker by that name alone when it is not an Appflare sandbox Worker", async () => {
    const r = await enable({
      worker: { version: "?", versionId: "x", migrationTag: null, metadata: { bindings: [] } },
    });
    expect(String(r.error)).toMatch(/is not an Appflare sandbox Worker/);
    expect(r.world.state.uploads).toEqual([]);
  });

  it("starts only while no other job runs", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, kind, status, workflow_instance_id) VALUES ('other', 'install', 'running', 'wf')",
    ).run();
    const release = await sandboxRelease(VERSION);
    const world = fakeSandboxAccount(release);
    await expect(
      startSandboxJobCore(
        {
          db: env.DB,
          client: async () => createClient({ accountId: ACC, token: TOKEN, fetch: world.fetch }),
          workflows: { get: async () => ({ status: async () => ({ status: "running" }) }) },
          createJob: async (id) => ({ id }),
          currentVersion: MANAGER_VERSION,
        },
        { action: "enable" },
      ),
    ).rejects.toThrow(/Another job is queued or running/);
  });
});

describe("disable sandbox builds", () => {
  it("disconnects Appflare, then force-deletes the Worker, every application and the emptied bucket", async () => {
    const release = await sandboxRelease(VERSION);
    const world = fakeSandboxAccount(
      release,
      { ...enabledAt(VERSION), objects: { "appflare-builds": ["builds/i1/1.0.0/a", "logs/b"] } },
      { previews: [healthy], ...connected },
    );
    // A GitHub access token kept on the sandbox Worker goes with it.
    await env.DB.prepare(
      "INSERT INTO github_tokens (id, label, repositories, created_at) VALUES ('01J8TOKEN0000000000000000A', 'acme', 'acme/*', 1)",
    ).run();
    const { params } = await start(world, { action: "disable", confirm: "appflare-sandbox" });
    const r = await runJob(world, params, release);
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ kind: "sandbox_disable", status: "succeeded" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM github_tokens").first<{ n: number }>(),
    ).toEqual({ n: 0 });
    expect(r.logs).toContain(
      "Removed 1 GitHub access token(s): they were kept on the sandbox Worker, which is gone. Add them again after enabling sandbox builds.",
    );
    expect(world.manager.state.versionPatches).toEqual([
      {
        env: { SANDBOX: null },
        annotations: {
          "workers/message": "Appflare: disconnect sandbox builds",
          "workers/tag": MANAGER_SERVING,
        },
      },
    ]);
    expect(world.state.deletes).toEqual([{ force: true }]);
    expect(world.state.worker).toBeNull();
    expect(world.state.apps).toEqual([]);
    expect(world.state.buckets.size).toBe(0);
    // Everything else went first, while the manager still bound the Worker
    // (hence the forced delete); deploying the manager's new version was the
    // last thing the job did, in its last step, which also recorded the job.
    const managerDeploy = world.order.indexOf(`POST /workers/scripts/${MANAGER}/deployments`);
    const workerDelete = world.order.indexOf("DELETE /workers/scripts/appflare-sandbox");
    const bucketDelete = world.order.indexOf("DELETE /r2/buckets/appflare-builds");
    expect(workerDelete).toBeGreaterThan(-1);
    expect(bucketDelete).toBeGreaterThan(workerDelete);
    expect(managerDeploy).toBeGreaterThan(bucketDelete);
    expect(world.order.slice(managerDeploy + 1)).toEqual([]);
    expect(r.step.names.at(-1)).toBe("disconnect Appflare from the sandbox Worker");
    expect(r.logs.at(-1)).toBe(
      "Sandbox builds are off, and nothing of them is left in the account.",
    );
  });

  it("converges when the last step runs again after the manager's deploy cut it off", async () => {
    const release = await sandboxRelease(VERSION);
    const world = fakeSandboxAccount(release, enabledAt(VERSION), {
      previews: [healthy],
      ...connected,
    });
    const { params } = await start(world, { action: "disable", confirm: "appflare-sandbox" });
    const first = await runJob(world, params, release);
    expect(first.error).toBeNull();
    // Running every step again covers the replay, where only the unsaved last
    // one runs: each finds its work done and changes nothing.
    const again = await runJob(world, params, release);
    expect(again.error).toBeNull();
    expect(again.job?.status).toBe("succeeded");
    expect(world.manager.state.versionPatches).toHaveLength(1);
    expect(world.state.deletes).toEqual([{ force: true }]);
  });

  it("finishes what an earlier run left, and needs nothing to be there", async () => {
    const release = await sandboxRelease(VERSION);
    const world = fakeSandboxAccount(release, { buckets: new Set(["appflare-builds"]) });
    const { params } = await start(world, { action: "disable", confirm: "appflare-sandbox" });
    const r = await runJob(world, params, release);
    expect(r.error).toBeNull();
    expect(world.state.deletes).toEqual([]);
    expect(world.state.buckets.size).toBe(0);
  });

  it("needs the sandbox Worker's name typed, and refuses while an app needs the sandbox Worker", async () => {
    const release = await sandboxRelease(VERSION);
    const world = fakeSandboxAccount(release, enabledAt(VERSION));
    await expect(start(world, { action: "disable", confirm: "appflare" })).rejects.toThrow(
      SandboxJobError,
    );
    await seedInstall();
    await env.DB.prepare("UPDATE installs SET build_kind = 'sandbox'").run();
    await expect(start(world, { action: "disable", confirm: "appflare-sandbox" })).rejects.toThrow(
      /in use by the app cut/,
    );
  });
});
