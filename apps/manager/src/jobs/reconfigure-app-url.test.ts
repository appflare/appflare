import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { startVarsRefreshCore } from "../installs/reconfigure.server";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  buildArtifactFixture,
  ZIP_URL,
} from "../test/artifact-fixture";
import { fakeAccount, TOKEN } from "../test/fake-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { INSTALL_ID, OLD_VERSION, type SeedResource, seedInstall } from "../test/seed-install";
import { servedAddressPhase } from "./install/domain";
import { type ReconfigureJobParams, runReconfigure } from "./reconfigure";
import type { JobEnv } from "./run-job";
import { createJobSteps } from "./steps";

/**
 * `{{appUrl}}` following the address the app is served at: when a domain
 * takes over from workers.dev (or workers.dev from a domain), the settings
 * change job deploys the serving version again with the var filled in with
 * the new address. `{{workerUrl}}` stays the workers.dev address throughout.
 */

const DOMAIN = "links.example.com";
const WORKERS_DEV = "https://cut.appflare-dev.workers.dev";

const APP: ArtifactFixtureOptions = {
  bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
  catalog: {
    vars: [
      { name: "PUBLIC_URL", label: "Public address", default: "{{appUrl}}", optional: true },
      { name: "PUBLIC_HOST", label: "Public host", default: "{{appHostname}}", optional: true },
      { name: "DEV_URL", label: "workers.dev address", default: "{{workerUrl}}", optional: true },
    ],
  },
};

const RESOURCES: SeedResource[] = [
  { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "domain", name: DOMAIN, cfId: "dom-1" },
];

async function seed(fixture: ArtifactFixture, served: string | null): Promise<void> {
  await seedInstall({
    manifestJson: new TextDecoder().decode(fixture.manifestBytes),
    resources: RESOURCES,
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE installs SET artifact_url = ?2, artifact_digest = ?3, config_json = '{}', workers_dev_enabled = ?4, served_domain = ?5 WHERE id = ?1",
    ).bind(INSTALL_ID, ZIP_URL, fixture.digest, served === null ? 1 : 0, served),
    env.DB.prepare("UPDATE resources SET live_at = 1 WHERE kind = 'domain'"),
  ]);
}

async function refresh(app: ArtifactFixtureOptions, served: string | null) {
  const fixture = await buildArtifactFixture(app);
  await seed(fixture, served);
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
    ["appUrl"],
  );
  return { fixture, started, params: params as ReconfigureJobParams | null };
}

async function run(fixture: ArtifactFixture, params: ReconfigureJobParams) {
  const fake = fakeAccount(fixture, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    uploadedAssets: new Set(fixture.manifest.assets.files.map((f) => f.hash)),
    domainHealth: { [DOMAIN]: [{ status: 200, body: "ok" }] },
  });
  const jobEnv: JobEnv = { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN };
  await runReconfigure({
    params,
    step: fakeStep(),
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
  const text = (name: string) => bindings.find((b) => b.name === name)?.text;
  return { job, logs, text };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("settings that use {{appUrl}}", () => {
  it("are deployed again with the domain once it serves the app, workers.dev off", async () => {
    const { fixture, started, params } = await refresh(APP, DOMAIN);
    expect(started).toEqual({ jobId: "job1" });
    expect(params).toMatchObject({ kind: "reconfigure", vars: {}, refreshVars: ["appUrl"] });
    if (params === null) throw new Error("no Workflow params");
    const r = await run(fixture, params);
    expect(r.job).toEqual({ status: "succeeded", error: null });
    expect(r.text("PUBLIC_URL")).toBe(`https://${DOMAIN}`);
    expect(r.text("PUBLIC_HOST")).toBe(DOMAIN);
    // The workers.dev address never follows a domain.
    expect(r.text("DEV_URL")).toBe(WORKERS_DEV);
    expect(r.logs).toContain(
      "Settings that use the app's address ({{appUrl}}) are filled in again with the domain that serves it now.",
    );
  });

  it("are deployed again with workers.dev once it serves the app again", async () => {
    const { fixture, params } = await refresh(APP, null);
    if (params === null) throw new Error("no Workflow params");
    const r = await run(fixture, params);
    expect(r.job).toEqual({ status: "succeeded", error: null });
    expect(r.text("PUBLIC_URL")).toBe(WORKERS_DEV);
    expect(r.text("PUBLIC_HOST")).toBe("cut.appflare-dev.workers.dev");
    expect(r.logs).toContain(
      "Settings that use the app's address ({{appUrl}}) are filled in again with its workers.dev URL, since workers.dev serves it now.",
    );
  });

  it("start nothing when the settings name only the workers.dev address, or no address", async () => {
    const workersDevOnly: ArtifactFixtureOptions = {
      ...APP,
      catalog: {
        vars: [{ name: "DEV_URL", label: "Dev", default: "{{workerUrl}}", optional: true }],
      },
    };
    const { started, params } = await refresh(workersDevOnly, DOMAIN);
    expect(started).toBeNull();
    expect(params).toBeNull();
    expect((await env.DB.prepare("SELECT id FROM jobs").all()).results).toEqual([]);
  });

  it("start nothing when the admin replaced the default with a fixed address", async () => {
    const fixture = await buildArtifactFixture(APP);
    await seed(fixture, DOMAIN);
    await env.DB.prepare("UPDATE installs SET config_json = ?2 WHERE id = ?1")
      .bind(
        INSTALL_ID,
        JSON.stringify({
          PUBLIC_URL: "https://fixed.example.org",
          PUBLIC_HOST: "fixed.example.org",
        }),
      )
      .run();
    const started = await startVarsRefreshCore(
      { db: env.DB, createJob: async (id) => ({ id }), newId: () => "job1" },
      INSTALL_ID,
      ["appUrl"],
    );
    expect(started).toBeNull();
  });

  it("are deployed again after an install whose domain took over from workers.dev", async () => {
    const fixture = await buildArtifactFixture(APP);
    await seed(fixture, DOMAIN);
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
    const created: Array<{ id: string; params: unknown }> = [];
    await servedAddressPhase(
      steps,
      {
        DB: env.DB,
        JOBS: {
          create: async (options: { id: string; params: unknown }) => {
            created.push(options);
            return { id: options.id };
          },
        },
      },
      { installId: INSTALL_ID, hostname: DOMAIN },
    );
    expect(created).toEqual([
      {
        id: expect.any(String),
        params: expect.objectContaining({ kind: "reconfigure", refreshVars: ["appUrl"] }),
      },
    ]);
    const logs = (
      await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = ?1").bind(installJob).all()
    ).results.map((l) => l.message);
    expect(logs).toContainEqual(expect.stringContaining(`which is https://${DOMAIN} now`));
    const refreshJob = await env.DB.prepare(
      "SELECT started_by FROM jobs WHERE kind = 'reconfigure'",
    ).first<{ started_by: string }>();
    expect(refreshJob?.started_by).toBe("schedule");
  });
});
