import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { buildKeys, sandboxObjectUrl } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { readInstallSettingsCore, startReconfigureCore } from "../installs/reconfigure.server";
import type { StartReconfigureInput } from "../installs/reconfigure-input";
import { listSnapshotsCore, startRollbackCore } from "../installs/versions.server";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  baseCatalog,
  buildArtifactFixture,
  ZIP_URL,
} from "../test/artifact-fixture";
import {
  ACC,
  type FakeAccount,
  fakeAccount,
  NEW_VERSION,
  SUBDOMAIN,
  TOKEN,
} from "../test/fake-account";
import { fakeEmailRouting, ZONE_ID } from "../test/fake-email-routing";
import { type FakeSandbox, fakeSandbox } from "../test/fake-sandbox";
import { fakeSelf } from "../test/fake-self";
import { type FakeStep, fakeStep } from "../test/fake-step";
import { INSTALL_ID, OLD_VERSION, type SeedResource, seedInstall } from "../test/seed-install";
import { type ReconfigureJobParams, runReconfigure } from "./reconfigure";
import { type RollbackJobParams, runRollback } from "./rollback";
import type { JobEnv } from "./run-job";

/**
 * End-to-end test of the settings change job (`reconfigure`) against the
 * stateful fake of the Cloudflare API, the fake artifact host, and the local
 * D1, started through the same function the app page calls. The Workflow
 * engine is `fakeStep` (or a variant that runs a step twice).
 */

const ROTATED = "rotated-admin-password-DO-NOT-LEAK";

/** The fake account of the running test, for a step that changes it midway. */
let state: FakeAccount;

