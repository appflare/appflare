import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { startRollbackCore, startUpdateCore } from "../installs/versions.server";
import { buildArtifactFixture } from "../test/artifact-fixture";
import { fakeAccount, NEW_VERSION, SUBDOMAIN, TOKEN } from "../test/fake-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { cacheIndex, INSTALL_ID, OLD_VERSION, seedInstall } from "../test/seed-install";
import { type RollbackJobParams, runRollback } from "./rollback";
import type { JobEnv } from "./run-job";
import { runUpdate, type UpdateJobParams } from "./update";

/**
 * An app whose Worker has no code (a wrangler config with assets and no
 * main): the update uploads a version carrying its assets and no module
 * parts, as wrangler does, and a rollback returns to the snapshot's version.
 */

const jobEnv = (): JobEnv => ({ DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN });

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

async function updateStatic() {
  const fixture = await buildArtifactFixture({
    version: "1.1.0",
    assetsOnly: true,
    assets: [
      { route: "/index.html", content: "<h1>v1.1</h1>" },
      { route: "/app.css", content: "h1 { color: teal }" },
    ],
  });
  expect(fixture.manifest.format).toBe(1);
  const fake = fakeAccount(fixture, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
  });
  await seedInstall({
    manifestJson: JSON.stringify({ version: "1.0.0", worker: { migrations: [] } }),
    resources: [
      { kind: "worker", name: "cut", cfId: "cut" },
      { kind: "subdomain", name: `cut.${SUBDOMAIN}.workers.dev` },
    ],
  });
  await cacheIndex(fixture);
  let params: UpdateJobParams | null = null;
  const started = await startUpdateCore(
    {
      db: env.DB,
      loadApp: async () => fixture.index,
      loadManifest: async () => fixture.manifest,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => "job1",
    },
    { installId: INSTALL_ID, confirmNoPreview: true },
  );
  if (!("jobId" in started) || params === null) throw new Error("no Workflow params");
  const step = fakeStep();
  const self = fakeSelf(jobEnv(), { fetch: fake.fetch });
  await runUpdate({
    params,
    step,
    env: { ...jobEnv(), SELF: self },
    deps: { fetch: fake.fetch, signingKeys: fixture.keys },
  });
  const job = await env.DB.prepare(
    "SELECT status, error, worker_version_id FROM jobs WHERE id = ?1",
  )
    .bind(started.jobId)
    .first<{ status: string; error: string | null; worker_version_id: string | null }>();
  return { fixture, fake, step, self, job };
}

describe("update of a Worker of static assets only", () => {
  it("uploads a version with the assets and no module parts, checks it and promotes it", async () => {
    const r = await updateStatic();
    expect(r.job).toMatchObject({
      status: "succeeded",
      error: null,
      worker_version_id: NEW_VERSION,
    });
    expect(r.step.names).toContain("upload assets bucket 1/1");
    expect(r.step.names).toContain("upload Worker version");
    expect(r.step.names).toContain("canary check 1");
    expect(r.step.names).toContain("promote version");
    const uploaded = r.fake.state.versions.find((v) => v.id === NEW_VERSION);
    expect(uploaded?.modules).toEqual([]);
    // Exactly what wrangler sends for an assets-only Worker: no main_module,
    // no bindings, no keep_bindings.
    expect(uploaded?.metadata).toEqual({
      assets: { jwt: expect.any(String), config: {} },
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      annotations: {
        "workers/message": expect.stringContaining("1.1.0"),
        "workers/tag": "1.1.0",
      },
    });
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
  });

  it("rolls back to the snapshot's version", async () => {
    const r = await updateStatic();
    expect(r.job?.status).toBe("succeeded");
    let params: RollbackJobParams | null = null;
    await startRollbackCore(
      {
        db: env.DB,
        createJob: async (id, p) => {
          params = p;
          return { id };
        },
        newId: () => "rb1",
      },
      { installId: INSTALL_ID, snapshotId: "job1" },
    );
    if (params === null) throw new Error("no rollback params");
    await runRollback({
      params,
      step: fakeStep(),
      env: jobEnv(),
      deps: { fetch: r.fake.fetch },
    });
    const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = 'rb1'").first<{
      status: string;
      error: string | null;
    }>();
    expect(job).toMatchObject({ status: "succeeded", error: null });
    // The fake lists the newest deployment first.
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: OLD_VERSION, percentage: 100 },
    ]);
  });
});
