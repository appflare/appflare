import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type ArtifactManifest, MAX_WORKER_MODULES } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { startUpdateCore } from "../installs/versions.server";
import {
  type ArtifactFixtureOptions,
  buildArtifactFixture,
  ZIP_URL,
} from "../test/artifact-fixture";
import { type FakeAccount, fakeAccount, NEW_VERSION, TOKEN } from "../test/fake-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import {
  cacheIndex,
  INSTALL_ID,
  OLD_MANIFEST,
  OLD_VERSION,
  type SeedResource,
  seedInstall,
} from "../test/seed-install";
import type { JobEnv } from "./run-job";
import { API_STEP } from "./steps";
import { runUpdate, type UpdateJobParams } from "./update";

/**
 * End-to-end test of the update job against a stateful fake of the
 * Cloudflare API (versions, deployments, D1 Time Travel), a Range-capable
 * fake artifact host, and the local D1. The Workflow engine is replaced by
 * `fakeStep` (inline steps, recorded sleeps).
 */

const RESOURCES: SeedResource[] = [
  { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
  { kind: "d1", binding: "DB", name: "cut-db", cfId: "d1-1" },
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
  { kind: "cron", name: "*/5 * * * *" },
  { kind: "subdomain", name: "cut.appflare-dev.workers.dev" },
];

const NEW_APP: ArtifactFixtureOptions = {
  version: "1.1.0",
  bindings: [
    { type: "kv_namespace", name: "CUT_KV" },
    { type: "d1", name: "DB" },
    { type: "kv_namespace", name: "CACHE" },
  ],
  assets: [{ route: "/app.js", content: "console.log('v1.1')" }],
  d1: {
    DB: [
      { name: "0001_init.sql", content: "CREATE TABLE links (id TEXT);" },
      { name: "0002_hits.sql", content: "ALTER TABLE links ADD COLUMN hits INTEGER;" },
    ],
  },
  crons: ["*/10 * * * *"],
};

const jobEnv = (): JobEnv => ({ DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN });

async function update(
  options: ArtifactFixtureOptions = NEW_APP,
  world: Partial<FakeAccount> = {},
  seed: Parameters<typeof seedInstall>[0] = {},
  request: { secrets?: Record<string, string> } = {},
  /** `local`: a manager without the `SELF` binding runs the units in the job's invocation. */
  units: "self" | "local" = "self",
  /** Runs after the install is seeded, before the job starts. */
  afterSeed?: () => Promise<void>,
) {
  const fixture = await buildArtifactFixture(options);
  const fake = fakeAccount(fixture, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    bookmarks: { "d1-1": "00000001-bookmark-before" },
    applied: { "d1-1": ["0001_init.sql"] },
    ...world,
  });
  await seedInstall({ resources: RESOURCES, ...seed });
  await afterSeed?.();
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
    { installId: INSTALL_ID, confirmNoPreview: true, ...request },
  );
  if (!("jobId" in started) || params === null) throw new Error("no Workflow params");
  const { jobId } = started;
  const step = fakeStep();
  const self = fakeSelf(jobEnv(), { fetch: fake.fetch });
  let error: unknown = null;
  try {
    await runUpdate({
      params,
      step,
      env: units === "self" ? { ...jobEnv(), SELF: self } : jobEnv(),
      deps: { fetch: fake.fetch, signingKeys: fixture.keys },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(jobId).first<{
    status: string;
    error: string | null;
    worker_version_id: string | null;
    input_json: string | null;
  }>();
  const install = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<Record<string, unknown>>();
  const snapshot = await env.DB.prepare("SELECT * FROM snapshots WHERE job_id = ?1")
    .bind(jobId)
    .first<Record<string, unknown>>();
  const resources = (
    await env.DB.prepare(
      "SELECT kind, binding, name, cf_id, deleted_at FROM resources WHERE install_id = ?1 ORDER BY rowid",
    )
      .bind(INSTALL_ID)
      .all<Record<string, unknown>>()
  ).results;
  const logs = (
    await env.DB.prepare(
      "SELECT level, message, data_json FROM job_logs WHERE job_id = ?1 ORDER BY id",
    )
      .bind(jobId)
      .all<{ level: string; message: string; data_json: string | null }>()
  ).results;
  return { fixture, fake, step, self, error, job, install, snapshot, resources, logs };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("update job", () => {
  it("updates an app end to end: snapshot, new binding, canary, D1, promote, health", async () => {
    const r = await update();
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({
      status: "succeeded",
      error: null,
      worker_version_id: NEW_VERSION,
    });
    expect(r.step.names).toEqual([
      "start",
      "verify artifact manifest",
      "plan update",
      "read current deployment",
      "bookmark D1 cut-db",
      "record snapshot",
      "check KV namespace cut-cache",
      "create KV namespace cut-cache",
      "record KV namespace cut-cache",
      "open assets upload session",
      "upload assets bucket 1/1",
      "look up workers.dev subdomain",
      "upload Worker version",
      "record Worker version",
      "enable version previews",
      "canary check 1",
      "canary check 2",
      "D1 DB: apply migrations",
      "promote version",
      "record promotion",
      "set cron triggers",
      "health check 1",
      "finish",
    ]);
    expect(r.step.sleeps.filter((s) => s.startsWith("canary"))).toEqual(["canary wait 1"]);
    expect(r.step.configs.every((c) => c === API_STEP)).toBe(true);
    // Asset part, version upload, and migration ran as units over SELF.
    expect(r.self.calls.map((c) => c.unit)).toEqual([
      "uploadAssetPart",
      "uploadWorker",
      "applyD1Migrations",
    ]);
    for (const call of r.self.calls) expect(call.subrequests).toBeLessThan(40);

    // The install records the new version and its catalog state.
    expect(r.install).toMatchObject({
      status: "installed",
      catalog_version: "1.1.0",
      current_version_id: NEW_VERSION,
      manifest_json: new TextDecoder().decode(r.fixture.manifestBytes),
      artifact_url: ZIP_URL,
      artifact_digest: r.fixture.digest,
      pin_sha: r.fixture.manifest.source.sha,
      do_migration_tag: null,
    });

    // The snapshot: the version that served, a bookmark per database, the old state.
    expect(r.snapshot).toMatchObject({
      id: "job1",
      install_id: INSTALL_ID,
      worker_version_id: OLD_VERSION,
      d1_bookmarks_json: '{"d1-1":"00000001-bookmark-before"}',
      catalog_version: "1.0.0",
      manifest_json: OLD_MANIFEST,
      artifact_url: "https://artifacts.test/cut/old.zip",
      target_catalog_version: "1.1.0",
    });

    // Every non-secret binding sent explicitly; secrets kept; no DO migrations.
    const [version] = r.fake.state.versions;
    expect(version?.metadata).toEqual({
      main_module: "worker.js",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" },
        { type: "d1", name: "DB", id: "d1-1" },
        { type: "kv_namespace", name: "CACHE", namespace_id: "kv-new-1" },
        { type: "plain_text", name: "HOME_PAGE", text: "admin" },
      ],
      assets: { jwt: "completion-jwt", config: {} },
      keep_bindings: ["secret_text"],
      annotations: { "workers/message": "Appflare: cut 1.1.0", "workers/tag": "1.1.0" },
    });
    expect(version?.modules).toEqual(["worker.js"]);

    // The new binding's resource is recorded; nothing is deleted but the replaced cron.
    expect(r.resources).toContainEqual({
      kind: "kv",
      binding: "CACHE",
      name: "cut-cache",
      cf_id: "kv-new-1",
      deleted_at: null,
    });
    expect(r.resources.filter((x) => x.kind === "cron")).toEqual([
      expect.objectContaining({ name: "*/5 * * * *", deleted_at: expect.any(Number) }),
      expect.objectContaining({ name: "*/10 * * * *", deleted_at: null }),
    ]);
    expect(r.fake.state.schedules).toEqual(["*/10 * * * *"]);

    // The canary probed the version's preview URL before promotion.
    expect(r.fake.state.subdomainCalls).toEqual([{ enabled: true, previews_enabled: true }]);
    expect(r.fake.state.previewHosts[0]).toBe("0a1b2c3d-cut.appflare-dev.workers.dev");
    // Only the new migration file ran, before the promotion.
    expect(r.fake.state.applied["d1-1"]).toEqual(["0001_init.sql", "0002_hits.sql"]);
    expect(r.fake.state.queries.some((q) => q.startsWith("CREATE TABLE links"))).toBe(false);
    const calls = r.fake.state.calls;
    expect(calls.lastIndexOf("POST /d1/database/d1-1/query")).toBeLessThan(
      calls.indexOf("POST /workers/scripts/cut/deployments"),
    );
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
    // Only a rollback forces its deployment.
    expect(r.fake.state.deployForced).toEqual([false]);

    const everything = JSON.stringify(r.logs);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("completion-jwt");
    expect(r.logs.at(-1)?.message).toBe(
      "Updated cut from 1.0.0 to 1.1.0 at https://cut.appflare-dev.workers.dev/ (health: verified (HTTP 200)).",
    );
  });

  it("runs the units in its own invocation when the Worker has no SELF binding", async () => {
    const r = await update(NEW_APP, {}, {}, {}, "local");
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded", worker_version_id: NEW_VERSION });
    expect(r.self.calls).toEqual([]);
    expect(r.fake.state.applied["d1-1"]).toEqual(["0001_init.sql", "0002_hits.sql"]);
  });

  it("fails at the canary without promoting and leaves the uploaded version unpromoted", async () => {
    const r = await update(NEW_APP, { previews: [{ status: 500, body: "boom" }] });
    expect(r.error).toBeInstanceOf(Error);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe("canary check 6: the Worker answered HTTP 500");
    expect(r.job?.worker_version_id).toBe(NEW_VERSION);
    expect(r.step.names.at(-1)).toBe("mark update failed");
    // Nothing promoted, no migration applied, the install back to `installed` as it was.
    expect(r.fake.state.calls).not.toContain("POST /workers/scripts/cut/deployments");
    expect(r.fake.state.applied["d1-1"]).toEqual(["0001_init.sql"]);
    expect(r.install).toMatchObject({
      status: "installed",
      catalog_version: "1.0.0",
      current_version_id: OLD_VERSION,
      manifest_json: OLD_MANIFEST,
    });
    expect(r.snapshot).not.toBeNull();
    expect(r.logs.at(-1)?.message).toBe(
      `Update failed at "canary check 6". Version ${NEW_VERSION} was uploaded but never promoted; the previous version keeps serving all traffic.`,
    );
  });

  it("records the live health check after promotion without failing the update", async () => {
    const r = await update(NEW_APP, { health: [{ status: 503, body: "down" }] });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded", error: null });
    expect(r.install).toMatchObject({
      status: "installed",
      catalog_version: "1.1.0",
      current_version_id: NEW_VERSION,
      health_status: "unhealthy",
    });
    expect(r.install?.health_checked_at).not.toBeNull();
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(12);
    expect(r.logs.some((l) => l.level === "warn" && l.message.includes("server error"))).toBe(true);
    expect(r.logs.at(-1)?.message).toMatch(/\(health: unhealthy \(HTTP 503\)\)\.$/);
  });

  it("records a promoted version even when a step after promotion fails", async () => {
    const r = await update(NEW_APP, {
      failOnce: new Map([["PUT /workers/scripts/cut/schedules", 400]]),
    });
    expect(r.job?.error).toMatch(/^set cron triggers: .*injected failure$/);
    expect(r.install).toMatchObject({
      status: "installed",
      catalog_version: "1.1.0",
      current_version_id: NEW_VERSION,
    });
    expect(r.logs.at(-1)?.message).toMatch(
      new RegExp(`after version ${NEW_VERSION} was promoted: it serves all traffic`),
    );
  });

  it("skips the canary when Cloudflare serves no preview for the version", async () => {
    const r = await update(NEW_APP, { hasPreview: false });
    expect(r.error).toBeNull();
    expect(r.step.names).toContain("skip canary");
    expect(r.step.names).not.toContain("enable version previews");
    expect(r.fake.state.previewHosts).toEqual([]);
    expect(
      r.logs.some((l) => l.level === "warn" && l.message.includes("no version preview URL")),
    ).toBe(true);
  });

  it("falls back to the default when a stored setting is not JSON for a var the new version reads as JSON", async () => {
    // The install stored HOME_PAGE as text ("admin"); this version reads it as JSON.
    const r = await update({
      ...NEW_APP,
      bindings: [...(NEW_APP.bindings ?? []), { type: "json", name: "HOME_PAGE", json: [] }],
      catalog: {
        vars: [
          {
            name: "HOME_PAGE",
            label: "Home page",
            default: '["{{workerName}}"]',
            required: false,
          },
        ],
      },
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const bindings = r.fake.state.versions[0]?.metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings.filter((b) => b.name === "HOME_PAGE")).toEqual([
      { type: "json", name: "HOME_PAGE", json: ["cut"] },
    ]);
    expect(
      r.logs.some(
        (l) =>
          l.level === "warn" &&
          l.message ===
            "The stored value of HOME_PAGE is not valid JSON, but this version of the app reads HOME_PAGE as JSON; the Worker gets the catalog default instead.",
      ),
    ).toBe(true);
  });

  it("deploys a version with new Durable Object migrations in one full upload, without a canary", async () => {
    const r = await update(
      {
        ...NEW_APP,
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "d1", name: "DB" },
          { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
        ],
        migrations: [
          { tag: "v1", new_sqlite_classes: ["Room"] },
          { tag: "v2", renamed_classes: [{ from: "Room", to: "Chat" }] },
        ],
        crons: ["*/5 * * * *"],
      },
      {},
      {
        manifestJson: JSON.stringify({
          worker: { migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }] },
        }),
      },
    );
    expect(r.error).toBeNull();
    expect(r.step.names).toEqual([
      "start",
      "verify artifact manifest",
      "plan update",
      "read current deployment",
      "bookmark D1 cut-db",
      "record snapshot",
      "open assets upload session",
      "upload assets bucket 1/1",
      "look up workers.dev subdomain",
      "D1 DB: apply migrations",
      "skip canary",
      "deploy Worker script",
      "record Worker version",
      "record promotion",
      "health check 1",
      "finish",
    ]);
    expect(r.fake.state.calls).not.toContain("POST /workers/scripts/cut/versions");
    expect(r.fake.state.previewHosts).toEqual([]);
    const metadata = r.fake.state.versions[0]?.metadata;
    expect(metadata?.migrations).toEqual({
      old_tag: "v1",
      new_tag: "v2",
      steps: [{ renamed_classes: [{ from: "Room", to: "Chat" }] }],
    });
    expect(metadata?.keep_bindings).toEqual(["secret_text"]);
    expect(metadata?.assets).toEqual({ jwt: "completion-jwt", config: {} });
    expect(r.job?.worker_version_id).toBe(NEW_VERSION);
    expect(r.install).toMatchObject({
      status: "installed",
      catalog_version: "1.1.0",
      current_version_id: NEW_VERSION,
      do_migration_tag: "v2",
    });
    expect(
      r.logs.some(
        (l) => l.level === "warn" && l.message.includes("changes Durable Object classes"),
      ),
    ).toBe(true);
  });

  it("sets the secrets a new version introduces with the uploaded version", async () => {
    const SECRET = "new-secret-value-DO-NOT-LEAK";
    const r = await update(
      {
        ...NEW_APP,
        catalog: {
          secrets: [
            { name: "ADMIN_PASSWORD", label: "Admin password", generate: true },
            { name: "API_KEY", label: "API key", generate: false },
          ],
        },
      },
      {},
      {},
      { secrets: { API_KEY: SECRET } },
    );
    expect(r.error).toBeNull();
    const bindings = r.fake.state.versions[0]?.metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings).toContainEqual({ type: "secret_text", name: "API_KEY", text: SECRET });
    expect(bindings.some((b) => b.name === "ADMIN_PASSWORD")).toBe(false);
    expect(r.resources).toContainEqual({
      kind: "secret",
      binding: "API_KEY",
      name: "API_KEY",
      cf_id: null,
      deleted_at: null,
    });
    // Values never reach the job record or its log.
    expect(r.job?.input_json).toContain('"secrets":["API_KEY"]');
    expect(JSON.stringify(r.job)).not.toContain(SECRET);
    expect(JSON.stringify(r.logs)).not.toContain(SECRET);
    expect(r.logs.some((l) => l.message === "New secret API_KEY: set with the new version.")).toBe(
      true,
    );
  });

  it("checks the version the app reports at its health path on the preview", async () => {
    const healthPath = {
      ...NEW_APP,
      catalog: {
        install: {
          tier: "artifact" as const,
          packageManager: "pnpm" as const,
          wranglerConfig: "wrangler.jsonc",
          workerName: "cut",
          healthPath: "/api/health",
        },
      },
    };
    const wrong = await update(healthPath, {
      previews: [{ status: 200, body: '{"ok":true,"version":"1.0.0"}' }],
    });
    expect(wrong.job?.error).toBe(
      "canary check 1: GET https://0a1b2c3d-cut.appflare-dev.workers.dev/api/health: the app reports version 1.0.0, not 1.1.0",
    );
    expect(wrong.fake.state.calls).not.toContain("POST /workers/scripts/cut/deployments");

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    const right = await update(healthPath, {
      previews: [{ status: 200, body: '{"ok":true,"version":"1.1.0"}' }],
    });
    expect(right.error).toBeNull();
    expect(right.logs.at(-1)?.message).toContain(
      "at https://cut.appflare-dev.workers.dev/api/health",
    );
  });

  it("names the migrated databases when the promotion fails after D1 migrations", async () => {
    const r = await update(NEW_APP, {
      failOnce: new Map([["POST /workers/scripts/cut/deployments", 400]]),
    });
    expect(r.job?.error).toMatch(/^promote version: /);
    expect(r.fake.state.applied["d1-1"]).toEqual(["0001_init.sql", "0002_hits.sql"]);
    expect(r.install).toMatchObject({ current_version_id: OLD_VERSION, catalog_version: "1.0.0" });
    expect(
      r.logs.some((l) =>
        l.message.startsWith(
          "The D1 database cut-db is already migrated to the new schema while the previous code still serves.",
        ),
      ),
    ).toBe(true);
  });

  it("sends no migrations when the Worker already has every one", async () => {
    const migrations = [{ tag: "v1", new_sqlite_classes: ["Room"] }];
    const r = await update(
      {
        ...NEW_APP,
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
        ],
        migrations,
      },
      { hasPreview: false },
      { manifestJson: JSON.stringify({ worker: { migrations } }) },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.versions[0]?.metadata.migrations).toBeUndefined();
    // Cloudflare serves no preview for Workers that implement a Durable Object.
    expect(r.logs.some((l) => l.message.includes("no version preview URL"))).toBe(true);
    expect(r.step.names).toContain("skip canary");
    expect(r.install).toMatchObject({ do_migration_tag: "v1" });
    expect(r.resources).toContainEqual(
      expect.objectContaining({ kind: "durable_object", binding: "ROOMS", name: "Room" }),
    );
  });

  it("refuses a version that is no longer the catalog's current one", async () => {
    const fixture = await buildArtifactFixture(NEW_APP);
    const newer = await buildArtifactFixture({ ...NEW_APP, version: "1.2.0" });
    const fake = fakeAccount(fixture);
    await seedInstall({ resources: RESOURCES, status: "updating" });
    await cacheIndex(newer);
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('job1', ?1, 'update', 'queued')",
    )
      .bind(INSTALL_ID)
      .run();
    await expect(
      runUpdate({
        params: { kind: "update", jobId: "job1", installId: INSTALL_ID, version: "1.1.0" },
        step: fakeStep(),
        env: jobEnv(),
        deps: { fetch: fake.fetch, signingKeys: fixture.keys },
      }),
    ).rejects.toThrow(/not the catalog's current version/);
    const job = await env.DB.prepare("SELECT status, error FROM jobs WHERE id = 'job1'").first();
    expect(job).toEqual({
      status: "failed",
      error: "start: 1.1.0 is not the catalog's current version of the app (1.2.0)",
    });
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = ?1")
      .bind(INSTALL_ID)
      .first();
    expect(install).toEqual({ status: "installed" });
    expect(fake.state.calls).toEqual([]);
  });

  it("refuses a version with more modules than one upload can fetch, before snapshotting", async () => {
    const r = await update({
      ...NEW_APP,
      tweak: (m) => {
        const first = m.worker.modules[0];
        if (first === undefined) throw new Error("the fixture has no module");
        for (let i = 1; i <= MAX_WORKER_MODULES; i++) {
          m.worker.modules.push({ ...first, name: `chunk-${i}.js` });
        }
      },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      `plan update: This version has ${MAX_WORKER_MODULES + 1} Worker modules, but one upload can fetch at most ${MAX_WORKER_MODULES} within the free plan's 50 subrequests per invocation (2 per module from a release asset). It must be built as ${MAX_WORKER_MODULES} or fewer modules, for example as one bundled module.`,
    );
    expect(r.step.names).not.toContain("read current deployment");
    expect(r.fake.state.calls).toEqual([]);
    expect(r.snapshot).toBeNull();
  });

  it("refuses a version that reshapes a kept Vectorize index, before snapshotting", async () => {
    const vectorize = (dimensions: number) => ({
      type: "vectorize" as const,
      name: "VECTORIZE",
      dimensions,
      metric: "cosine" as const,
    });
    const r = await update(
      { ...NEW_APP, bindings: [...(NEW_APP.bindings ?? []), vectorize(768)] },
      {},
      {
        resources: [
          ...RESOURCES,
          { kind: "vectorize", binding: "VECTORIZE", name: "cut-vectorize", cfId: "cut-vectorize" },
        ],
        manifestJson: JSON.stringify({
          version: "1.0.0",
          worker: { migrations: [], bindings: [vectorize(384)] },
        }),
      },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      'plan update: Binding VECTORIZE uses the Vectorize index "cut-vectorize", created with 384 dimensions (cosine); this version needs 768 dimensions (cosine). A Vectorize index cannot be reshaped in place, so this version needs a fresh install.',
    );
    expect(r.step.names).not.toContain("read current deployment");
    expect(r.fake.state.calls).toEqual([]);
    expect(r.snapshot).toBeNull();
  });

  it("keeps each rate limit's namespace across updates and gives a new one its own", async () => {
    const limit = { simple: { limit: 20, period: 60 }, namespace_id: "1001" };
    const r = await update(
      {
        ...NEW_APP,
        bindings: [
          ...(NEW_APP.bindings ?? []),
          { type: "ratelimit", name: "LIMITER", ...limit },
          { type: "ratelimit", name: "LOGIN", ...limit },
        ],
      },
      {},
      {
        resources: [
          ...RESOURCES,
          { kind: "ratelimit", binding: "LIMITER", name: "LIMITER", cfId: "555001" },
        ],
      },
    );
    expect(r.error).toBeNull();
    const bindings = r.fake.state.versions[0]?.metadata.bindings as Array<Record<string, unknown>>;
    const sent = Object.fromEntries(
      bindings.filter((b) => b.type === "ratelimit").map((b) => [b.name, b.namespace_id]),
    );
    expect(sent.LIMITER).toBe("555001");
    expect(sent.LOGIN).toMatch(/^[1-9]\d*$/);
    expect(sent.LOGIN).not.toBe("1001");
    expect(r.resources).toContainEqual(
      expect.objectContaining({ kind: "ratelimit", binding: "LOGIN", cf_id: sent.LOGIN }),
    );
  });

  describe("queue consumers", () => {
    const QUEUE_RESOURCES: SeedResource[] = [
      ...RESOURCES,
      { kind: "queue", binding: "JOBS", name: "cut-jobs", cfId: "q-jobs" },
      { kind: "queue", binding: "EXPORT", name: "cut-export", cfId: "q-export" },
      { kind: "queue_consumer", binding: "JOBS", name: "cut-jobs", cfId: "c-jobs" },
      { kind: "queue_consumer", binding: "EXPORT", name: "cut-export", cfId: "c-export" },
    ];
    const installedManifest = JSON.stringify({
      version: "1.0.0",
      worker: {
        migrations: [],
        queueConsumers: [
          { queue: { binding: "JOBS" }, max_batch_size: 10 },
          { queue: { binding: "EXPORT" }, max_retries: 2 },
        ],
      },
    });
    const withConsumers = (
      queueConsumers: NonNullable<ArtifactManifest["worker"]["queueConsumers"]>,
    ): ArtifactFixtureOptions => ({
      ...NEW_APP,
      bindings: [
        ...(NEW_APP.bindings ?? []),
        { type: "queue", name: "JOBS" },
        { type: "queue", name: "EXPORT" },
      ],
      tweak: (m) => {
        m.worker.queueConsumers = queueConsumers;
      },
    });
    const account = (): Partial<FakeAccount> => ({
      queues: [
        { queue_id: "q-jobs", queue_name: "cut-jobs" },
        { queue_id: "q-export", queue_name: "cut-export" },
      ],
      consumers: {
        "q-jobs": [
          {
            consumer_id: "c-jobs",
            type: "worker",
            script_name: "cut",
            settings: { batch_size: 10 },
          },
        ],
        "q-export": [
          {
            consumer_id: "c-export",
            type: "worker",
            script_name: "cut",
            settings: { max_retries: 2 },
          },
        ],
      },
    });

    it("replaces changed settings, attaches new consumers, and removes dropped ones after promotion", async () => {
      const r = await update(
        withConsumers([
          {
            queue: { binding: "JOBS" },
            max_batch_size: 5,
            dead_letter_queue: { name: "jobs-dlq" },
          },
          { queue: { name: "jobs-dlq" } },
        ]),
        account(),
        { resources: QUEUE_RESOURCES, manifestJson: installedManifest },
      );
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      const calls = r.fake.state.calls;
      expect(calls).toContain("POST /queues");
      expect(calls.indexOf("PUT /queues/q-jobs/consumers/c-jobs")).toBeGreaterThan(
        calls.indexOf(`POST /workers/scripts/cut/deployments`),
      );
      expect(r.fake.state.consumers).toEqual({
        "q-jobs": [
          {
            consumer_id: "c-jobs",
            type: "worker",
            script_name: "cut",
            dead_letter_queue: "cut-jobs-dlq",
            settings: { batch_size: 5 },
          },
        ],
        "q-export": [],
        "q-new-3": [{ consumer_id: "c-q-new-3-1", type: "worker", script_name: "cut" }],
      });
      expect(r.resources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "queue", binding: null, name: "cut-jobs-dlq" }),
          expect.objectContaining({
            kind: "queue_consumer",
            name: "cut-export",
            deleted_at: expect.any(Number),
          }),
          expect.objectContaining({
            kind: "queue_consumer",
            name: "cut-jobs-dlq",
            cf_id: "c-q-new-3-1",
            deleted_at: null,
          }),
        ]),
      );
    });

    it("attaches a consumer again that an earlier update removed, reviving its record", async () => {
      const r = await update(
        withConsumers([
          { queue: { binding: "JOBS" }, max_batch_size: 10 },
          { queue: { binding: "EXPORT" }, max_retries: 2 },
        ]),
        { ...account(), consumers: { "q-jobs": account().consumers?.["q-jobs"] ?? [] } },
        {
          resources: QUEUE_RESOURCES.filter((q) => q.name !== "cut-export" || q.kind === "queue"),
          manifestJson: installedManifest,
        },
        {},
        "self",
        async () => {
          await env.DB.prepare(
            `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at, deleted_at)
             VALUES ('i1:queue_consumer:EXPORT', 'i1', 'queue_consumer', NULL, 'cut-export', 'c-old', 1, 2)`,
          ).run();
        },
      );
      expect(r.error).toBeNull();
      expect(r.fake.state.consumers["q-export"]).toEqual([
        {
          type: "worker",
          script_name: "cut",
          settings: { max_retries: 2 },
          consumer_id: "c-q-export-1",
        },
      ]);
      expect(r.resources).toContainEqual(
        expect.objectContaining({
          kind: "queue_consumer",
          name: "cut-export",
          cf_id: "c-q-export-1",
          deleted_at: null,
        }),
      );
    });

    it("makes no consumer call when nothing about them changed", async () => {
      const r = await update(
        withConsumers([
          { queue: { binding: "JOBS" }, max_batch_size: 10 },
          { queue: { binding: "EXPORT" }, max_retries: 2 },
        ]),
        account(),
        { resources: QUEUE_RESOURCES, manifestJson: installedManifest },
      );
      expect(r.error).toBeNull();
      expect(r.fake.state.calls.filter((c) => c.includes("/consumers"))).toEqual([]);
    });
  });

  it("refuses a gradual deployment in progress before snapshotting", async () => {
    const r = await update(NEW_APP, {
      deployments: [
        {
          id: "dep-1",
          versions: [
            { version_id: OLD_VERSION, percentage: 90 },
            { version_id: "other", percentage: 10 },
          ],
        },
      ],
    });
    expect(r.job?.error).toMatch(/^read current deployment: no single version serves/);
    expect(r.snapshot).toBeNull();
  });
});