const RESOURCES: SeedResource[] = [
  { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
  { kind: "d1", binding: "DB", name: "cut-db", cfId: "d1-1" },
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
  { kind: "secret", binding: "OLD_TOKEN", name: "OLD_TOKEN" },
  { kind: "subdomain", name: "cut.appflare-dev.workers.dev" },
];

const APP: ArtifactFixtureOptions = {
  bindings: [
    { type: "kv_namespace", name: "CUT_KV" },
    { type: "d1", name: "DB" },
  ],
  assets: [{ route: "/app.js", content: "console.log('v1')" }],
  catalog: {
    vars: [
      { name: "HOME_PAGE", label: "Home page", help: "default", required: false },
      { name: "TITLE", label: "Title", default: "Cut on {{workerName}}", required: true },
    ],
  },
};

/** The fake Workflow engine, except that steps named `name` run a second time after they finished. */
function replayingStep(name: string): FakeStep {
  const step = fakeStep();
  const run = step.do.bind(step) as (n: string, ...rest: unknown[]) => Promise<unknown>;
  const again = async (n: string, ...rest: unknown[]) => {
    const result = await run(n, ...rest);
    return n === name ? run(n, ...rest) : result;
  };
  return Object.assign(step, { do: again as FakeStep["do"] });
}

/** Seeds the installed app as its install left it: the fixture's manifest, digest and zip. */
async function seed(
  fixture: ArtifactFixture,
  opts: { buildKind?: "artifact" | "sandbox"; resources?: SeedResource[] } = {},
): Promise<void> {
  await seedInstall({
    manifestJson: new TextDecoder().decode(fixture.manifestBytes),
    resources: opts.resources ?? RESOURCES,
  });
  const zip =
    opts.buildKind === "sandbox"
      ? sandboxObjectUrl(buildKeys(INSTALL_ID, "1.0.0", "cut").artifact)
      : ZIP_URL;
  await env.DB.prepare(
    "UPDATE installs SET artifact_url = ?2, artifact_digest = ?3, build_kind = ?4 WHERE id = ?1",
  )
    .bind(INSTALL_ID, zip, fixture.digest, opts.buildKind ?? "artifact")
    .run();
}

interface RunOptions {
  app?: ArtifactFixtureOptions;
  world?: Partial<FakeAccount>;
  request?: Partial<StartReconfigureInput>;
  step?: FakeStep;
  buildKind?: "artifact" | "sandbox";
  /** Runs after the install is seeded and the job started, before the job runs. */
  beforeRun?: (fake: ReturnType<typeof fakeAccount>) => void;
  resources?: SeedResource[];
  /** Answers some requests before the fake account does (another fake in front). */
  front?: (request: Request) => Promise<Response | null>;
  /** The install's stored workers.dev choice (on unless set). */
  workersDev?: boolean;
}

async function reconfigure(opts: RunOptions = {}) {
  const fixture = await buildArtifactFixture(opts.app ?? APP);
  const account = fakeAccount(fixture, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    bookmarks: { "d1-1": "00000001-bookmark-before" },
    // The installed version's assets are in the account already.
    uploadedAssets: new Set(fixture.manifest.assets.files.map((f) => f.hash)),
    ...opts.world,
  });
  const front = opts.front;
  const fake =
    front === undefined
      ? account
      : {
          ...account,
          fetch: async (input: string, init?: RequestInit) =>
            (await front(new Request(input, init))) ?? account.fetch(input, init),
        };
  await seed(fixture, {
    buildKind: opts.buildKind ?? "artifact",
    ...(opts.resources === undefined ? {} : { resources: opts.resources }),
  });
  if (opts.workersDev === false) {
    await env.DB.prepare("UPDATE installs SET workers_dev_enabled = 0 WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
  }
  const sandbox: FakeSandbox | undefined =
    opts.buildKind === "sandbox"
      ? fakeSandbox(fixture, { stored: [{ installId: INSTALL_ID, version: "1.0.0", slug: "cut" }] })
      : undefined;
  let params: ReconfigureJobParams | null = null;
  const { jobId } = await startReconfigureCore(
    {
      db: env.DB,
      sandboxConnected: sandbox !== undefined,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => "job1",
    },
    {
      installId: INSTALL_ID,
      vars: { HOME_PAGE: "links", TITLE: "My links" },
      secrets: { set: { ADMIN_PASSWORD: ROTATED }, unset: ["OLD_TOKEN"] },
      ...opts.request,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  opts.beforeRun?.(fake);
  const jobEnv: JobEnv = {
    DB: env.DB,
    KV: env.KV,
    CF_API_TOKEN: TOKEN,
    ...(sandbox === undefined ? {} : { SANDBOX: sandbox }),
  };
  const step = opts.step ?? fakeStep();
  const self = fakeSelf(jobEnv, { fetch: fake.fetch });
  let error: unknown = null;
  try {
    await runReconfigure({
      params,
      step,
      env: { ...jobEnv, SELF: self },
      deps: { fetch: fake.fetch, signingKeys: fixture.keys },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(jobId).first<{
    status: string;
    kind: string;
    error: string | null;
    worker_version_id: string | null;
    input_json: string;
  }>();
  const install = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
    .bind(INSTALL_ID)
    .first<Record<string, unknown>>();
  const snapshot = await env.DB.prepare("SELECT * FROM snapshots WHERE job_id = ?1")
    .bind(jobId)
    .first<Record<string, unknown>>();
  const secrets = (
    await env.DB.prepare(
      "SELECT name, deleted_at FROM resources WHERE install_id = ?1 AND kind = 'secret' ORDER BY rowid",
    )
      .bind(INSTALL_ID)
      .all<{ name: string; deleted_at: number | null }>()
  ).results;
  const logs = (
    await env.DB.prepare(
      "SELECT level, message, data_json FROM job_logs WHERE job_id = ?1 ORDER BY id",
    )
      .bind(jobId)
      .all<{ level: string; message: string; data_json: string | null }>()
  ).results;
  return {
    fixture,
    fake,
    step,
    self,
    sandbox,
    error,
    job,
    install,
    snapshot,
    secrets,
    logs,
    params,
  };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("settings change job", () => {
  it("uploads the installed version with the new settings, patches the secrets, checks, promotes, records", async () => {
    const r = await reconfigure();
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({
      kind: "reconfigure",
      status: "succeeded",
      error: null,
      worker_version_id: "version-1",
    });
    expect(r.step.names).toEqual([
      "start",
      "plan settings change",
      "look up workers.dev subdomain",
      "read current deployment",
      "bookmark D1 cut-db",
      "record snapshot",
      "open assets upload session",
      "upload Worker version",
      "record Worker version",
      "set and remove secrets",
      "enable version previews",
      "canary check 1",
      "canary check 2",
      "promote version",
      "record settings",
      "health check 1",
      "finish",
    ]);
    // The only unit is the upload; nothing was built, no asset was uploaded again.
    expect(r.self.calls.map((c) => c.unit)).toEqual(["uploadWorker"]);

    // The upload: the same artifact, every non-secret binding, the new vars, secrets kept.
    const [uploaded, patched] = r.fake.state.versions;
    expect(uploaded?.id).toBe(NEW_VERSION);
    expect(uploaded?.metadata).toEqual({
      main_module: "worker.js",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" },
        { type: "d1", name: "DB", id: "d1-1" },
        { type: "plain_text", name: "HOME_PAGE", text: "links" },
        { type: "plain_text", name: "TITLE", text: "My links" },
      ],
      assets: { jwt: "session-jwt", config: {} },
      keep_bindings: ["secret_text"],
      annotations: { "workers/message": "Appflare: settings of cut 1.0.0", "workers/tag": "1.0.0" },
    });
    expect(uploaded?.modules).toEqual(["worker.js"]);

    // The secrets: one merge patch on top of the upload, before anything served it.
    expect(r.fake.state.versionPatches).toEqual([
      {
        env: { ADMIN_PASSWORD: { type: "secret_text", text: ROTATED }, OLD_TOKEN: null },
        annotations: {
          "workers/message": "Appflare: settings change job1",
          "workers/tag": "1.0.0",
        },
      },
    ]);
    expect(patched?.id).toBe("version-1");
    const calls = r.fake.state.calls;
    expect(calls.indexOf("PATCH /workers/workers/cut/versions/latest")).toBeLessThan(
      calls.indexOf("POST /workers/scripts/cut/deployments"),
    );
    // No secret was set on the script (that would deploy at once).
    expect(calls.some((c) => c.includes("/secrets"))).toBe(false);

    // The canary probed the patched version; that version was promoted.
    expect(r.fake.state.previewHosts[0]).toBe(`version1-cut.${SUBDOMAIN}.workers.dev`);
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: "version-1", percentage: 100 },
    ]);

    // The record: new version, settings, secret names; the snapshot keeps the old settings.
    expect(r.install).toMatchObject({
      status: "installed",
      catalog_version: "1.0.0",
      current_version_id: "version-1",
      config_json: '{"HOME_PAGE":"links","TITLE":"My links"}',
      health_status: "verified",
    });
    expect(r.secrets).toEqual([
      { name: "ADMIN_PASSWORD", deleted_at: null },
      { name: "OLD_TOKEN", deleted_at: expect.any(Number) },
    ]);
    expect(r.snapshot).toMatchObject({
      worker_version_id: OLD_VERSION,
      catalog_version: "1.0.0",
      target_catalog_version: "1.0.0",
      config_json: '{"HOME_PAGE":"admin"}',
    });

    // Secret values stay out of D1 and the log; names are recorded.
    expect(JSON.parse(r.job?.input_json ?? "{}")).toEqual({
      installId: INSTALL_ID,
      version: "1.0.0",
      vars: ["HOME_PAGE", "TITLE"],
      secrets: { set: ["ADMIN_PASSWORD"], unset: ["OLD_TOKEN"] },
    });
    const everything = JSON.stringify(r.logs);
    expect(everything).not.toContain(ROTATED);
    expect(everything).not.toContain(TOKEN);
    expect(everything).toContain("set new values of ADMIN_PASSWORD and removed OLD_TOKEN");
    expect(r.logs.at(-1)?.message).toBe(
      "Changed the settings of cut at https://cut.appflare-dev.workers.dev/ (health: verified (HTTP 200)).",
    );
  });

  it("keeps workers.dev as stored and checks health on the first custom domain while it is off", async () => {
    const r = await reconfigure({
      workersDev: false,
      resources: [...RESOURCES, { kind: "domain", name: "links.example.com", cfId: "dom-1" }],
      world: { domainHealth: { "links.example.com": [{ status: 200, body: "ok" }] } },
    });
    expect(r.error).toBeNull();
    expect(r.fake.state.subdomainCalls).toEqual([{ enabled: false, previews_enabled: true }]);
    expect(r.fake.state.domainProbes).toEqual(["links.example.com"]);
    expect(r.install).toMatchObject({ health_status: "verified", workers_dev_enabled: 0 });
  });

  it("promotes the uploaded version itself when no secret changes", async () => {
    const r = await reconfigure({ request: { secrets: { set: {}, unset: [] } } });
    expect(r.error).toBeNull();
    expect(r.step.names).not.toContain("set and remove secrets");
    expect(r.fake.state.versionPatches).toEqual([]);
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: NEW_VERSION, percentage: 100 },
    ]);
    expect(r.install).toMatchObject({ current_version_id: NEW_VERSION });
    expect(r.secrets.every((s) => s.deleted_at === null)).toBe(true);
  });

  it("stores a setting back at its default as no setting at all", async () => {
    const r = await reconfigure({
      request: { vars: {}, secrets: { set: {}, unset: [] } },
    });
    expect(r.error).toBeNull();
    expect(r.install).toMatchObject({ config_json: null });
    const bindings = (r.fake.state.versions[0]?.metadata.bindings ?? []) as unknown[];
    // TITLE follows its catalog default, placeholders filled in for this Worker.
    expect(bindings).toContainEqual({ type: "plain_text", name: "TITLE", text: "Cut on cut" });
    expect(bindings.some((b) => (b as { name: string }).name === "HOME_PAGE")).toBe(false);
  });

  it("patches the secrets once when the step runs again after it finished (replay)", async () => {
    const r = await reconfigure({ step: replayingStep("set and remove secrets") });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded", worker_version_id: "version-1" });
    // Two runs of the step, one patch: the second run found this job's version.
    expect(r.step.names.filter((n) => n === "set and remove secrets")).toHaveLength(2);
    expect(r.fake.state.versionPatches).toHaveLength(1);
    expect(r.fake.state.versions.map((v) => v.id)).toEqual([NEW_VERSION, "version-1"]);
    expect(r.fake.state.deployments[0]?.versions).toEqual([
      { version_id: "version-1", percentage: 100 },
    ]);
    expect(
      r.logs.some((l) => l.message.includes("already carries this job's secret changes")),
    ).toBe(true);
    expect(JSON.stringify(r.logs)).not.toContain(ROTATED);
  });

  it("stops before changing anything when another version was uploaded after its own", async () => {
    const r = await reconfigure({
      step: (() => {
        // Someone uploads a version right after the job's upload is recorded.
        const step = fakeStep();
        const run = step.do.bind(step) as (n: string, ...rest: unknown[]) => Promise<unknown>;
        return Object.assign(step, {
          do: (async (n: string, ...rest: unknown[]) => {
            if (n === "set and remove secrets") {
              state.versions.push({ id: "someone-else", metadata: {}, modules: [] });
            }
            return run(n, ...rest);
          }) as FakeStep["do"],
        });
      })(),
      beforeRun: (fake) => {
        state = fake.state;
      },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /^set and remove secrets: another version of the Worker \(someone-else\) was uploaded/,
    );
    expect(r.fake.state.versionPatches).toEqual([]);
    expect(r.fake.state.calls).not.toContain("POST /workers/scripts/cut/deployments");
    expect(r.install).toMatchObject({
      status: "installed",
      current_version_id: OLD_VERSION,
      config_json: '{"HOME_PAGE":"admin"}',
    });
    expect(r.secrets.every((s) => s.deleted_at === null)).toBe(true);
  });

  it("fails at the canary without promoting, and gives the newest version the serving secrets back", async () => {
    const r = await reconfigure({ world: { previews: [{ status: 500, body: "boom" }] } });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe("canary check 6: the Worker answered HTTP 500");
    expect(r.step.names.slice(-2)).toEqual([
      "put back the previous secrets",
      "mark settings change failed",
    ]);
    expect(r.fake.state.calls).not.toContain("POST /workers/scripts/cut/deployments");
    // The next upload keeps the newest version's secrets, so the newest gets
    // the serving version's back: the rotated one inherits its old binding,
    // the removed one comes back the same way.
    expect(r.fake.state.versionPatches.at(-1)).toEqual({
      env: {
        ADMIN_PASSWORD: { type: "inherit", version_id: OLD_VERSION },
        OLD_TOKEN: { type: "inherit", version_id: OLD_VERSION },
      },
      annotations: { "workers/message": "Appflare: settings change job1 undone" },
    });
    expect(r.install).toMatchObject({
      status: "installed",
      current_version_id: OLD_VERSION,
      config_json: '{"HOME_PAGE":"admin"}',
    });
    expect(r.secrets.every((s) => s.deleted_at === null)).toBe(true);
    expect(r.logs.at(-1)?.message).toBe(
      'Settings change failed at "canary check 6". Version version-1 was uploaded but never promoted; the previous version keeps serving all traffic with the previous settings and secrets. The Worker\'s newest version has the previous secret values back, so the next update does not pick up the new ones.',
    );
  });

  it("drops a secret the serving version never had when it puts the secrets back", async () => {
    const r = await reconfigure({
      app: {
        ...APP,
        catalog: {
          ...APP.catalog,
          secrets: [
            { name: "ADMIN_PASSWORD", label: "Admin password", generate: true },
            { name: "API_KEY", label: "API key", generate: false },
          ],
        },
      },
      world: { previews: [{ status: 500, body: "boom" }] },
      request: { secrets: { set: { API_KEY: "new-key" }, unset: [] } },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.fake.state.versionPatches.at(-1)).toMatchObject({ env: { API_KEY: null } });
  });

  it("puts the secrets back once when that step runs again (replay)", async () => {
    const r = await reconfigure({
      world: { previews: [{ status: 500, body: "boom" }] },
      step: replayingStep("put back the previous secrets"),
    });
    expect(r.job?.status).toBe("failed");
    // The change's patch and one undo patch; the replay found the undo done.
    expect(r.fake.state.versionPatches).toHaveLength(2);
    expect(r.logs.some((l) => l.message.includes("already has the secrets of the serving"))).toBe(
      true,
    );
  });

  it("changes nothing when the serving version cannot be read for the snapshot", async () => {
    const r = await reconfigure({
      world: { failOnce: new Map([["GET /workers/scripts/cut/deployments", 400]]) },
    });
    expect(r.job?.error).toMatch(/^read current deployment: /);
    expect(r.fake.state.versions).toEqual([]);
    expect(r.install).toMatchObject({
      status: "installed",
      current_version_id: OLD_VERSION,
      config_json: '{"HOME_PAGE":"admin"}',
    });
    expect(r.logs.at(-1)?.message).toBe(
      'Settings change failed at "read current deployment". Nothing was deployed; the app keeps its previous settings and secrets.',
    );
  });

  it("reads a sandbox tier app's stored build through the sandbox Worker instead of building", async () => {
    const r = await reconfigure({ buildKind: "sandbox" });
    expect(r.error).toBeNull();
    expect(r.sandbox?.requests).toEqual([]);
    const zip = sandboxObjectUrl(buildKeys(INSTALL_ID, "1.0.0", "cut").artifact);
    expect(r.sandbox?.fetches.some((f) => f.startsWith(`GET ${zip} bytes=`))).toBe(true);
    expect(r.step.names).not.toContain("build in sandbox");
    expect(r.install).toMatchObject({ build_kind: "sandbox", artifact_url: zip });
  });

  it("asks to confirm when a Worker with Durable Objects cannot be checked on a preview", async () => {
    const app: ArtifactFixtureOptions = {
      ...APP,
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "d1", name: "DB" },
        { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
      ],
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
    };
    const resources = [...RESOURCES, { kind: "durable_object", binding: "ROOMS", name: "Room" }];
    const fixture = await buildArtifactFixture(app);
    await seed(fixture, { resources });
    await env.DB.prepare("UPDATE installs SET do_migration_tag = 'v1' WHERE id = ?1")
      .bind(INSTALL_ID)
      .run();
    await expect(
      startReconfigureCore(
        { db: env.DB, createJob: async (id) => ({ id }) },
        { installId: INSTALL_ID, vars: { TITLE: "x" } },
      ),
    ).rejects.toThrow(/no version preview URL.*Confirm saving without that check/);
  });
});

describe("starting a settings change", () => {
  async function start(input: Partial<StartReconfigureInput>) {
    return startReconfigureCore(
      { db: env.DB, createJob: async (id) => ({ id }), newId: () => "job9" },
      { installId: INSTALL_ID, ...input },
    );
  }

  beforeEach(async () => {
    await seed(await buildArtifactFixture(APP));
  });

  it("refuses while another job of the install is queued or running", async () => {
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('busy', ?1, 'update', 'running')",
    )
      .bind(INSTALL_ID)
      .run();
    await expect(start({ vars: { TITLE: "x" } })).rejects.toThrow(
      /Another job of this install is queued or running/,
    );
    const jobs = await env.DB.prepare("SELECT id FROM jobs").all();
    expect(jobs.results).toEqual([{ id: "busy" }]);
  });

  it("refuses settings and secrets the installed version does not allow", async () => {
    await expect(start({ vars: { NOPE: "x" } })).rejects.toThrow("Cut has no setting NOPE.");
    await expect(
      start({ vars: { TITLE: "  " }, secrets: { set: {}, unset: [] } }),
    ).resolves.toEqual({ jobId: "job9" });
    await env.DB.prepare("DELETE FROM jobs").run();
    await env.DB.prepare("UPDATE installs SET status = 'installed'").run();
    await expect(start({ secrets: { set: {}, unset: ["ADMIN_PASSWORD"] } })).rejects.toThrow(
      /required by the installed version; it can be replaced, not removed/,
    );
    await expect(start({ secrets: { set: { ADMIN_PASSWORD: "" }, unset: [] } })).rejects.toThrow(
      /Enter a new value for Admin password/,
    );
    await expect(
      start({ emailRouting: { zoneId: "zone1" }, vars: { TITLE: "x" } }),
    ).rejects.toThrow("Cut does not receive email; it takes no zone.");
  });

  it("refuses to start when nothing changes", async () => {
    await expect(start({ vars: { HOME_PAGE: "admin" } })).rejects.toThrow(/^Nothing to save/);
  });

  it("keeps secret values out of the job record", async () => {
    await start({ secrets: { set: { ADMIN_PASSWORD: ROTATED }, unset: [] } });
    const job = await env.DB.prepare("SELECT kind, input_json FROM jobs WHERE id = 'job9'").first<{
      kind: string;
      input_json: string;
    }>();
    expect(job?.kind).toBe("reconfigure");
    expect(job?.input_json).not.toContain(ROTATED);
    const install = await env.DB.prepare("SELECT status FROM installs").first();
    expect(install).toEqual({ status: "updating" });
  });
});

