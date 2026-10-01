import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import {
  type ArtifactManifest,
  generateVapidPrivateKey,
  vapidPublicKey,
  withRevisedCatalog,
} from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { protectInstall } from "../access/protect.server";
import { readCatalogRevision } from "../catalog/revisions.server";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { listSnapshotsCore, startRollbackCore, startUpdateCore } from "../installs/versions.server";
import { accessLoginUrl } from "../test/access-sign-in";
import {
  type ArtifactFixtureOptions,
  baseCatalog,
  buildArtifactFixture,
  ZIP_URL,
} from "../test/artifact-fixture";
import { fakeAccessAccount } from "../test/fake-access-account";
import {
  DEFAULT_MULTIPART_RULE,
  type FakeAccount,
  fakeAccount,
  NEW_VERSION,
  SUBDOMAIN,
  TOKEN,
} from "../test/fake-account";
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
import { entryJobCost, otherWorkerCost } from "./entry-budget";
import { entryWorkers } from "./entry-workers";
import { type RollbackJobParams, runRollback } from "./rollback";
import type { JobEnv } from "./run-job";
import { API_STEP } from "./steps";
import { CANARY_MAX_ATTEMPTS, runUpdate, type UpdateJobParams } from "./update";

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
  request: { secrets?: Record<string, string>; paidConfirmed?: boolean } = {},
  /** `local`: a manager without the `SELF` binding runs the units in the job's invocation. */
  units: "self" | "local" = "self",
  /** Runs after the install is seeded, before the job starts. */
  afterSeed?: () => Promise<void>,
  /** Wraps the fake's fetch (to change the account while the job runs). */
  wrapFetch?: (fake: ReturnType<typeof fakeAccount>) => FetchLike,
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
      // As getAppManifest reads it: the form of the revision, when listed.
      loadManifest: async () =>
        fixture.revised === null
          ? fixture.manifest
          : withRevisedCatalog(fixture.manifest, fixture.revised.catalog),
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
  const fetch = wrapFetch?.(fake) ?? fake.fetch;
  const self = fakeSelf(jobEnv(), { fetch });
  let error: unknown = null;
  try {
    await runUpdate({
      params,
      step,
      env: units === "self" ? { ...jobEnv(), SELF: self } : jobEnv(),
      deps: { fetch, signingKeys: fixture.keys },
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
      pin_sha: r.fixture.manifest.catalog.source.sha,
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
      annotations: {
        "workers/message": "Appflare: cut 1.1.0 (update job1)",
        "workers/tag": "1.1.0",
      },
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
    // It introduced no secret, so there is nothing to take off the newest version.
    expect(r.fake.state.versionPatches).toEqual([]);
    expect(r.step.names).not.toContain("put back the previous secrets");
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
            optional: true,
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

  it("deploys a version whose exports differ from the serving one in one full upload", async () => {
    const r = await update(
      {
        ...NEW_APP,
        crons: ["*/5 * * * *"],
        exports: {
          Room: { type: "durable-object", storage: "sqlite" },
          Chat: { type: "durable-object", storage: "sqlite" },
        },
        cacheOptions: { enabled: true },
      },
      {},
      {
        manifestJson: JSON.stringify({
          worker: {
            migrations: [],
            exports: { Room: { type: "durable-object", storage: "sqlite" } },
          },
        }),
      },
    );
    expect(r.error).toBeNull();
    expect(r.step.names).toContain("deploy Worker script");
    expect(r.step.names).not.toContain("upload Worker version");
    expect(r.fake.state.calls).not.toContain("POST /workers/scripts/cut/versions");
    const metadata = r.fake.state.versions[0]?.metadata;
    expect(metadata?.exports).toEqual({
      Room: { type: "durable-object", storage: "sqlite" },
      Chat: { type: "durable-object", storage: "sqlite" },
    });
    expect(metadata?.cache_options).toEqual({ enabled: true });
    expect(metadata?.migrations).toBeUndefined();
    expect(r.install?.current_version_id).toBe(NEW_VERSION);
    // No migration ran, so no tag is recorded.
    expect(r.install?.do_migration_tag).toBeNull();
    expect(
      r.logs.some(
        (l) =>
          l.level === "warn" &&
          l.message.includes("changes the Durable Object classes its exports declare") &&
          l.message.includes("cannot be undone"),
      ),
    ).toBe(true);
  });

  it("uploads a version when only entrypoint exports change, carrying them and the cache block", async () => {
    const room = { type: "durable-object", storage: "sqlite" };
    const exports = { Room: room, Api: { type: "worker", cache: { enabled: true } } };
    const r = await update(
      {
        ...NEW_APP,
        exports,
        cacheOptions: { enabled: true, cross_version_cache: true },
      },
      {},
      { manifestJson: JSON.stringify({ worker: { migrations: [], exports: { Room: room } } }) },
    );
    expect(r.error).toBeNull();
    expect(r.step.names).toContain("upload Worker version");
    expect(r.step.names).not.toContain("deploy Worker script");
    const metadata = r.fake.state.versions[0]?.metadata;
    expect(metadata?.exports).toEqual(exports);
    expect(metadata?.cache_options).toEqual({ enabled: true, cross_version_cache: true });
  });

  it("sets the secrets a new version introduces with the uploaded version", async () => {
    const SECRET = "new-secret-value-DO-NOT-LEAK";
    const r = await update(
      {
        ...NEW_APP,
        catalog: {
          secrets: [
            { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
            { name: "API_KEY", label: "API key" },
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

  it("sets a new VAPID private key with its public key var, and stores the var once it serves", async () => {
    const privateKey = generateVapidPrivateKey();
    const r = await update(
      {
        ...NEW_APP,
        catalog: {
          secrets: [
            { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
            { name: "VAPID_PRIVATE_KEY", label: "Push signing key", generate: "vapid-private-key" },
          ],
          vars: [
            {
              name: "VAPID_PUBLIC_KEY",
              label: "Push public key",
              derive: { from: "VAPID_PRIVATE_KEY", method: "vapid-public-key" },
            },
          ],
        },
      },
      {},
      {},
      { secrets: { VAPID_PRIVATE_KEY: privateKey } },
    );
    expect(r.error).toBeNull();
    const publicKey = await vapidPublicKey(privateKey);
    const bindings = r.fake.state.versions[0]?.metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings).toContainEqual({
      type: "secret_text",
      name: "VAPID_PRIVATE_KEY",
      text: privateKey,
    });
    expect(bindings).toContainEqual({
      type: "plain_text",
      name: "VAPID_PUBLIC_KEY",
      text: publicKey,
    });
    // The seeded setting stays, the public key joins it, and the snapshot keeps the settings from before.
    expect(JSON.parse(String(r.install?.config_json))).toEqual({
      HOME_PAGE: "admin",
      VAPID_PUBLIC_KEY: publicKey,
    });
    expect(r.snapshot?.config_json).toBe('{"HOME_PAGE":"admin"}');
    expect(JSON.stringify(r.job)).not.toContain(privateKey);
    expect(JSON.stringify(r.logs)).not.toContain(privateKey);
  });

  it("updates to a release with the form of the revision the catalog lists for it", async () => {
    const SECRET = "revised-secret-value-DO-NOT-LEAK";
    const r = await update(
      {
        ...NEW_APP,
        revision: {
          secrets: [
            { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
            { name: "API_KEY", label: "API key" },
          ],
        },
      },
      {},
      {},
      { secrets: { API_KEY: SECRET } },
    );
    expect(r.error).toBeNull();
    expect(r.step.names).toContain("verify revised catalog manifest");
    const bindings = r.fake.state.versions[0]?.metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings).toContainEqual({ type: "secret_text", name: "API_KEY", text: SECRET });
    expect(r.install?.manifest_json).toBe(new TextDecoder().decode(r.fixture.manifestBytes));
    expect((await readCatalogRevision(createDb(env.DB), r.fixture.digest))?.revision).toBe(2);
  });

  it("offers no update when only the revision of the installed version changed", async () => {
    const revised = await buildArtifactFixture({ revision: { summary: "Revised." } });
    await seedInstall({ resources: RESOURCES });
    await expect(
      startUpdateCore(
        {
          db: env.DB,
          loadApp: async () => revised.index,
          loadManifest: async () => revised.manifest,
          createJob: async () => {
            throw new Error("no job may start");
          },
        },
        { installId: INSTALL_ID },
      ),
    ).rejects.toThrow(/There is no newer version to update to/);
  });

  it("takes the secrets it introduced off the newest version when it fails before promotion", async () => {
    const SECRET = "new-secret-value-DO-NOT-LEAK";
    const r = await update(
      {
        ...NEW_APP,
        catalog: {
          secrets: [
            { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
            { name: "API_KEY", label: "API key" },
          ],
        },
      },
      { previews: [{ status: 500, body: "boom" }] },
      {},
      { secrets: { API_KEY: SECRET } },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe("canary check 6: the Worker answered HTTP 500");
    expect(r.step.names.slice(-2)).toEqual(["put back the previous secrets", "mark update failed"]);
    expect(r.fake.state.calls).not.toContain("POST /workers/scripts/cut/deployments");
    // The upload carried the new value; the serving version never had the
    // secret, so the newest version drops it and the next upload cannot copy it.
    expect(r.fake.state.versionPatches).toEqual([
      {
        env: { API_KEY: null },
        annotations: { "workers/message": "Appflare: update job1 undone" },
      },
    ]);
    expect(r.install).toMatchObject({ status: "installed", current_version_id: OLD_VERSION });
    expect(r.logs.at(-1)?.message).toBe(
      `Update failed at "canary check 6". Version ${NEW_VERSION} was uploaded but never promoted; the previous version keeps serving all traffic. The secrets it introduced were taken off the Worker's newest version, so the next upload does not carry them.`,
    );
    expect(JSON.stringify(r.logs)).not.toContain(SECRET);
    expect(JSON.stringify(r.fake.state.versionPatches)).not.toContain(SECRET);
  });

  it("leaves the secrets alone when a newer upload happened after its own", async () => {
    const r = await update(
      {
        ...NEW_APP,
        catalog: {
          secrets: [
            { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
            { name: "API_KEY", label: "API key" },
          ],
        },
      },
      { previews: [{ status: 500, body: "boom" }] },
      {},
      { secrets: { API_KEY: "value" } },
      "self",
      undefined,
      // Someone uploads another version while the canary runs.
      (fake) => async (input, init) => {
        const preview = new URL(input).host.endsWith(`-cut.${SUBDOMAIN}.workers.dev`);
        if (preview && !fake.state.versions.some((v) => v.id === "someone-elses")) {
          fake.state.versions.push({ id: "someone-elses", metadata: {}, modules: [] });
        }
        return fake.fetch(input, init);
      },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.fake.state.versionPatches).toEqual([]);
    expect(r.logs.at(-1)?.message).toContain(
      "Another version was uploaded meanwhile; it keeps whatever secrets it was given.",
    );
  });

  it("sends the stored workers.dev choice and checks health on the first custom domain while it is off", async () => {
    const r = await update(
      NEW_APP,
      { domainHealth: { "links.example.com": [{ status: 200, body: "ok" }] } },
      {
        resources: [
          ...RESOURCES,
          { kind: "domain", name: "links.example.com", cfId: "dom-1" },
          { kind: "domain", name: "zz.example.com", cfId: "dom-2" },
        ],
      },
      {},
      "self",
      async () => {
        await env.DB.prepare("UPDATE installs SET workers_dev_enabled = 0 WHERE id = ?1")
          .bind(INSTALL_ID)
          .run();
      },
    );
    expect(r.error).toBeNull();
    // Previews stay on for the canary; the workers.dev URL stays off.
    expect(r.fake.state.subdomainCalls).toEqual([{ enabled: false, previews_enabled: true }]);
    expect(r.fake.state.domainProbes).toEqual(["links.example.com"]);
    expect(r.install).toMatchObject({
      health_status: "verified",
      health_access: 0,
      workers_dev_enabled: 0,
    });
    expect(r.logs.at(-1)?.message).toContain("at https://links.example.com/ (health: verified");
  });

  it("uses the domain the switch verified for {{appUrl}} and the health check, and workers.dev for {{workerUrl}}", async () => {
    const r = await update(
      {
        ...NEW_APP,
        catalog: {
          vars: [
            { name: "BASE_URL", label: "Base URL", default: "{{appUrl}}", optional: true },
            { name: "HOST", label: "Host", default: "{{appHostname}}", optional: true },
            { name: "DEV_URL", label: "workers.dev", default: "{{workerUrl}}", optional: true },
            {
              name: "DEV_HOST",
              label: "workers.dev host",
              default: "{{workerHostname}}",
              optional: true,
            },
          ],
        },
      },
      { domainHealth: { "zz.example.com": [{ status: 200, body: "ok" }] } },
      {
        resources: [
          ...RESOURCES,
          { kind: "domain", name: "links.example.com", cfId: "dom-1" },
          { kind: "domain", name: "zz.example.com", cfId: "dom-2" },
        ],
      },
      {},
      "self",
      async () => {
        await env.DB.prepare(
          "UPDATE installs SET workers_dev_enabled = 0, served_domain = 'zz.example.com' WHERE id = ?1",
        )
          .bind(INSTALL_ID)
          .run();
      },
    );
    expect(r.error).toBeNull();
    const bindings = r.fake.state.versions[0]?.metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings).toContainEqual({
      type: "plain_text",
      name: "BASE_URL",
      text: "https://zz.example.com",
    });
    expect(bindings).toContainEqual({ type: "plain_text", name: "HOST", text: "zz.example.com" });
    expect(bindings).toContainEqual({
      type: "plain_text",
      name: "DEV_URL",
      text: "https://cut.appflare-dev.workers.dev",
    });
    expect(bindings).toContainEqual({
      type: "plain_text",
      name: "DEV_HOST",
      text: "cut.appflare-dev.workers.dev",
    });
    expect(r.fake.state.domainProbes).toEqual(["zz.example.com"]);
  });

  it("takes the secrets it introduced off an upload that did not report its version", async () => {
    const r = await update(
      {
        ...NEW_APP,
        catalog: {
          secrets: [
            { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
            { name: "API_KEY", label: "API key" },
          ],
        },
      },
      { uploadWithoutId: true },
      {},
      { secrets: { API_KEY: "value" } },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      "upload Worker version: Cloudflare did not report the id of the uploaded version",
    );
    // Found by the upload's annotation, which names this job.
    expect(r.fake.state.versionPatches).toEqual([
      {
        env: { API_KEY: null },
        annotations: { "workers/message": "Appflare: update job1 undone" },
      },
    ]);
    expect(r.logs.at(-1)?.message).toBe(
      `Update failed at "upload Worker version". Nothing was deployed; the previous version keeps serving all traffic. Resources created so far stay recorded. The secrets it introduced were taken off the Worker's newest version, so the next upload does not carry them.`,
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
          health: { path: "/api/health" },
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

  it("goes on when Cloudflare Access answers the preview, and records the app as not verified", async () => {
    const healthPath = {
      ...NEW_APP,
      catalog: {
        install: {
          tier: "artifact" as const,
          packageManager: "pnpm" as const,
          wranglerConfig: "wrangler.jsonc",
          workerName: "cut",
          // Access's answer counts under neither mode.
          health: { path: "/api/health", mode: "any-response" as const },
        },
      },
    };
    const preview = "0a1b2c3d-cut.appflare-dev.workers.dev";
    const live = "cut.appflare-dev.workers.dev";
    const r = await update(healthPath, {
      previews: [{ status: 302, body: "", location: accessLoginUrl(preview, "/api/health") }],
      health: [{ status: 302, body: "", location: accessLoginUrl(live, "/api/health") }],
    });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded", worker_version_id: NEW_VERSION });
    // One probe each: Access keeps answering, so neither check waits for it.
    expect(r.step.names.filter((n) => /^(canary|health) check/.test(n))).toEqual([
      "canary check 1",
      "health check 1",
    ]);
    expect(r.step.sleeps.filter((n) => /^(canary|health) wait/.test(n))).toEqual([]);
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
    expect(r.logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: `GET https://${preview}/api/health: Cloudflare Access answered the preview URL with its sign-in page, so the new version was not checked before it serves traffic.`,
      }),
    );
    expect(r.logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: `GET https://${live}/api/health: Cloudflare Access asked for a sign-in, so Appflare could not reach the app to check it. Everything was created; open the app and sign in to check it.`,
      }),
    );
    expect(r.install).toMatchObject({ health_status: "unverified", health_access: 1 });
    expect(r.logs.at(-1)?.message).toBe(
      `Updated cut from 1.0.0 to 1.1.0 at https://${live}/api/health (health: not verified yet (Cloudflare Access asked for a sign-in)).`,
    );
  });

  describe("an app with schema files and post-deploy migrations", () => {
    const WITH_D1_LAYOUT: ArtifactFixtureOptions = {
      ...NEW_APP,
      d1Schema: {
        DB: [{ name: "schema.sql", content: "CREATE TABLE IF NOT EXISTS s (id TEXT);" }],
      },
      d1PostDeploy: {
        DB: [{ name: "0001_drop_legacy.sql", content: "ALTER TABLE links DROP COLUMN legacy;" }],
      },
    };

    it("runs the schema files before promotion and the post-deploy migrations after it", async () => {
      const r = await update(WITH_D1_LAYOUT);
      expect(r.error).toBeNull();
      const names = r.step.names;
      expect(names.slice(names.indexOf("D1 DB: apply migrations"))).toEqual([
        "D1 DB: apply migrations",
        "D1 DB: apply schema",
        "promote version",
        "record promotion",
        "set cron triggers",
        "health check 1",
        "D1 DB: apply post-deploy migrations",
        "finish",
      ]);
      expect(r.fake.state.applied["d1-1"]).toEqual([
        "0001_init.sql",
        "0002_hits.sql",
        "0001_drop_legacy.sql",
      ]);
      expect(r.fake.state.queries).toContain("CREATE TABLE IF NOT EXISTS s (id TEXT);");
    });

    it("keeps the promoted version recorded when a post-deploy migration fails", async () => {
      const r = await update(WITH_D1_LAYOUT, {
        failMigration: { file: "0001_drop_legacy.sql", status: 400, times: 1 },
      });
      expect(r.job?.error).toMatch(/^D1 DB: apply post-deploy migrations: 0001_drop_legacy\.sql: /);
      expect(r.install).toMatchObject({
        status: "installed",
        catalog_version: "1.1.0",
        current_version_id: NEW_VERSION,
      });
      expect(r.fake.state.applied["d1-1"]).toEqual(["0001_init.sql", "0002_hits.sql"]);
      // Everything else about the version was in place first.
      expect(r.step.names.indexOf("set cron triggers")).toBeLessThan(
        r.step.names.indexOf("D1 DB: apply post-deploy migrations"),
      );
      const last = r.logs.at(-1)?.message ?? "";
      expect(last).toMatch(
        new RegExp(`after version ${NEW_VERSION} was promoted: it serves all traffic`),
      );
      expect(last).toContain("rolling back would not undo them");
      expect(last).not.toContain("if the app misbehaves");
      // The database is not "ahead of the code": the new code serves.
      expect(r.logs.some((l) => l.message.startsWith("The D1 database"))).toBe(false);
    });
  });

  describe("an app with a D1 baseline", () => {
    const BASELINE = "CREATE TABLE links (id TEXT, hits INTEGER);\n";
    const LOGS_BASELINE = "CREATE TABLE logs (id TEXT, level TEXT);\n";
    const WITH_BASELINE: ArtifactFixtureOptions = {
      ...NEW_APP,
      bindings: [...(NEW_APP.bindings ?? []), { type: "d1", name: "LOGS" }],
      d1: {
        ...NEW_APP.d1,
        LOGS: [{ name: "0001_add_level.sql", content: "ALTER TABLE logs ADD COLUMN level TEXT;" }],
      },
      d1Baseline: {
        DB: { name: "schema.sql", content: BASELINE },
        LOGS: { name: "logs/schema.sql", content: LOGS_BASELINE },
      },
    };

    it("applies only the new migrations to a database the install has, and never its baseline", async () => {
      const r = await update(WITH_BASELINE, {
        applied: { "d1-1": ["0000_renamed_upstream.sql", "0001_init.sql"] },
      });
      expect(r.error).toBeNull();
      // The step looks and leaves the database to the migrations.
      expect(r.step.names).toContain("D1 DB: apply baseline");
      expect(r.fake.state.queries.some((q) => q.startsWith(BASELINE))).toBe(false);
      expect(r.fake.state.applied["d1-1"]).toEqual([
        "0000_renamed_upstream.sql",
        "0001_init.sql",
        "0002_hits.sql",
      ]);
      expect(r.logs.map((l) => l.message)).toContain(
        "d1_migrations of cut-db records 1 migration(s) this version does not ship (0000_renamed_upstream.sql); they stay recorded and nothing runs for them.",
      );
    });

    it("runs the baseline on a database the update creates, as an install would", async () => {
      const r = await update(WITH_BASELINE);
      expect(r.error).toBeNull();
      const names = r.step.names;
      expect(names.filter((n) => n.startsWith("D1 LOGS"))).toEqual([
        "D1 LOGS: apply baseline",
        "D1 LOGS: apply migrations",
      ]);
      const created = r.fake.state.d1.find((d) => d.name === "cut-logs");
      if (created === undefined) throw new Error("the update created no LOGS database");
      expect(r.fake.state.applied[created.uuid]).toEqual(["0001_add_level.sql"]);
      expect(r.fake.state.queries.filter((q) => q.startsWith(LOGS_BASELINE))).toHaveLength(1);
      expect(r.fake.state.queries.some((q) => q.includes("ADD COLUMN level"))).toBe(false);
    });

    it("runs the baseline on a database an earlier failed attempt created and left empty", async () => {
      const r = await update(
        WITH_BASELINE,
        {
          d1: [{ uuid: "d1-2", name: "cut-logs" }],
          bookmarks: { "d1-1": "00000001-bookmark-before", "d1-2": "00000001-bookmark-logs" },
        },
        {
          resources: [
            ...RESOURCES,
            { kind: "d1", binding: "LOGS", name: "cut-logs", cfId: "d1-2" },
          ],
        },
      );
      expect(r.error).toBeNull();
      // Recorded already, so not created again; empty, so it gets its baseline.
      expect(r.step.names.some((n) => n.startsWith("create D1"))).toBe(false);
      expect(r.fake.state.queries.filter((q) => q.startsWith(LOGS_BASELINE))).toHaveLength(1);
      expect(r.fake.state.applied["d1-2"]).toEqual(["0001_add_level.sql"]);
      expect(r.fake.state.queries.some((q) => q.includes("ADD COLUMN level"))).toBe(false);
    });
  });

  it("never seeds, nor asks for or sets a seed-only secret, even when the version adds a seed", async () => {
    const base = baseCatalog();
    const seeded: ArtifactFixtureOptions = {
      ...NEW_APP,
      catalog: {
        secrets: [
          ...base.secrets,
          {
            name: "FIRST_ADMIN_PASSWORD",
            label: "Admin password",
            generate: "password",
            seedOnly: true,
          },
        ],
        vars: [...base.vars, { name: "FIRST_ADMIN_NAME", label: "Admin name", seedOnly: true }],
        resources: {
          d1: {
            DB: {
              seed: {
                hashes: { admin: { from: "FIRST_ADMIN_PASSWORD", method: "bcrypt" } },
                statements: [
                  {
                    sql: "INSERT OR IGNORE INTO admins (name, password_hash) VALUES (?, ?)",
                    params: [{ var: "FIRST_ADMIN_NAME" }, { hash: "admin" }],
                  },
                ],
              },
            },
          },
        },
      },
    };
    // No value for the seed-only secret: the update does not need one.
    const r = await update(seeded);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.self.calls.some((c) => c.unit === "seedD1")).toBe(false);
    expect(r.step.names.some((n) => n.endsWith(": seed"))).toBe(false);
    expect(r.fake.state.queries.some((q) => q.includes("admins"))).toBe(false);
    const uploaded = r.fake.state.versions.at(-1)?.metadata as {
      bindings?: Array<{ name: string }>;
    };
    const names = (uploaded.bindings ?? []).map((b) => b.name);
    expect(names).not.toContain("FIRST_ADMIN_PASSWORD");
    expect(names).not.toContain("FIRST_ADMIN_NAME");
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

  it("still names a database whose last migration answer was lost and retried", async () => {
    const r = await update(NEW_APP, {
      // 0002 runs, its answer is lost; the retry finds nothing left to apply.
      failMigration: { file: "0002_hits.sql", status: 500, times: 1, after: true },
      failOnce: new Map([["POST /workers/scripts/cut/deployments", 400]]),
    });
    expect(r.step.retried).toEqual({ "D1 DB: apply migrations": 2 });
    expect(r.fake.state.applied["d1-1"]).toEqual(["0001_init.sql", "0002_hits.sql"]);
    expect(
      r.fake.state.queries.filter((q) => q.endsWith("values ('0002_hits.sql');")),
    ).toHaveLength(1);
    expect(r.job?.error).toMatch(/^promote version: /);
    expect(r.logs.map((l) => l.message)).toContain(
      "cut-db already has every migration this version ships.",
    );
    expect(
      r.logs.some((l) =>
        l.message.startsWith("The D1 database cut-db is already migrated to the new schema"),
      ),
    ).toBe(true);
  });

  it("names a database that took some migrations before a later one failed", async () => {
    const DB = [
      ...(NEW_APP.d1?.DB ?? []),
      { name: "0003_broken.sql", content: "ALTER TABLE links ADD COLUMN;" },
    ];
    const r = await update(
      { ...NEW_APP, d1: { DB } },
      { failMigration: { file: "0003_broken.sql", status: 400, times: 1 } },
    );
    expect(r.job?.error).toMatch(/^D1 DB: apply migrations: 0003_broken\.sql: /);
    expect(r.fake.state.applied["d1-1"]).toEqual(["0001_init.sql", "0002_hits.sql"]);
    expect(
      r.logs.some((l) =>
        l.message.startsWith("The D1 database cut-db is already migrated to the new schema"),
      ),
    ).toBe(true);
  });

  it("does not name a database whose first new migration failed", async () => {
    const r = await update(NEW_APP, {
      failMigration: { file: "0002_hits.sql", status: 400, times: 1 },
    });
    expect(r.job?.error).toMatch(/^D1 DB: apply migrations: 0002_hits\.sql: /);
    expect(r.fake.state.applied["d1-1"]).toEqual(["0001_init.sql"]);
    expect(r.logs.some((l) => l.message.startsWith("The D1 database"))).toBe(false);
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

  it("refuses a version whose Worker is too large for one upload, before snapshotting", async () => {
    const r = await update({
      ...NEW_APP,
      tweak: (m) => {
        const first = m.worker.modules[0];
        if (first === undefined) throw new Error("the fixture has no module");
        // Never fetched: the check reads the manifest alone.
        first.size = 40 * 1024 * 1024;
      },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      "plan update: This version has 40.00 MiB of Worker modules, but Appflare uploads at most 32.00 MiB: the upload holds every module and the request body in memory at once, within the 128 MB a Worker may use. Make the Worker smaller, for example by minifying it or serving large files as static assets.",
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

  describe("settings of a kept Vectorize index and R2 bucket", () => {
    const INDEX = {
      kind: "vectorize",
      binding: "VECTORIZE",
      name: "cut-vectorize",
      cfId: "cut-vectorize",
    };
    const BUCKET = { kind: "r2", binding: "FILES", name: "cut-files", cfId: "cut-files" };
    const indexBinding = (metadataIndexes?: Array<{ propertyName: string; type: "string" }>) => ({
      type: "vectorize" as const,
      name: "VECTORIZE",
      dimensions: 3,
      metric: "cosine" as const,
      ...(metadataIndexes === undefined ? {} : { metadataIndexes }),
    });
    const withIndex = (
      metadataIndexes: Array<{ propertyName: string; type: "string" }>,
    ): ArtifactFixtureOptions => ({
      ...NEW_APP,
      bindings: [...(NEW_APP.bindings ?? []), indexBinding(metadataIndexes)],
      catalog: {
        resources: {
          vectorize: { VECTORIZE: { dimensions: 3, metric: "cosine", metadataIndexes } },
        },
      },
    });
    const indexSeed = {
      resources: [...RESOURCES, INDEX],
      manifestJson: JSON.stringify({
        version: "1.0.0",
        worker: { migrations: [], bindings: [indexBinding()] },
      }),
    };
    type Rule = { id: string; prefix?: string; deleteAfterDays: number };
    const withBucket = (lifecycle: Rule[] | undefined): ArtifactFixtureOptions => ({
      ...NEW_APP,
      bindings: [
        ...(NEW_APP.bindings ?? []),
        { type: "r2_bucket", name: "FILES", ...(lifecycle === undefined ? {} : { lifecycle }) },
      ],
      catalog: lifecycle === undefined ? {} : { resources: { r2: { FILES: { lifecycle } } } },
    });
    const bucketSeed = (installed: Rule[] | undefined) => ({
      resources: [...RESOURCES, BUCKET],
      manifestJson: JSON.stringify({
        version: "1.0.0",
        worker: { migrations: [], bindings: [{ type: "r2_bucket", name: "FILES" }] },
        catalog:
          installed === undefined ? {} : { resources: { r2: { FILES: { lifecycle: installed } } } },
      }),
    });
    const apiRule = (id: string, prefix: string, days: number) => ({
      id,
      enabled: true,
      conditions: { prefix },
      deleteObjectsTransition: { condition: { type: "Age", maxAge: days * 86_400 } },
    });
    const CREATE_URL = "POST /vectorize/v2/indexes/cut-vectorize/metadata_index/create";
    const PUT_RULES = "PUT /r2/buckets/cut-files/lifecycle";

    it("creates only the metadata indexes a kept index lacks, before the upload, and deletes none", async () => {
      const r = await update(
        withIndex([
          { propertyName: "url", type: "string" },
          { propertyName: "lang", type: "string" },
        ]),
        // The index has "url" from an earlier version and "author", made by hand.
        {
          metadataIndexes: {
            "cut-vectorize": [
              { propertyName: "url", indexType: "string" },
              { propertyName: "author", indexType: "string" },
            ],
          },
        },
        indexSeed,
      );
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.calls.filter((c) => c === CREATE_URL)).toHaveLength(1);
      expect(r.fake.state.metadataIndexes["cut-vectorize"]).toEqual([
        { propertyName: "url", indexType: "string" },
        { propertyName: "author", indexType: "string" },
        { propertyName: "lang", indexType: "string" },
      ]);
      const at = (name: string) => r.step.names.indexOf(name);
      expect(at("record snapshot")).toBeLessThan(
        at("list metadata indexes of Vectorize index cut-vectorize"),
      );
      expect(at("list metadata indexes of Vectorize index cut-vectorize")).toBeLessThan(
        at("create metadata index lang on Vectorize index cut-vectorize"),
      );
      expect(at("create metadata index lang on Vectorize index cut-vectorize")).toBeLessThan(
        at("upload Worker version"),
      );
      expect(r.step.names).not.toContain(
        "create metadata index url on Vectorize index cut-vectorize",
      );
      expect(r.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message:
            'Vectors written to "cut-vectorize" before a metadata index exists are not indexed by it, so a query that filters on "lang" finds only vectors written from now on. The app has to write the older vectors again (an upsert of the same ids) for such queries to find them.',
        }),
      );
      expect(r.logs.map((l) => l.message)).toContain(
        'Created a string metadata index on "lang" for Vectorize index "cut-vectorize".',
      );
    });

    it("creates nothing and warns of nothing when the index has every declared metadata index", async () => {
      const r = await update(
        withIndex([{ propertyName: "url", type: "string" }]),
        { metadataIndexes: { "cut-vectorize": [{ propertyName: "url", indexType: "string" }] } },
        indexSeed,
      );
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.calls).not.toContain(CREATE_URL);
      expect(r.logs.map((l) => l.message)).toContain(
        'Vectorize index "cut-vectorize" already has the metadata indexes this version declares.',
      );
      expect(r.logs.some((l) => l.message.startsWith("Vectors written"))).toBe(false);
    });

    it("retries a metadata index whose answer was lost without creating it twice", async () => {
      const r = await update(
        withIndex([{ propertyName: "url", type: "string" }]),
        { failAfter: new Set([CREATE_URL]) },
        indexSeed,
      );
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.step.retried["create metadata index url on Vectorize index cut-vectorize"]).toBe(2);
      expect(r.fake.state.metadataIndexes["cut-vectorize"]).toEqual([
        { propertyName: "url", indexType: "string" },
      ]);
      expect(r.logs.map((l) => l.message)).toContain(
        'The metadata index on "url" an earlier attempt created is there.',
      );
    });

    it("refuses before creating any when the index would pass Cloudflare's ten", async () => {
      const handMade = Array.from({ length: 10 }, (_, i) => ({
        propertyName: `p${i}`,
        indexType: "string",
      }));
      const r = await update(
        withIndex([{ propertyName: "url", type: "string" }]),
        { metadataIndexes: { "cut-vectorize": handMade } },
        indexSeed,
      );
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toBe(
        'list metadata indexes of Vectorize index cut-vectorize: Vectorize index "cut-vectorize" has 10 metadata indexes and this version needs 1 more ("url"), but Cloudflare allows 10 on an index. Delete the ones the app no longer filters on (wrangler vectorize delete-metadata-index), then update again',
      );
      expect(r.fake.state.calls).not.toContain(CREATE_URL);
      expect(r.step.names).not.toContain("upload Worker version");
    });

    it("merges lifecycle rules into a kept bucket, keeping Cloudflare's rule, rules made by hand, and dropped ones", async () => {
      const byHand = apiRule("tmp", "tmp/", 30);
      const r = await update(
        withBucket([
          { id: "tmp", prefix: "tmp/", deleteAfterDays: 2 },
          { id: "exports", prefix: "exports/", deleteAfterDays: 7 },
        ]),
        {
          lifecycle: {
            "cut-files": [
              DEFAULT_MULTIPART_RULE,
              byHand,
              apiRule("appflare:tmp", "tmp/", 1),
              apiRule("appflare:old", "old/", 5),
            ],
          },
        },
        bucketSeed([
          { id: "tmp", prefix: "tmp/", deleteAfterDays: 1 },
          { id: "old", prefix: "old/", deleteAfterDays: 5 },
        ]),
      );
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.lifecycle["cut-files"]).toEqual([
        DEFAULT_MULTIPART_RULE,
        byHand,
        apiRule("appflare:tmp", "tmp/", 2),
        apiRule("appflare:old", "old/", 5),
        apiRule("appflare:exports", "exports/", 7),
      ]);
      const at = (name: string) => r.step.names.indexOf(name);
      // Only once the new version serves.
      expect(at("promote version")).toBeGreaterThan(-1);
      expect(at("promote version")).toBeLessThan(at("read lifecycle rules of R2 bucket cut-files"));
      expect(r.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message:
            'This version no longer declares the lifecycle rule "old" that Appflare set on R2 bucket "cut-files" for an earlier version. Appflare never removes a rule, so it stays (as "appflare:old"); delete it in the bucket\'s settings if the app no longer needs it.',
        }),
      );
      expect(r.logs.map((l) => l.message)).toContain(
        'Set the lifecycle rules "tmp" and "exports" on R2 bucket "cut-files" (shown there as "appflare:tmp" and "appflare:exports"), keeping its 3 other rules.',
      );
    });

    it("puts the same rules again when the answer to the write was lost", async () => {
      const r = await update(
        withBucket([{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }]),
        { failAfter: new Set([PUT_RULES]) },
        bucketSeed(undefined),
      );
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.step.retried["set lifecycle rules of R2 bucket cut-files"]).toBe(2);
      expect(r.fake.state.lifecycle["cut-files"]).toEqual([
        DEFAULT_MULTIPART_RULE,
        apiRule("appflare:tmp", "tmp/", 1),
      ]);
    });

    it("leaves the bucket's rules alone when the update fails before the new version serves", async () => {
      const rules = [DEFAULT_MULTIPART_RULE];
      const r = await update(
        withBucket([{ id: "uploads", prefix: "uploads/", deleteAfterDays: 30 }]),
        { previews: [{ status: 500, body: "boom" }], lifecycle: { "cut-files": [...rules] } },
        bucketSeed(undefined),
      );
      expect(r.job?.status).toBe("failed");
      expect(r.fake.state.calls.filter((c) => c.includes("/lifecycle"))).toEqual([]);
      expect(r.fake.state.lifecycle["cut-files"]).toEqual(rules);
    });

    it("writes nothing when Cloudflare answers the same rules in its own spelling", async () => {
      // Keys in another order, no empty prefix, an empty list, and the rules in another order.
      const r = await update(
        withBucket([
          { id: "all", deleteAfterDays: 3 },
          { id: "tmp", prefix: "tmp/", deleteAfterDays: 1 },
        ]),
        {
          lifecycle: {
            "cut-files": [
              {
                deleteObjectsTransition: { condition: { maxAge: 86_400, type: "Age" } },
                conditions: { prefix: "tmp/" },
                enabled: true,
                id: "appflare:tmp",
                storageClassTransitions: [],
              },
              {
                id: "appflare:all",
                enabled: true,
                conditions: {},
                deleteObjectsTransition: { condition: { type: "Age", maxAge: 259_200 } },
              },
              {
                abortMultipartUploadsTransition: { condition: { maxAge: 604_800, type: "Age" } },
                enabled: true,
                id: "Default Multipart Abort Rule",
              },
            ],
          },
        },
        bucketSeed([{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }]),
      );
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.calls).toContain("GET /r2/buckets/cut-files/lifecycle");
      expect(r.fake.state.calls).not.toContain(PUT_RULES);
      expect(r.logs.map((l) => l.message)).toContain(
        'R2 bucket "cut-files" already has the lifecycle rules "all" and "tmp" as this version declares them.',
      );
    });

    it("writes nothing when the bucket already has the declared rules", async () => {
      const r = await update(
        withBucket([{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }]),
        {
          lifecycle: {
            "cut-files": [DEFAULT_MULTIPART_RULE, apiRule("appflare:tmp", "tmp/", 1)],
          },
        },
        bucketSeed([{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }]),
      );
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.calls).not.toContain(PUT_RULES);
      expect(r.step.names).not.toContain("set lifecycle rules of R2 bucket cut-files");
      expect(r.logs.map((l) => l.message)).toContain(
        'R2 bucket "cut-files" already has the lifecycle rule "tmp" as this version declares it.',
      );
    });

    it("leaves the rules of an earlier version when this one declares none, and says so", async () => {
      const rules = [DEFAULT_MULTIPART_RULE, apiRule("appflare:tmp", "tmp/", 1)];
      const r = await update(
        withBucket(undefined),
        { lifecycle: { "cut-files": [...rules] } },
        bucketSeed([{ id: "tmp", prefix: "tmp/", deleteAfterDays: 1 }]),
      );
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.calls).not.toContain(PUT_RULES);
      expect(r.fake.state.lifecycle["cut-files"]).toEqual(rules);
      expect(r.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message:
            'This version no longer declares the lifecycle rule "tmp" that Appflare set on R2 bucket "cut-files" for an earlier version. Appflare never removes a rule, so it stays (as "appflare:tmp"); delete it in the bucket\'s settings if the app no longer needs it.',
        }),
      );
    });

    it("does not read a kept bucket's rules when neither version declares any", async () => {
      const r = await update(withBucket(undefined), {}, bucketSeed(undefined));
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.calls).not.toContain("GET /r2/buckets/cut-files/lifecycle");
    });
  });

  describe("Pipelines streams", () => {
    const sink = {
      type: "r2_data_catalog" as const,
      bucket: "WAREHOUSE",
      namespace: "cut",
      table: "events",
      tokenSecret: "CATALOG_TOKEN",
    };
    const schema = { fields: [{ name: "ts", type: "timestamp" as const, required: true }] };
    const withStream = (events: { schema?: typeof schema; sink: typeof sink }) => ({
      ...NEW_APP,
      bindings: [...(NEW_APP.bindings ?? []), { type: "pipelines", name: "EVENTS" }],
      catalog: {
        plan: "paid" as const,
        secrets: [...baseCatalog().secrets, { name: "CATALOG_TOKEN", label: "R2 API token" }],
        resources: { pipelines: { EVENTS: events } },
      },
    });
    const request = { paidConfirmed: true, secrets: { CATALOG_TOKEN: "r2-token" } };

    it("refuses a version that adds a stream, before snapshotting", async () => {
      const r = await update(withStream({ schema, sink }), {}, {}, request);
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(
        /^plan update: .*Binding EVENTS sends events to a Pipelines stream and is new in this version; its sink needs the API token entered at install, which an update cannot read back, so this version needs a fresh install\./,
      );
      expect(r.fake.state.calls).toEqual([]);
      expect(r.snapshot).toBeNull();
    });

    it("refuses a version that changes a kept stream's schema, before snapshotting", async () => {
      const r = await update(
        withStream({
          schema: { fields: [{ name: "other", type: "timestamp", required: true }] },
          sink,
        }),
        {},
        {
          resources: [
            ...RESOURCES,
            { kind: "pipeline_stream", binding: "EVENTS", name: "cut_events_stream", cfId: "s1" },
            { kind: "pipeline_sink", name: "cut_events_sink", cfId: "k1" },
            { kind: "pipeline", name: "cut_events_pipeline", cfId: "p1" },
          ],
          manifestJson: JSON.stringify({
            version: "1.0.0",
            worker: { migrations: [], bindings: [{ type: "pipelines", name: "EVENTS" }] },
            catalog: { resources: { pipelines: { EVENTS: { schema, sink } } } },
          }),
        },
        request,
      );
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(
        /^plan update: .*Binding EVENTS sends events to the Pipelines stream "cut_events_stream"; this version changes its schema\./,
      );
      expect(r.fake.state.calls).toEqual([]);
      expect(r.snapshot).toBeNull();
    });
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

    it("syncs the consumers before the cron triggers, whose refusal does not stop the job", async () => {
      const r = await update(
        withConsumers([
          { queue: { binding: "JOBS" }, max_batch_size: 5 },
          { queue: { binding: "EXPORT" }, max_retries: 2 },
        ]),
        {
          ...account(),
          otherScripts: ["appflare"],
          otherCrons: {
            appflare: ["0 1 * * *", "0 2 * * *", "0 3 * * *", "0 4 * * *", "0 5 * * *"],
          },
          freeCronLimit: true,
        },
        { resources: QUEUE_RESOURCES, manifestJson: installedManifest },
      );
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      const calls = r.fake.state.calls;
      expect(calls.indexOf("PUT /workers/scripts/cut/schedules")).toBeGreaterThan(
        calls.indexOf("PUT /queues/q-jobs/consumers/c-jobs"),
      );
      expect(r.fake.state.consumers["q-jobs"]?.[0]?.settings).toEqual({ batch_size: 5 });
      expect(
        r.logs.some(
          (l) => l.level === "warn" && l.message.startsWith("Cloudflare refused 1 cron trigger"),
        ),
      ).toBe(true);
      expect(r.step.names.at(-1)).toBe("finish");
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

  describe("a version that adds cron triggers on a free account", () => {
    const moreCrons: ArtifactFixtureOptions = {
      ...NEW_APP,
      crons: ["*/5 * * * *", "0 1 * * *", "0 2 * * *"],
    };
    /** The manager and another app: 3 cron triggers on Workers with a scheduled handler. */
    const busy = (): Partial<FakeAccount> => ({
      otherScripts: ["appflare", "second-brain"],
      handlers: { appflare: ["fetch", "scheduled"], "second-brain": ["fetch", "scheduled"] },
      otherCrons: { appflare: ["*/30 * * * *"], "second-brain": ["0 1 * * *", "0 13 * * *"] },
      freeCronLimit: true,
    });

    it("refuses before snapshotting when its triggers would pass 5, naming the count", async () => {
      const r = await update(moreCrons, busy(), {}, { paidConfirmed: false });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toBe(
        "check cron trigger limit: this version needs 3 cron triggers and the account's other Workers already use 3 (second-brain: 2, appflare: 1); Workers Free allows 5 per account, so this would make 6. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account). If it is already on Workers Paid, choose that plan under [Workers plan in Your account](/settings/account#capability-workers-plan). Then try again.",
      );
      expect(r.step.names).toEqual([
        "start",
        "verify artifact manifest",
        "plan update",
        "check cron trigger limit",
        "mark update failed",
      ]);
      expect(r.snapshot).toBeNull();
      // The Worker's own triggers are replaced by the new ones, so they are not counted.
      expect(r.fake.state.calls).not.toContain("GET /workers/scripts/cut/schedules");
      expect(r.fake.state.deployments).toHaveLength(1);
      expect(r.install?.status).toBe("installed");
    });

    it("updates when the admin confirmed Workers Paid, without counting", async () => {
      const r = await update(
        moreCrons,
        { ...busy(), freeCronLimit: false },
        {},
        {
          paidConfirmed: true,
        },
      );
      expect(r.error).toBeNull();
      expect(r.step.names).not.toContain("check cron trigger limit");
      expect(r.fake.state.schedules).toEqual(["*/5 * * * *", "0 1 * * *", "0 2 * * *"]);
    });

    it("skips the count when Settings records the account as on Workers Paid", async () => {
      const r = await update(
        moreCrons,
        { ...busy(), freeCronLimit: false },
        {},
        {},
        "self",
        async () => {
          await env.DB.prepare(
            "INSERT INTO settings (key, value, updated_at) VALUES ('account_plan', 'paid', 0)",
          ).run();
        },
      );
      expect(r.error).toBeNull();
      expect(r.step.names).not.toContain("check cron trigger limit");
      expect(r.fake.state.schedules).toEqual(["*/5 * * * *", "0 1 * * *", "0 2 * * *"]);
    });

    it("warns when Cloudflare refuses the triggers after promotion, and still checks health and finishes", async () => {
      // The count fits (the Worker's own trigger is replaced), but triggers
      // added elsewhere since make Cloudflare refuse the schedule.
      const r = await update(
        { ...NEW_APP, crons: ["0 3 * * *"] },
        {
          ...busy(),
          otherCrons: {
            appflare: ["*/30 * * * *"],
            "second-brain": ["0 1 * * *", "0 13 * * *", "0 4 * * *", "0 5 * * *"],
          },
        },
      );
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.install?.status).toBe("installed");
      const names = r.step.names;
      expect(names.slice(names.indexOf("set cron triggers") + 1)).toEqual([
        "health check 1",
        "finish",
      ]);
      expect(r.step.retried).toEqual({});
      expect(
        r.fake.state.calls.filter((c) => c === "PUT /workers/scripts/cut/schedules"),
      ).toHaveLength(1);
      expect(r.logs).toContainEqual(
        expect.objectContaining({
          level: "warn",
          message:
            "Cloudflare refused 1 cron trigger: this account has reached the Workers Free limit of 5 cron triggers per account. The version serves traffic; the Worker keeps the cron triggers it had (*/5 * * * *) and does not get 0 3 * * *. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account), then the next update or rollback sets them.",
        }),
      );
      // The recorded triggers stay as they were.
      expect(r.resources).toContainEqual(
        expect.objectContaining({ kind: "cron", name: "*/5 * * * *", deleted_at: null }),
      );
      expect(r.resources).not.toContainEqual(expect.objectContaining({ name: "0 3 * * *" }));
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

describe("update job, an app of several Workers", () => {
  const JOBS_OLD = "11111111-2222-4333-8444-555555555555";
  const SECRET = "jobs-secret-DO-NOT-LEAK";
  const jobsWorker = (crons: string[]) => ({
    name: "jobs",
    bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
    crons,
  });
  const app = (version: string, crons: string[]): ArtifactFixtureOptions => ({
    ...NEW_APP,
    version,
    otherWorkers: [jobsWorker(crons)],
    catalog: {
      secrets: [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: "password" },
        { name: "JOBS_KEY", label: "Jobs key", workers: ["jobs"] },
      ],
    },
  });

  type Exports = NonNullable<ArtifactManifest["worker"]["exports"]>;
  /** The app with the `jobs` Worker given these exports, and kept off workers.dev when `workersDev` is false. */
  const withJobsExports = (
    options: ArtifactFixtureOptions,
    exports: Exports | undefined,
    workersDev?: boolean,
  ): ArtifactFixtureOptions => ({
    ...options,
    otherWorkers: (options.otherWorkers ?? []).map((w) =>
      w.name === "jobs"
        ? {
            ...w,
            ...(exports === undefined ? {} : { exports }),
            ...(workersDev === undefined ? {} : { workersDev }),
          }
        : w,
    ),
  });

  /** Runs the update with a second fake account for `cut-jobs`, serving `JOBS_OLD`. */
  async function updateBoth(
    world: Partial<FakeAccount> = {},
    jobsWorld: Partial<FakeAccount> = {},
    /** The `jobs` Worker's exports in the installed and in the new version. */
    exports: { installed?: Exports; next?: Exports } = {},
    /** Whether the installed and the new version keep the `jobs` Worker on workers.dev. */
    workersDev: { installed?: boolean; next?: boolean } = {},
  ) {
    const old = await buildArtifactFixture({
      ...withJobsExports(app("1.0.0", ["*/5 * * * *"]), exports.installed, workersDev.installed),
      version: "1.0.0",
    });
    const jobs = fakeAccount(null, {
      worker: "cut-jobs",
      deployments: [{ id: "dep-j", versions: [{ version_id: JOBS_OLD, percentage: 100 }] }],
      ...jobsWorld,
    });
    const r = await update(
      withJobsExports(app("1.1.0", ["*/15 * * * *"]), exports.next, workersDev.next),
      world,
      {
        manifestJson: JSON.stringify(old.manifest),
        resources: [
          ...RESOURCES,
          { kind: "worker", name: "cut-jobs", cfId: "cut-jobs" },
          { kind: "subdomain", name: "cut-jobs.appflare-dev.workers.dev" },
        ],
      },
      { secrets: { JOBS_KEY: SECRET } },
      "self",
      undefined,
      (fake) => async (input, init) => {
        const target =
          input.includes("/workers/scripts/cut-jobs") || input.includes("-cut-jobs.") ? jobs : fake;
        return target.fetch(input, init);
      },
    );
    return { ...r, jobs };
  }

  it("snapshots, checks and promotes every Worker, the primary one last", async () => {
    const r = await updateBoth();
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(JSON.parse(String(r.snapshot?.worker_versions_json))).toEqual({ "cut-jobs": JOBS_OLD });
    expect(JSON.parse(String(r.install?.worker_versions_json))).toEqual({
      "cut-jobs": NEW_VERSION,
    });
    // The other Worker's version: uploaded, checked on its preview, then promoted.
    const uploaded = r.jobs.state.versions[0];
    const bindings = uploaded?.metadata.bindings as Array<Record<string, unknown>>;
    expect(bindings).toContainEqual({ type: "secret_text", name: "JOBS_KEY", text: SECRET });
    expect(bindings).toContainEqual({ type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" });
    expect(uploaded?.metadata.keep_bindings).toEqual(["secret_text"]);
    expect(r.jobs.state.previewHosts.length).toBeGreaterThan(0);
    expect(r.jobs.state.deployments[0]?.versions[0]?.version_id).toBe(NEW_VERSION);
    expect(r.jobs.state.schedules).toEqual(["*/15 * * * *"]);
    // The primary Worker's version never carries the secret meant for the other one.
    const primary = r.fake.state.versions[0]?.metadata.bindings as Array<Record<string, unknown>>;
    expect(primary.some((b) => b.name === "JOBS_KEY")).toBe(false);
    const order = r.step.names;
    expect(order.indexOf('promote version (Worker "cut-jobs")')).toBeLessThan(
      order.indexOf("promote version"),
    );
    expect(order.indexOf("D1 DB: apply migrations")).toBeLessThan(
      order.indexOf('promote version (Worker "cut-jobs")'),
    );
    expect(new Set(order).size).toBe(order.length);
    expect(JSON.stringify(r.logs)).not.toContain(SECRET);
  });

  it("deploys another Worker whole at promotion when its Durable Object exports change", async () => {
    const room = { type: "durable-object", storage: "sqlite" };
    const r = await updateBoth(
      {},
      {},
      { installed: { Room: room }, next: { Room: room, Chat: room } },
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const order = r.step.names;
    // Prepared without a version or a preview, then deployed whole before the primary one.
    expect(order).toContain('skip canary (Worker "cut-jobs")');
    expect(order).not.toContain('upload Worker version (Worker "cut-jobs")');
    expect(order.indexOf('deploy Worker script (Worker "cut-jobs")')).toBeLessThan(
      order.indexOf("promote version"),
    );
    expect(r.jobs.state.calls).not.toContain("POST /workers/scripts/cut-jobs/versions");
    expect(r.jobs.state.previewHosts).toEqual([]);
    const metadata = r.jobs.state.versions[0]?.metadata;
    expect(metadata?.exports).toEqual({ Room: room, Chat: room });
    expect(metadata?.migrations).toBeUndefined();
    expect(JSON.parse(String(r.install?.worker_versions_json))).toEqual({
      "cut-jobs": NEW_VERSION,
    });
    expect(
      r.logs.some(
        (l) =>
          l.level === "warn" &&
          l.message.includes('The Durable Object exports of Worker "cut-jobs" change'),
      ),
    ).toBe(true);
  });

  it("uploads another Worker's version when only its entrypoint exports change", async () => {
    const room = { type: "durable-object", storage: "sqlite" };
    const r = await updateBoth(
      {},
      {},
      {
        installed: { Room: room },
        next: { Room: room, Api: { type: "worker", cache: { enabled: true } } },
      },
    );
    expect(r.error).toBeNull();
    expect(r.step.names).toContain('upload Worker version (Worker "cut-jobs")');
    expect(r.step.names).not.toContain('deploy Worker script (Worker "cut-jobs")');
  });

  it("promotes nothing when another Worker's canary fails", async () => {
    const r = await updateBoth(
      {},
      {
        previews: [{ status: 500, body: "boom" }],
      },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^canary \(Worker "cut-jobs"\) check \d+:/);
    expect(r.jobs.state.deployments).toHaveLength(1);
    expect(r.fake.state.deployments).toHaveLength(1);
    expect(r.install?.catalog_version).toBe("1.0.0");
  });

  it("takes a Worker the new version keeps private off workers.dev before uploading it", async () => {
    const r = await updateBoth({}, {}, {}, { next: false });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    // Off with its previews, before any of its uploads; never turned back on.
    expect(r.jobs.state.subdomainCalls).toEqual([{ enabled: false, previews_enabled: false }]);
    const calls = r.jobs.state.calls;
    expect(calls.indexOf("POST /workers/scripts/cut-jobs/subdomain")).toBeLessThan(
      calls.indexOf("POST /workers/scripts/cut-jobs/versions"),
    );
    // No preview check; the version is still promoted before the primary one.
    expect(r.jobs.state.previewHosts).toEqual([]);
    expect(r.step.names).toContain('skip canary (Worker "cut-jobs")');
    expect(r.jobs.state.deployments[0]?.versions[0]?.version_id).toBe(NEW_VERSION);
    const route = r.resources.find((row) => row.name === "cut-jobs.appflare-dev.workers.dev");
    expect(route?.deleted_at).not.toBeNull();
  });

  it("puts a Worker taken off workers.dev back on it when the update fails before promotion", async () => {
    const r = await updateBoth(
      { previews: [{ status: 500, body: "boom" }] },
      {},
      {},
      { next: false },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^canary check \d+:/);
    expect(r.fake.state.deployments).toHaveLength(1);
    // Off before its upload, back on once the job fails: the serving version wants it.
    expect(r.jobs.state.subdomainCalls).toEqual([
      { enabled: false, previews_enabled: false },
      { enabled: true, previews_enabled: true },
    ]);
    const route = r.resources.find((row) => row.name === "cut-jobs.appflare-dev.workers.dev");
    expect(route?.deleted_at).toBeNull();
  });

  it("keeps a private Worker off workers.dev on every update", async () => {
    const r = await updateBoth({}, {}, {}, { installed: false, next: false });
    expect(r.error).toBeNull();
    expect(r.jobs.state.subdomainCalls).toEqual([{ enabled: false, previews_enabled: false }]);
    expect(r.jobs.state.previewHosts).toEqual([]);
  });

  it("puts a Worker back on workers.dev only once the version that wants it serves", async () => {
    const r = await updateBoth({}, {}, {}, { installed: false, next: true });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    // No preview check: turning previews on would put the serving version on its URL.
    expect(r.jobs.state.previewHosts).toEqual([]);
    expect(r.jobs.state.subdomainCalls).toEqual([{ enabled: true, previews_enabled: true }]);
    const order = r.step.names;
    expect(order.indexOf('enable workers.dev route (Worker "cut-jobs")')).toBeGreaterThan(
      order.indexOf("promote version"),
    );
    const route = r.resources.find((row) => row.name === "cut-jobs.appflare-dev.workers.dev");
    expect(route?.deleted_at).toBeNull();
  });

  it("refuses a version that adds a Worker, before snapshotting", async () => {
    const r = await update({ ...NEW_APP, otherWorkers: [jobsWorker([])] }, {}, {}, {});
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain('This version adds the Worker "jobs" (cut-jobs)');
    expect(r.snapshot).toBeNull();
  });
});

describe("update job, an app of several Workers, failing between promotions", () => {
  const JOBS_OLD = "11111111-2222-4333-8444-555555555555";
  const app = (version: string): ArtifactFixtureOptions => ({
    ...NEW_APP,
    version,
    otherWorkers: [{ name: "jobs", bindings: [{ type: "kv_namespace", name: "CUT_KV" }] }],
  });

  async function failingUpdate(refuseJobsReturn: boolean) {
    const old = await buildArtifactFixture({ ...app("1.0.0"), version: "1.0.0" });
    const jobs = fakeAccount(null, {
      worker: "cut-jobs",
      deployments: [{ id: "dep-j", versions: [{ version_id: JOBS_OLD, percentage: 100 }] }],
    });
    let deploys = 0;
    const r = await update(
      app("1.1.0"),
      // The primary Worker's promotion is refused, after the other Worker's.
      { failOnce: new Map([["POST /workers/scripts/cut/deployments", 400]]) },
      {
        manifestJson: JSON.stringify(old.manifest),
        resources: [...RESOURCES, { kind: "worker", name: "cut-jobs", cfId: "cut-jobs" }],
      },
      {},
      "self",
      async () => {
        await env.DB.prepare("UPDATE installs SET worker_versions_json = ?1 WHERE id = ?2")
          .bind(JSON.stringify({ "cut-jobs": JOBS_OLD }), INSTALL_ID)
          .run();
      },
      (fake) => async (input, init) => {
        const toJobs = input.includes("/workers/scripts/cut-jobs") || input.includes("-cut-jobs.");
        if (toJobs && init?.method === "POST" && input.includes("/cut-jobs/deployments")) {
          deploys += 1;
          if (refuseJobsReturn && deploys > 1) {
            return Response.json(
              { success: false, errors: [{ code: 10000, message: "injected refusal" }] },
              { status: 400 },
            );
          }
        }
        return (toJobs ? jobs : fake).fetch(input, init);
      },
    );
    return { ...r, jobs };
  }

  it("puts the other Workers back on the snapshot's versions when the primary is not promoted", async () => {
    const r = await failingUpdate(false);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^promote version:/);
    // Promoted, then returned (forced, as a rollback deploys).
    expect(r.jobs.state.deployments.map((d) => d.versions[0]?.version_id)).toEqual([
      JOBS_OLD,
      NEW_VERSION,
      JOBS_OLD,
    ]);
    expect(r.jobs.state.deployForced).toEqual([false, true]);
    expect(JSON.parse(String(r.install?.worker_versions_json))).toEqual({ "cut-jobs": JOBS_OLD });
    expect(r.install?.current_version_id).toBe(OLD_VERSION);
    expect(
      r.logs.some((l) => l.message.includes("were back on the versions the snapshot kept")),
    ).toBe(true);
  });

  it("records a Worker it could not put back, and a rollback to the snapshot then returns it", async () => {
    const r = await failingUpdate(true);
    expect(r.job?.status).toBe("failed");
    expect(r.jobs.state.deployments[0]?.versions[0]?.version_id).toBe(NEW_VERSION);
    expect(JSON.parse(String(r.install?.worker_versions_json))).toEqual({
      "cut-jobs": NEW_VERSION,
    });
    expect(r.logs.some((l) => l.message.includes("may still serve the new version"))).toBe(true);

    // The primary Worker runs the snapshot's version, but the other one does
    // not: the snapshot is not current, and a rollback may start.
    const [snapshot] = await listSnapshotsCore(env.DB, INSTALL_ID);
    expect(snapshot?.isCurrent).toBe(false);
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
    const primary = fakeAccount(null, {
      deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    });
    await runRollback({
      params,
      step: fakeStep(),
      env: { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN },
      deps: {
        fetch: async (input, init) =>
          (input.includes("/workers/scripts/cut-jobs") ? r.jobs : primary).fetch(input, init),
      },
    });
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 'rb1'").first<{
      status: string;
    }>();
    expect(job?.status).toBe("succeeded");
    expect(r.jobs.state.deployments[0]?.versions[0]?.version_id).toBe(JOBS_OLD);
    const install = await env.DB.prepare("SELECT worker_versions_json FROM installs WHERE id = ?1")
      .bind(INSTALL_ID)
      .first<{ worker_versions_json: string }>();
    expect(JSON.parse(install?.worker_versions_json ?? "null")).toEqual({ "cut-jobs": JOBS_OLD });
    // Now nothing differs from the snapshot: no second rollback.
    await expect(
      startRollbackCore(
        { db: env.DB, createJob: async (id) => ({ id }), newId: () => "rb2" },
        { installId: INSTALL_ID, snapshotId: "job1" },
      ),
    ).rejects.toThrow(/already runs the version/);
  });
});

describe("update job, an app of many Workers", () => {
  /** A router Worker (the primary one) bound to 17 others, as Cloudflare OS is. */
  const OTHER_NAMES = [
    "backend",
    ...Array.from({ length: 16 }, (_, i) => `gk-${String(i + 1).padStart(2, "0")}`),
  ];
  const oldVersionOf = (i: number) => `22222222-0000-4000-8000-${String(i).padStart(12, "0")}`;
  const app = (version: string): ArtifactFixtureOptions => ({
    ...NEW_APP,
    version,
    bindings: [
      ...(NEW_APP.bindings ?? []),
      ...OTHER_NAMES.map((name) => ({
        type: "service",
        name: name.toUpperCase().replace(/-/g, "_"),
        service: `{{workerName:${name}}}`,
      })),
    ],
    otherWorkers: OTHER_NAMES.map((name) => ({
      name,
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
    })),
    catalog: { plan: "paid" },
  });

  /** Runs the update with a fake account per other Worker, each serving its old version. */
  async function updateMany(world: Partial<FakeAccount> = {}) {
    const old = await buildArtifactFixture(app("1.0.0"));
    const accounts = new Map(
      OTHER_NAMES.map((name, i) => [
        `cut-${name}`,
        fakeAccount(null, {
          worker: `cut-${name}`,
          deployments: [
            { id: `dep-${i}`, versions: [{ version_id: oldVersionOf(i), percentage: 100 }] },
          ],
        }),
      ]),
    );
    const oldVersions = Object.fromEntries(
      OTHER_NAMES.map((name, i) => [`cut-${name}`, oldVersionOf(i)]),
    );
    const r = await update(
      app("1.1.0"),
      world,
      {
        manifestJson: JSON.stringify(old.manifest),
        resources: [
          ...RESOURCES,
          ...OTHER_NAMES.map((name) => ({
            kind: "worker",
            name: `cut-${name}`,
            cfId: `cut-${name}`,
          })),
        ],
      },
      { paidConfirmed: true },
      "self",
      async () => {
        await env.DB.prepare("UPDATE installs SET worker_versions_json = ?1 WHERE id = ?2")
          .bind(JSON.stringify(oldVersions), INSTALL_ID)
          .run();
      },
      (fake) => async (input, init) => {
        const name =
          /\/workers\/scripts\/(cut-[a-z0-9-]+)/.exec(input)?.[1] ??
          /^https:\/\/[0-9a-f]{8}-(cut-[a-z0-9-]+)\./.exec(input)?.[1];
        return ((name === undefined ? undefined : accounts.get(name)) ?? fake).fetch(input, init);
      },
    );
    return { ...r, accounts, oldVersions };
  }

  it("updates 18 Workers, each in steps of its own, within the job's planned budget", async () => {
    const r = await updateMany();
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const names = r.step.names;
    expect(new Set(names).size).toBe(names.length);
    const workers = entryWorkers(r.fixture.manifest, "cut");
    for (const w of workers.filter((w) => !w.primary)) {
      const label = ` (Worker "${w.scriptName}")`;
      const own = names.filter((n) => n.includes(label));
      // Its own upload, canary and promotion, each a step; promoted before the primary.
      expect(own).toContain(`upload Worker version${label}`);
      expect(own).toContain(`canary${label} check 1`);
      expect(own).toContain(`promote version${label}`);
      expect(names.indexOf(`promote version${label}`)).toBeLessThan(
        names.indexOf("promote version"),
      );
      const sleeps = r.step.sleeps.filter((s) => s.includes(label));
      expect(own.length + sleeps.length).toBeLessThanOrEqual(
        otherWorkerCost(w, "update", CANARY_MAX_ATTEMPTS).steps,
      );
      expect(r.accounts.get(w.scriptName)?.state.deployments[0]?.versions[0]?.version_id).toBe(
        NEW_VERSION,
      );
    }
    const planned = entryJobCost(workers, "update", CANARY_MAX_ATTEMPTS);
    expect(names.length + r.step.sleeps.length).toBeLessThanOrEqual(planned.steps);
    const recorded = JSON.parse(String(r.install?.worker_versions_json)) as Record<string, string>;
    expect(Object.values(recorded)).toEqual(OTHER_NAMES.map(() => NEW_VERSION));
    expect(JSON.parse(String(r.snapshot?.worker_versions_json))).toEqual(r.oldVersions);
  });

  it("puts all 17 other Workers back when the primary one is not promoted", async () => {
    const r = await updateMany({
      failOnce: new Map([["POST /workers/scripts/cut/deployments", 400]]),
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^promote version:/);
    for (const [i, name] of OTHER_NAMES.entries()) {
      const account = r.accounts.get(`cut-${name}`);
      expect(account?.state.deployments.map((d) => d.versions[0]?.version_id)).toEqual([
        oldVersionOf(i),
        NEW_VERSION,
        oldVersionOf(i),
      ]);
    }
    expect(JSON.parse(String(r.install?.worker_versions_json))).toEqual(r.oldVersions);
    expect(r.install?.current_version_id).toBe(OLD_VERSION);
  });
});

describe("update job, an app protected with Cloudflare Access", () => {
  it("takes public paths the new version drops off before it serves, and adds its own after", async () => {
    const access = fakeAccessAccount();
    access.scripts.push({ id: "cut", tag: "tag-cut" });
    const uris = () =>
      [...access.apps.values()]
        .filter((a) => String(a.name).endsWith("public paths"))
        .flatMap((a) => (a.destinations as Array<{ uri: string }>).map((d) => d.uri));
    const seen: string[][] = [];
    const r = await update(
      { ...NEW_APP, catalog: { ...NEW_APP.catalog, access: { bypass: ["/s/*", "/new/*"] } } },
      {},
      {
        manifestJson: JSON.stringify({
          version: "1.0.0",
          worker: { migrations: [] },
          catalog: { name: "Cut", access: { bypass: ["/s/*", "/old/*"] } },
        }),
      },
      {},
      "self",
      async () => {
        await env.DB.prepare(
          "INSERT INTO user (id, name, email, role) VALUES ('u1', 'Owner', 'owner@example.com', 'admin')",
        ).run();
        await protectInstall(
          { db: env.DB, client: access.client, authSecret: "a".repeat(32) },
          { installId: INSTALL_ID },
        );
      },
      (fake) => async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.includes("/access/") || path.endsWith("/workers/scripts")) {
          const response = await access.fetch(String(input), init);
          if (init?.method === "PUT") seen.push(uris());
          return response;
        }
        return fake.fetch(String(input), init);
      },
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const at = (name: string) => r.step.names.indexOf(name);
    expect(at("take dropped public paths off Cloudflare Access")).toBeLessThan(
      at("promote version"),
    );
    expect(at("update Cloudflare Access destinations")).toBeGreaterThan(at("finish"));
    expect(uris()).toEqual([
      "cut.appflare-dev.workers.dev/s/*",
      "cut.appflare-dev.workers.dev/new/*",
    ]);
    // Before the new version served, only the path both versions share was public.
    expect(seen).toContainEqual(["cut.appflare-dev.workers.dev/s/*"]);
  });
});
