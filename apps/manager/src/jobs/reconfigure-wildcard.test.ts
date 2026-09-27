import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { startVarsRefreshCore } from "../installs/reconfigure.server";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  baseCatalog,
  buildArtifactFixture,
  ZIP_URL,
} from "../test/artifact-fixture";
import { fakeAccount, TOKEN } from "../test/fake-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { INSTALL_ID, OLD_VERSION, type SeedResource, seedInstall } from "../test/seed-install";
import { unservedWildcardPhase } from "./install/domain";
import { type ReconfigureJobParams, runReconfigure } from "./reconfigure";
import type { JobEnv } from "./run-job";
import { createJobSteps } from "./steps";

/**
 * `{{wildcardHostname}}` following the wildcard domain: assigning or removing
 * it starts the settings change job with the stored settings unchanged, and
 * the job deploys the serving version again with the var filled in anew.
 */

const BASE = "tunnels.example.com";

const TUNNEL_APP: ArtifactFixtureOptions = {
  bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
  catalog: {
    install: {
      ...baseCatalog().install,
      wildcardHostname: true,
      wildcardReason: "Each tunnel gets its own address under this hostname.",
    },
    vars: [
      {
        name: "TUNNEL_DOMAIN",
        label: "Tunnel domain",
        default: "{{wildcardHostname}}",
        required: false,
      },
    ],
  },
};