describe("the Settings section", () => {
  it("shows the settings with what is stored, the secrets by name, and what may be removed", async () => {
    await seed(await buildArtifactFixture(APP));
    const settings = await readInstallSettingsCore(
      { db: env.DB, sandboxConnected: false, subdomain: SUBDOMAIN },
      INSTALL_ID,
    );
    expect(settings).toMatchObject({
      kind: "artifact",
      unavailable: null,
      placeholders: { workerName: "cut", workerUrl: `https://cut.${SUBDOMAIN}.workers.dev` },
      canRemoveSecrets: true,
      email: null,
      skipsPreview: null,
      installer: null,
    });
    expect(settings?.fields.map((f) => [f.name, f.stored, f.shownDefault])).toEqual([
      ["HOME_PAGE", "admin", ""],
      ["TITLE", null, "Cut on {{workerName}}"],
    ]);
    expect(settings?.secrets.map((s) => [s.name, s.declared, s.present])).toEqual([
      ["ADMIN_PASSWORD", true, true],
      ["OLD_TOKEN", false, true],
    ]);
  });

  it("says why a sandbox tier app's settings cannot change without the sandbox Worker", async () => {
    await seed(await buildArtifactFixture(APP), { buildKind: "sandbox" });
    const settings = await readInstallSettingsCore(
      { db: env.DB, sandboxConnected: false, subdomain: SUBDOMAIN },
      INSTALL_ID,
    );
    expect(settings?.unavailable).toMatch(/not connected to one/);
    await expect(
      startReconfigureCore(
        { db: env.DB, createJob: async (id) => ({ id }) },
        { installId: INSTALL_ID, vars: { TITLE: "x" } },
      ),
    ).rejects.toThrow(/not connected to one/);
  });
});

describe("rolling back a settings change", () => {
  it("puts the previous settings and secret list back with the previous version", async () => {
    const r = await reconfigure();
    expect(r.error).toBeNull();
    // The change removed OLD_TOKEN; the version it replaced still has it.
    r.fake.state.versionSecrets[OLD_VERSION] = ["ADMIN_PASSWORD", "OLD_TOKEN"];
    const [snapshot] = await listSnapshotsCore(env.DB, INSTALL_ID);
    expect(snapshot).toMatchObject({ jobKind: "reconfigure", fromVersionId: OLD_VERSION });
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
      { installId: INSTALL_ID, snapshotId: snapshot?.id ?? "" },
    );
    if (params === null) throw new Error("no Workflow params");
    await runRollback({
      params,
      step: fakeStep(),
      env: { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN },
      deps: { fetch: r.fake.fetch },
    });
    const install = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
      .bind(INSTALL_ID)
      .first<Record<string, unknown>>();
    expect(install).toMatchObject({
      status: "installed",
      current_version_id: OLD_VERSION,
      config_json: '{"HOME_PAGE":"admin"}',
    });
    const settings = await readInstallSettingsCore(
      { db: env.DB, sandboxConnected: false, subdomain: SUBDOMAIN },
      INSTALL_ID,
    );
    expect(settings?.secrets.map((s) => [s.name, s.present])).toEqual([
      ["ADMIN_PASSWORD", true],
      ["OLD_TOKEN", true],
    ]);
  });
});