const RESOURCES: SeedResource[] = [
  { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
  { kind: "worker", name: "cut", cfId: "cut" },
];

async function seed(fixture: ArtifactFixture, resources: SeedResource[]): Promise<void> {
  await seedInstall({ manifestJson: new TextDecoder().decode(fixture.manifestBytes), resources });
  await env.DB.prepare(
    "UPDATE installs SET artifact_url = ?2, artifact_digest = ?3, config_json = '{}' WHERE id = ?1",
  )
    .bind(INSTALL_ID, ZIP_URL, fixture.digest)
    .run();
}

async function refresh(app: ArtifactFixtureOptions, resources: SeedResource[]) {
  const fixture = await buildArtifactFixture(app);
  await seed(fixture, resources);
  let params: ReconfigureJobParams | null = null;
  const started = await startVarsRefreshCore(
    {
      db: env.DB,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => "job1",
    },
    INSTALL_ID,
  );
  return { fixture, started, params: params as ReconfigureJobParams | null };
}

async function run(fixture: ArtifactFixture, params: ReconfigureJobParams) {
  const fake = fakeAccount(fixture, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    uploadedAssets: new Set(fixture.manifest.assets.files.map((f) => f.hash)),
  });
  const jobEnv: JobEnv = { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN };
  const step = fakeStep();
  await runReconfigure({
    params,
    step,
    env: { ...jobEnv, SELF: fakeSelf(jobEnv, { fetch: fake.fetch }) },
    deps: { fetch: fake.fetch, signingKeys: fixture.keys },
  });
  const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = 'job1'").first();
  const logs = (
    await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = 'job1' ORDER BY id").all<{
      message: string;
    }>()
  ).results.map((l) => l.message);
  const [uploaded] = fake.state.versions;
  const bindings = (uploaded?.metadata.bindings ?? []) as Array<Record<string, unknown>>;
  return { job, logs, tunnelDomain: bindings.find((b) => b.name === "TUNNEL_DOMAIN") };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("settings that use {{wildcardHostname}}", () => {
  it("are deployed again with the wildcard domain once it is assigned", async () => {
    const { fixture, started, params } = await refresh(TUNNEL_APP, [
      ...RESOURCES,
      { kind: "wildcard_domain", name: BASE, cfId: "z1" },
    ]);
    expect(started).toEqual({ jobId: "job1" });
    expect(params).toMatchObject({
      kind: "reconfigure",
      vars: {},
      secrets: { set: {}, unset: [] },
      refreshVars: true,
    });
    const input = await env.DB.prepare(
      "SELECT kind, input_json FROM jobs WHERE id = 'job1'",
    ).first<{
      kind: string;
      input_json: string;
    }>();
    expect(input?.kind).toBe("reconfigure");
    expect(JSON.parse(input?.input_json ?? "{}")).toMatchObject({ refreshVars: true, vars: [] });

    if (params === null) throw new Error("no Workflow params");
    const r = await run(fixture, params);
    expect(r.job).toEqual({ status: "succeeded", error: null });
    expect(r.tunnelDomain).toEqual({ type: "plain_text", name: "TUNNEL_DOMAIN", text: BASE });
    expect(r.logs).toContain(
      `Settings that use {{wildcardHostname}} are filled in again: ${BASE}.`,
    );
  });

  it("are deployed again empty once the wildcard domain is removed", async () => {
    const { fixture, params } = await refresh(TUNNEL_APP, RESOURCES);
    if (params === null) throw new Error("no Workflow params");
    const r = await run(fixture, params);
    expect(r.job).toEqual({ status: "succeeded", error: null });
    expect(r.tunnelDomain).toEqual({ type: "plain_text", name: "TUNNEL_DOMAIN", text: "" });
  });

  it("start nothing when no setting uses it", async () => {
    const plain: ArtifactFixtureOptions = {
      ...TUNNEL_APP,
      catalog: { ...TUNNEL_APP.catalog, vars: [] },
    };
    const { started, params } = await refresh(plain, RESOURCES);
    expect(started).toBeNull();
    expect(params).toBeNull();
    expect((await env.DB.prepare("SELECT id FROM jobs").all()).results).toEqual([]);
  });

  it("are deployed again when only another Worker of the app uses it", async () => {
    // The other Worker's own wrangler config names the base; the primary Worker has no such var.
    // A copy: the fixture writes the entry's Workers into the catalog it is given.
    const app = structuredClone(TUNNEL_APP);
    const two: ArtifactFixtureOptions = {
      ...app,
      catalog: { ...app.catalog, vars: [] },
      otherWorkers: [
        {
          name: "jobs",
          bindings: [{ type: "plain_text", name: "TUNNEL_DOMAIN", text: "{{wildcardHostname}}" }],
        },
      ],
    };
    const { started, params } = await refresh(two, [
      ...RESOURCES,
      { kind: "worker", name: "cut-jobs", cfId: "cut-jobs" },
      { kind: "wildcard_domain", name: BASE, cfId: "z1" },
    ]);
    expect(started).toEqual({ jobId: "job1" });
    expect(params).toMatchObject({ kind: "reconfigure", refreshVars: true });
  });

  it("are deployed again after an install whose wildcard domain was not set up", async () => {
    const fixture = await buildArtifactFixture(TUNNEL_APP);
    await seed(fixture, RESOURCES);
    const created: Array<{ id: string; params: unknown }> = [];
    const installJob = "job-install";
    // The install job, finished: the settings change may start now.
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES (?1, ?2, 'install', 'succeeded')",
    )
      .bind(installJob, INSTALL_ID)
      .run();
    const steps = createJobSteps(
      {
        params: { kind: "install", jobId: installJob },
        step: fakeStep(),
        env: { DB: env.DB },
        deps: {},
      },
      installJob,
    );
    const jobsBinding = {
      create: async (options: { id: string; params: unknown }) => {
        created.push(options);
        return { id: options.id };
      },
    };
    await unservedWildcardPhase(
      steps,
      { DB: env.DB, JOBS: jobsBinding },
      { installId: INSTALL_ID, hostname: BASE },
    );
    expect(created).toEqual([
      {
        id: expect.any(String),
        params: expect.objectContaining({ kind: "reconfigure", refreshVars: true }),
      },
    ]);
    const logs = (
      await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = ?1").bind(installJob).all()
    ).results.map((l) => l.message);
    expect(logs).toContainEqual(expect.stringContaining(`named ${BASE}, which it does not serve`));
    // Nobody clicked it: the jobs list shows it as automatic.
    const refreshJob = await env.DB.prepare(
      "SELECT started_by FROM jobs WHERE kind = 'reconfigure'",
    ).first<{ started_by: string }>();
    expect(refreshJob?.started_by).toBe("schedule");

    // Once the domain is recorded, the settings already name what the app serves.
    created.length = 0;
    await env.DB.prepare("DELETE FROM jobs WHERE kind = 'reconfigure'").run();
    await env.DB.prepare(
      "INSERT INTO resources (id, install_id, kind, name, cf_id, created_at) VALUES ('w1', ?1, 'wildcard_domain', ?2, 'z1', 0)",
    )
      .bind(INSTALL_ID, BASE)
      .run();
    await unservedWildcardPhase(
      steps,
      { DB: env.DB, JOBS: jobsBinding },
      { installId: INSTALL_ID, hostname: BASE },
    );
    expect(created).toEqual([]);
  });

  it("start nothing when the admin replaced the default with a fixed name", async () => {
    const fixture = await buildArtifactFixture(TUNNEL_APP);
    await seed(fixture, RESOURCES);
    await env.DB.prepare("UPDATE installs SET config_json = ?2 WHERE id = ?1")
      .bind(INSTALL_ID, JSON.stringify({ TUNNEL_DOMAIN: "fixed.example.org" }))
      .run();
    const started = await startVarsRefreshCore(
      { db: env.DB, createJob: async (id) => ({ id }), newId: () => "job1" },
      INSTALL_ID,
    );
    expect(started).toBeNull();
  });
});