describe("moving an app's email to another zone", () => {
  const OLD_ZONE = "a".repeat(32);

  it("sets up the new zone first, then removes the old zone's routes, deploying nothing", async () => {
    const oldZone = fakeEmailRouting(ACC, {
      zone: {
        id: OLD_ZONE,
        name: "old.test",
        status: "active",
        type: "full",
        account: { id: ACC },
      },
      routingEnabled: true,
      rules: [
        {
          id: "rule-old",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "inbox@old.test" }],
          actions: [{ type: "worker", value: ["cut"] }],
        },
      ],
    });
    const newZone = fakeEmailRouting(ACC);
    const order: string[] = [];
    const r = await reconfigure({
      app: {
        ...APP,
        catalog: {
          ...APP.catalog,
          install: { ...baseCatalog().install, emailRouting: { rules: ["inbox"] } },
        },
      },
      resources: [
        ...RESOURCES,
        { kind: "email_route", name: "old.test", cfId: `routing:${OLD_ZONE}` },
        { kind: "email_route", name: "inbox@old.test", cfId: `rule:${OLD_ZONE}:rule-old` },
      ],
      request: {
        vars: { HOME_PAGE: "admin" },
        secrets: { set: {}, unset: [] },
        emailRouting: { zoneId: ZONE_ID },
      },
      front: async (request) => {
        const answer = (await oldZone.handle(request)) ?? (await newZone.handle(request));
        if (answer !== null) order.push(`${request.method} ${new URL(request.url).pathname}`);
        return answer;
      },
    });
    expect(r.error).toBeNull();
    expect(JSON.parse(r.job?.input_json ?? "{}")).toMatchObject({
      vars: [],
      emailRouting: { zoneId: ZONE_ID },
    });

    // The new zone: routing on, the address routed to the Worker.
    expect(newZone.world.routingEnabled).toBe(true);
    expect(newZone.world.rules).toEqual([
      expect.objectContaining({
        matchers: [{ type: "literal", field: "to", value: "inbox@example.com" }],
        actions: [{ type: "worker", value: ["cut"] }],
      }),
    ]);
    // The old zone: its rule deleted and routing given back, as an uninstall would.
    expect(oldZone.world.rules).toEqual([]);
    expect(oldZone.world.routingEnabled).toBe(false);
    // New routes first, so mail is never unrouted; all of it after the promotion.
    const created = order.findIndex((c) => c.endsWith(`/zones/${ZONE_ID}/email/routing/rules`));
    const deleted = order.findIndex((c) => c.endsWith("/rules/rule-old"));
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(deleted);
    const steps = r.step.names;
    // Only email changed: rules name the Worker, so nothing is deployed.
    expect(steps).not.toContain("record snapshot");
    expect(steps).not.toContain("upload Worker version");
    expect(r.fake.state.versions).toEqual([]);
    expect(steps.indexOf("check Email Routing")).toBeLessThan(
      steps.indexOf("route inbox@example.com to the Worker"),
    );
    expect(r.logs.at(-1)?.message).toBe("Changed where cut receives email.");

    const routes = (
      await env.DB.prepare(
        "SELECT name, deleted_at FROM resources WHERE install_id = ?1 AND kind = 'email_route' ORDER BY rowid",
      )
        .bind(INSTALL_ID)
        .all<{ name: string; deleted_at: number | null }>()
    ).results;
    expect(routes).toEqual([
      { name: "old.test", deleted_at: expect.any(Number) },
      { name: "inbox@old.test", deleted_at: expect.any(Number) },
      { name: "example.com", deleted_at: null },
      { name: "inbox@example.com", deleted_at: null },
    ]);
  });

  it("leaves a move to finish when the old zone's routes cannot be removed, and finishes it", async () => {
    const oldZone = fakeEmailRouting(ACC, {
      zone: {
        id: OLD_ZONE,
        name: "old.test",
        status: "active",
        type: "full",
        account: { id: ACC },
      },
      routingEnabled: true,
      rules: [
        {
          id: "rule-old",
          enabled: true,
          matchers: [{ type: "literal", field: "to", value: "inbox@old.test" }],
          actions: [{ type: "worker", value: ["cut"] }],
        },
      ],
      // A token without Email Routing Rules: Edit on the old zone.
      forbidden: [`/zones/${OLD_ZONE}/email/routing/rules/rule-old`],
    });
    const newZone = fakeEmailRouting(ACC);
    const front = async (request: Request) =>
      (await oldZone.handle(request)) ?? (await newZone.handle(request));
    const app: ArtifactFixtureOptions = {
      ...APP,
      catalog: {
        ...APP.catalog,
        install: { ...baseCatalog().install, emailRouting: { rules: ["inbox"] } },
      },
    };
    const r = await reconfigure({
      app,
      resources: [
        ...RESOURCES,
        { kind: "email_route", name: "old.test", cfId: `routing:${OLD_ZONE}` },
        { kind: "email_route", name: "inbox@old.test", cfId: `rule:${OLD_ZONE}:rule-old` },
      ],
      request: {
        vars: { HOME_PAGE: "admin" },
        secrets: { set: {}, unset: [] },
        emailRouting: { zoneId: ZONE_ID },
      },
      front,
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^remove email route inbox@old\.test: /);
    expect(r.logs.at(-1)?.message).toMatch(
      /while removing the old zone's email routes\. The new zone already receives the app's email; finish the move/,
    );
    expect(newZone.world.rules).toHaveLength(1);

    // The page shows the new zone as current and offers to finish the move.
    const settings = await readInstallSettingsCore(
      { db: env.DB, sandboxConnected: false, subdomain: SUBDOMAIN },
      INSTALL_ID,
    );
    expect(settings?.email).toEqual({
      zoneId: ZONE_ID,
      zoneName: "example.com",
      leftover: ["old.test"],
    });

    // Finishing: the same zone again, once the token can delete the rule.
    oldZone.world.forbidden = [];
    let params: ReconfigureJobParams | null = null;
    await startReconfigureCore(
      {
        db: env.DB,
        createJob: async (id, p) => {
          params = p;
          return { id };
        },
        newId: () => "job2",
      },
      { installId: INSTALL_ID, vars: { HOME_PAGE: "admin" }, emailRouting: { zoneId: ZONE_ID } },
    );
    if (params === null) throw new Error("no Workflow params");
    const jobEnv: JobEnv = { DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN };
    await runReconfigure({
      params,
      step: fakeStep(),
      env: { ...jobEnv, SELF: fakeSelf(jobEnv, { fetch: r.fake.fetch }) },
      deps: { fetch: r.fake.fetch },
    });
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 'job2'").first();
    expect(job).toEqual({ status: "succeeded" });
    expect(oldZone.world.rules).toEqual([]);
    expect(oldZone.world.routingEnabled).toBe(false);
    // The new zone was checked again and kept its one rule.
    expect(newZone.world.rules).toHaveLength(1);
    const after = await readInstallSettingsCore(
      { db: env.DB, sandboxConnected: false, subdomain: SUBDOMAIN },
      INSTALL_ID,
    );
    expect(after?.email).toEqual({ zoneId: ZONE_ID, zoneName: "example.com", leftover: [] });
  });
});
