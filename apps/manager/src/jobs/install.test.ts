import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_WORKER_MODULES } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import type { StartInstallInput } from "../installs/install-input";
import { startInstallCore } from "../installs/start-install.server";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  buildArtifactFixture,
} from "../test/artifact-fixture";
import { fakeStep } from "../test/fake-step";
import { API_STEP, type InstallJobParams, runInstall } from "./install";
import type { JobEnv } from "./run-job";

/**
 * End-to-end test of the install job against a stateful
 * fake of the Cloudflare API, a Range-capable fake artifact host, and the local
 * D1. The Workflow engine is replaced by `fakeStep` (inline steps, recorded
 * sleeps); a live install against a real account covers the engine.
 */

const ACC = "acc0000000000000000000000000000a";
const TOKEN = "cf-test-token-DO-NOT-LEAK";
const PASSWORD = "admin-password-DO-NOT-LEAK";
const HEALTH_URL = "https://cut.appflare-dev.workers.dev/";
const VERSION_HEX = "0123456789abcdef0123456789abcdef";

interface FakeState {
  scripts: string[];
  kv: Array<{ id: string; title: string }>;
  d1: Array<{ uuid: string; name: string }>;
  applied: string[];
  queries: string[];
  uploaded: Set<string>;
  bucketHashes: string[];
  bucketUploads: number;
  metadata: Record<string, unknown> | null;
  modules: string[];
  secrets: Record<string, string>;
  schedules: string[];
  subdomainEnabled: unknown;
  calls: string[];
  health: Array<{ status: number; body: string }>;
  workflows: string[];
  /** Keys (`METHOD /path`) whose next call does its work and then answers 500. */
  failAfter: Set<string>;
  /** When set, the script upload is refused with this status. */
  uploadStatus?: number;
}

function fakeWorld(fixture: ArtifactFixture, over: Partial<FakeState> = {}) {
  const state: FakeState = {
    scripts: ["appflare"],
    kv: [],
    d1: [],
    applied: [],
    queries: [],
    uploaded: new Set(),
    bucketHashes: fixture.manifest.assets.files.map((f) => f.hash),
    bucketUploads: 0,
    metadata: null,
    modules: [],
    secrets: {},
    schedules: [],
    subdomainEnabled: null,
    calls: [],
    health: [
      { status: 404, body: "error code: 1042\n" },
      { status: 200, body: "<html>cut</html>" },
    ],
    workflows: [],
    failAfter: new Set(),
    ...over,
  };
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });

  async function cloudflare(request: Request): Promise<Response> {
    const response = await route(request);
    const key = `${request.method} ${new URL(request.url).pathname.replace(`/client/v4/accounts/${ACC}`, "")}`;
    if (state.failAfter.delete(key)) {
      return Response.json(
        { success: false, errors: [{ code: 10013, message: "internal error" }] },
        { status: 500 },
      );
    }
    return response;
  }

  async function route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    state.calls.push(key);
    const auth = request.headers.get("authorization");
    if (path !== "/workers/assets/upload" && auth !== `Bearer ${TOKEN}`) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "auth" }] },
        { status: 403 },
      );
    }
    switch (key) {
      case "GET /tokens/verify":
        return ok({ id: "t", status: "active" });
      case "GET /workers/scripts":
        return ok(state.scripts.map((id) => ({ id })));
      case "GET /storage/kv/namespaces":
        return ok(state.kv, { result_info: { page: 1, total_pages: 1 } });
      case "POST /storage/kv/namespaces": {
        const { title } = (await request.json()) as { title: string };
        const ns = { id: `kv-${state.kv.length + 1}`, title };
        state.kv.push(ns);
        return ok(ns);
      }
      case "GET /d1/database":
        return ok(state.d1, { result_info: { page: 1, total_pages: 1 } });
      case "POST /d1/database": {
        const { name } = (await request.json()) as { name: string };
        const db = { uuid: `d1-${state.d1.length + 1}`, name };
        state.d1.push(db);
        return ok(db);
      }
      case "POST /workers/scripts/cut/assets-upload-session": {
        const needed = state.bucketHashes.filter((h) => !state.uploaded.has(h));
        return ok({ jwt: "session-jwt", buckets: needed.length === 0 ? [] : [needed] });
      }
      case "POST /workers/assets/upload": {
        if (auth !== "Bearer session-jwt") return new Response("bad jwt", { status: 401 });
        const form = await request.formData();
        for (const hash of form.keys()) state.uploaded.add(hash);
        state.bucketUploads += 1;
        const done = state.bucketHashes.every((h) => state.uploaded.has(h));
        return ok({ jwt: done ? "completion-jwt" : null });
      }
      case "PUT /workers/scripts/cut": {
        if (state.uploadStatus !== undefined) {
          return Response.json(
            { success: false, errors: [{ code: 10021, message: "script refused" }] },
            { status: state.uploadStatus },
          );
        }
        const form = await request.formData();
        state.metadata = JSON.parse(String(form.get("metadata")));
        state.modules = [...form.keys()].filter((k) => k !== "metadata");
        state.scripts.push("cut");
        return ok({ id: "cut", deployment_id: VERSION_HEX });
      }
      case "PUT /workers/scripts/cut/secrets": {
        const body = (await request.json()) as { name: string; text: string };
        state.secrets[body.name] = body.text;
        return ok({ name: body.name, type: "secret_text" });
      }
      case "PUT /workers/scripts/cut/schedules": {
        const body = (await request.json()) as Array<{ cron: string }>;
        state.schedules = body.map((s) => s.cron);
        return ok({ schedules: body });
      }
      case "GET /workflows/cut-jobs":
        return state.workflows.includes("cut-jobs")
          ? ok({ id: "wf", name: "cut-jobs", script_name: "appflare" })
          : Response.json(
              { success: false, errors: [{ code: 10200, message: "Workflow not found" }] },
              { status: 404 },
            );
      case "GET /workers/subdomain":
        return ok({ subdomain: "appflare-dev" });
      case "POST /workers/scripts/cut/subdomain":
        state.subdomainEnabled = await request.json();
        return ok({ enabled: true, previews_enabled: true });
    }
    const d1Query = /^POST \/d1\/database\/([^/]+)\/query$/.exec(key);
    if (d1Query) {
      const { sql } = (await request.json()) as { sql: string };
      state.queries.push(sql);
      if (sql.startsWith("SELECT")) {
        return ok([
          {
            results: state.applied.map((name, i) => ({ id: i + 1, name })),
            success: true,
            meta: {},
          },
        ]);
      }
      const m = /values \('([^']+)'\);$/.exec(sql);
      if (m?.[1]) state.applied.push(m[1]);
      return ok([{ results: [], success: true, meta: {} }]);
    }
    return Response.json(
      { success: false, errors: [{ code: 7003, message: `no route ${key}` }] },
      { status: 404 },
    );
  }

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (input.startsWith("https://api.cloudflare.com/")) return cloudflare(request);
    if (input === HEALTH_URL) {
      const next = state.health.length > 1 ? state.health.shift() : state.health[0];
      return new Response(next?.body ?? "", { status: next?.status ?? 500 });
    }
    return fixture.serve(input, init) ?? new Response("not found", { status: 404 });
  };
  return { state, fetch };
}

const jobEnv = (): JobEnv => ({ DB: env.DB, CF_API_TOKEN: TOKEN });

async function start(fixture: ArtifactFixture, over: Partial<StartInstallInput> = {}) {
  let params: InstallJobParams | null = null;
  let n = 0;
  const ids = await startInstallCore(
    {
      db: env.DB,
      loadApp: async () => ({ app: fixture.index, manifest: fixture.manifest }),
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => `id${++n}`,
    },
    {
      slug: "cut",
      workerName: "cut",
      secrets: { ADMIN_PASSWORD: PASSWORD },
      vars: { HOME_PAGE: "admin" },
      paidConfirmed: false,
      ...over,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  return { ...ids, params: params as InstallJobParams };
}

async function install(options: ArtifactFixtureOptions = {}, world: Partial<FakeState> = {}) {
  const fixture = await buildArtifactFixture(options);
  const fake = fakeWorld(fixture, world);
  const { params, jobId, installId } = await start(fixture);
  const step = fakeStep();
  let error: unknown = null;
  try {
    await runInstall({
      params,
      step,
      env: jobEnv(),
      deps: { fetch: fake.fetch, signingKeys: fixture.keys },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(jobId).first<{
    status: string;
    error: string | null;
    started_at: number | null;
    finished_at: number | null;
  }>();
  const installRow = await env.DB.prepare("SELECT * FROM installs WHERE id = ?1")
    .bind(installId)
    .first<{
      status: string;
      current_version_id: string | null;
      manifest_json: string | null;
      do_migration_tag: string | null;
    }>();
  const resources = (
    await env.DB.prepare(
      "SELECT kind, binding, name, cf_id FROM resources WHERE install_id = ?1 ORDER BY rowid",
    )
      .bind(installId)
      .all()
  ).results;
  const logs = (
    await env.DB.prepare(
      "SELECT level, message, data_json FROM job_logs WHERE job_id = ?1 ORDER BY id",
    )
      .bind(jobId)
      .all<{ level: string; message: string; data_json: string | null }>()
  ).results;
  return { fixture, fake, step, error, job, installRow, resources, logs };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
});

describe("install job", () => {
  it("installs an app end to end", async () => {
    const r = await install({
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "d1", name: "DB" },
      ],
      assets: [
        { route: "/app.js", content: "console.log('app')" },
        { route: "/assets/styles.css", content: "body{}" },
      ],
      d1: {
        DB: [
          { name: "0002_more.sql", content: "ALTER TABLE links ADD COLUMN hits INTEGER;" },
          { name: "0001_init.sql", content: "CREATE TABLE links (id TEXT);" },
        ],
      },
      crons: ["*/5 * * * *"],
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.job?.error).toBeNull();
    expect(r.job?.started_at).not.toBeNull();
    expect(r.job?.finished_at).not.toBeNull();
    expect(r.installRow?.status).toBe("installed");
    expect(r.installRow?.current_version_id).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(r.installRow?.manifest_json).toBe(new TextDecoder().decode(r.fixture.manifestBytes));

    expect(r.step.names).toEqual([
      "start",
      "verify artifact manifest",
      "preflight checks",
      "verify API token",
      "check Worker name",
      "check KV namespace cut-cut-kv",
      "create KV namespace cut-cut-kv",
      "record KV namespace cut-cut-kv",
      "check D1 database cut-db",
      "create D1 database cut-db",
      "record D1 database cut-db",
      "open assets upload session",
      "upload assets bucket 1/1",
      "record Worker name",
      "upload Worker script",
      "record Worker script",
      "D1 DB: create d1_migrations table",
      "D1 DB: list applied migrations",
      "D1 DB: apply 0001_init.sql",
      "D1 DB: apply 0002_more.sql",
      "set secret ADMIN_PASSWORD",
      "set cron triggers",
      "look up workers.dev subdomain",
      "enable workers.dev route",
      "health check 1",
      "health check 2",
      "finish",
    ]);
    expect(r.step.sleeps.filter((n) => n.startsWith("health"))).toEqual(["health wait 1"]);
    // D1 writes count as subrequests too, so a run this long crosses one boundary.
    expect(r.step.sleeps.filter((n) => n.startsWith("budget"))).toEqual(["budget 1"]);
    expect(r.step.configs.every((c) => c === API_STEP)).toBe(true);

    // Step 3: resources recorded; step 5: bindings sent with their ids.
    expect(r.resources).toEqual([
      { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cf_id: "kv-1" },
      { kind: "d1", binding: "DB", name: "cut-db", cf_id: "d1-1" },
      { kind: "worker", binding: null, name: "cut", cf_id: "cut" },
      { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD", cf_id: null },
      { kind: "cron", binding: null, name: "*/5 * * * *", cf_id: null },
      { kind: "subdomain", binding: null, name: "cut.appflare-dev.workers.dev", cf_id: null },
    ]);
    expect(r.fake.state.metadata).toEqual({
      main_module: "worker.js",
      compatibility_date: "2024-12-30",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" },
        { type: "d1", name: "DB", id: "d1-1" },
        { type: "plain_text", name: "HOME_PAGE", text: "admin" },
      ],
      assets: { jwt: "completion-jwt", config: {} },
    });
    expect(r.fake.state.modules).toEqual(["worker.js"]);
    expect(r.fake.state.uploaded.size).toBe(2);

    // Step 6: wrangler-style, in filename order.
    expect(r.fake.state.queries[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "d1_migrations"/);
    expect(r.fake.state.applied).toEqual(["0001_init.sql", "0002_more.sql"]);
    expect(r.fake.state.queries[2]).toBe(
      "CREATE TABLE links (id TEXT);\nINSERT INTO \"d1_migrations\" (name)\nvalues ('0001_init.sql');",
    );

    // Steps 7-8.
    expect(r.fake.state.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD });
    expect(r.fake.state.schedules).toEqual(["*/5 * * * *"]);
    expect(r.fake.state.subdomainEnabled).toEqual({ enabled: true, previews_enabled: true });

    // Logs: batched per step, API calls as METHOD path -> status, no secrets.
    const everything = JSON.stringify(r.logs);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("completion-jwt");
    expect(everything).not.toContain("session-jwt");
    expect(everything).toContain(`POST /accounts/${ACC}/storage/kv/namespaces -> 200`);
    expect(r.logs.some((l) => l.level === "warn" && l.message.includes("1042"))).toBe(true);
    expect(r.logs.at(-1)?.message).toMatch(/^Installed cut 1\.0\.0 at https:\/\/cut\.appflare-dev/);
  });

  it("renames Workflows per install and refuses a name that is taken", async () => {
    const bindings = [
      { type: "kv_namespace", name: "CUT_KV" },
      { type: "workflow", name: "JOBS", workflow_name: "jobs", class_name: "JobWorkflow" },
    ];
    const ok = await install({ bindings });
    expect(ok.error).toBeNull();
    expect(ok.step.names).toContain("check Workflow cut-jobs");
    expect((ok.fake.state.metadata?.bindings as unknown[] | undefined)?.[1]).toEqual({
      type: "workflow",
      name: "JOBS",
      workflow_name: "cut-jobs",
      class_name: "JobWorkflow",
    });
    expect(ok.resources).toContainEqual({
      kind: "workflow",
      binding: "JOBS",
      name: "cut-jobs",
      cf_id: null,
    });

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
    const taken = await install({ bindings }, { workflows: ["cut-jobs"] });
    expect(taken.job?.error).toBe(
      'check Workflow cut-jobs: a Workflow named cut-jobs already exists in this account (script "appflare"); Appflare does not adopt existing Workflows',
    );
    expect(taken.fake.state.calls).not.toContain("POST /storage/kv/namespaces");
  });

  it("retries a create whose response was lost without creating twice", async () => {
    const r = await install({}, { failAfter: new Set(["POST /storage/kv/namespaces"]) });
    expect(r.error).toBeNull();
    expect(r.step.retried["create KV namespace cut-cut-kv"]).toBe(2);
    expect(r.fake.state.kv).toEqual([{ id: "kv-1", title: "cut-cut-kv" }]);
    expect(r.resources[0]).toEqual({
      kind: "kv",
      binding: "CUT_KV",
      name: "cut-cut-kv",
      cf_id: "kv-1",
    });
    expect(r.logs.some((l) => l.message.includes("an earlier attempt created"))).toBe(true);
  });

  it("does not re-apply a D1 migration an earlier attempt applied", async () => {
    const r = await install(
      {
        bindings: [{ type: "d1", name: "DB" }],
        d1: { DB: [{ name: "0001_init.sql", content: "CREATE TABLE t (id TEXT);" }] },
      },
      { failAfter: new Set(["POST /d1/database/d1-1/query"]) },
    );
    // The first query (the d1_migrations CREATE) fails after running; later ones pass.
    expect(r.error).toBeNull();
    expect(r.fake.state.applied).toEqual(["0001_init.sql"]);
    expect(r.fake.state.queries.filter((q) => q.startsWith("CREATE TABLE t"))).toHaveLength(1);
  });

  it("counts D1 calls in the subrequest budget", async () => {
    const assets = Array.from({ length: 12 }, (_, i) => ({
      route: `/f${i}.txt`,
      content: `f${i}`,
    }));
    const r = await install({ assets });
    expect(r.error).toBeNull();
    // 12 files x 2 + upload, plus ~20 steps' D1 writes before it, crosses 40.
    expect(r.step.sleeps.some((s) => s.startsWith("budget"))).toBe(true);
  });

  it("uses the session JWT when Cloudflare already has every asset (zero buckets)", async () => {
    const assets = [{ route: "/a.txt", content: "a" }];
    const fixture = await buildArtifactFixture({ assets });
    const r = await install(
      { assets },
      { uploaded: new Set(fixture.manifest.assets.files.map((f) => f.hash)) },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.bucketUploads).toBe(0);
    expect(r.step.names).not.toContain("upload assets bucket 1/1");
    expect((r.fake.state.metadata?.assets as { jwt: string } | undefined)?.jwt).toBe("session-jwt");
  });

  it("sleeps at a budget boundary before a phase would pass 40 subrequests", async () => {
    const assets = Array.from({ length: 30 }, (_, i) => ({
      route: `/f${i}.txt`,
      content: `file ${i}`,
    }));
    const r = await install({ assets });
    expect(r.error).toBeNull();
    expect(r.step.names).toContain("upload assets bucket 1/1 part 1/2");
    expect(r.step.names).toContain("upload assets bucket 1/1 part 2/2");
    expect(r.step.sleeps.filter((s) => s.startsWith("budget"))).toEqual(["budget 1", "budget 2"]);
    expect(r.fake.state.bucketUploads).toBe(2);
    expect((r.fake.state.metadata?.assets as { jwt: string } | undefined)?.jwt).toBe(
      "completion-jwt",
    );
  });

  it("fails without adopting an existing Worker of the same name", async () => {
    const r = await install({}, { scripts: ["appflare", "cut"] });
    expect(r.error).toBeInstanceOf(Error);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      "check Worker name: a Worker named cut already exists in this account; Appflare does not adopt existing Workers",
    );
    expect(r.installRow?.status).toBe("failed");
    expect(r.step.names.at(-1)).toBe("mark install failed");
    expect(r.fake.state.calls).not.toContain("POST /storage/kv/namespaces");
  });

  it("fails without adopting an existing resource, keeping what it created", async () => {
    const r = await install(
      {
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "d1", name: "DB" },
        ],
      },
      { d1: [{ uuid: "someone-elses", name: "cut-db" }] },
    );
    expect(r.job?.error).toBe(
      "check D1 database cut-db: a D1 database named cut-db already exists in this account; Appflare does not adopt existing resources",
    );
    expect(r.resources).toEqual([
      { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cf_id: "kv-1" },
    ]);
  });

  it("rejects an artifact whose manifest does not match the catalog digest", async () => {
    const fixture = await buildArtifactFixture();
    const fake = fakeWorld(fixture);
    const { params, jobId } = await start(fixture);
    const step = fakeStep();
    await expect(
      runInstall({
        params: { ...params, digest: "f".repeat(64) },
        step,
        env: jobEnv(),
        deps: { fetch: fake.fetch, signingKeys: fixture.keys },
      }),
    ).rejects.toThrow(/verify artifact manifest: manifest.json digest/);
    const job = await env.DB.prepare("SELECT error FROM jobs WHERE id = ?1").bind(jobId).first();
    expect(String(job?.error)).toMatch(/^verify artifact manifest: /);
    expect(fake.state.calls).toEqual([]);
  });

  it("gives up on a Worker that never gets past error 1042", async () => {
    const r = await install({}, { health: [{ status: 404, body: "error code: 1042" }] });
    expect(r.job?.error).toBe(
      "health check 10: 404 error code: 1042 (route not live yet) after 10 attempts",
    );
    expect(r.step.sleeps.filter((s) => s.startsWith("health wait"))).toHaveLength(9);
  });

  it("refuses an artifact with more modules than one upload can fetch, before creating anything", async () => {
    const r = await install({
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
      `preflight checks: This app version has ${MAX_WORKER_MODULES + 1} Worker modules, but one upload can fetch at most ${MAX_WORKER_MODULES} within the free plan's 50 subrequests per invocation (2 per module from a release asset). It must be built as ${MAX_WORKER_MODULES} or fewer modules, for example as one bundled module.`,
    );
    expect(r.installRow?.status).toBe("failed");
    expect(r.resources).toEqual([]);
    expect(r.fake.state.calls).toEqual([]);
  });

  it("fails before touching Cloudflare when no API token is configured", async () => {
    const fixture = await buildArtifactFixture();
    const fake = fakeWorld(fixture);
    const { params, jobId } = await start(fixture);
    await expect(
      runInstall({
        params,
        step: fakeStep(),
        env: { DB: env.DB },
        deps: { fetch: fake.fetch, signingKeys: fixture.keys },
      }),
    ).rejects.toThrow(/token is not configured/);
    const job = await env.DB.prepare("SELECT error FROM jobs WHERE id = ?1").bind(jobId).first();
    expect(job?.error).toBe(
      "preflight checks: the Cloudflare API token is not configured; finish setup first",
    );
    expect(fake.state.calls).toEqual([]);
  });

  it("records the Worker before uploading it, so a lost upload response is still owned", async () => {
    const r = await install({}, { failAfter: new Set(["PUT /workers/scripts/cut"]) });
    // The upload is retried and succeeds; the row recorded before it gets the id.
    expect(r.error).toBeNull();
    expect(r.step.names.indexOf("record Worker name")).toBeLessThan(
      r.step.names.indexOf("upload Worker script"),
    );
    expect(r.resources).toContainEqual({
      kind: "worker",
      binding: null,
      name: "cut",
      cf_id: "cut",
    });
  });

  it("releases the pending Worker row when Cloudflare refuses the upload", async () => {
    const r = await install({}, { uploadStatus: 400 });
    expect(r.job?.error).toMatch(/^upload Worker script: /);
    const row = await env.DB.prepare(
      "SELECT cf_id, deleted_at FROM resources WHERE kind = 'worker'",
    ).first<{ cf_id: string | null; deleted_at: number | null }>();
    expect(row?.cf_id).toBeNull();
    // Deleted: an uninstall must not treat a same-named Worker as this install's.
    expect(row?.deleted_at).not.toBeNull();
  });

  it("keeps the pending Worker row when the upload fails with a 5xx", async () => {
    const r = await install({}, { uploadStatus: 503 });
    expect(r.job?.status).toBe("failed");
    const row = await env.DB.prepare(
      "SELECT deleted_at FROM resources WHERE kind = 'worker'",
    ).first<{ deleted_at: number | null }>();
    expect(row).toEqual({ deleted_at: null });
  });

  it("does not flip an install that left `installing` back to installed", async () => {
    const fixture = await buildArtifactFixture();
    const fake = fakeWorld(fixture, { health: [{ status: 200, body: "ok" }] });
    const { params, installId, jobId } = await start(fixture);
    const fetch = async (input: string, init?: RequestInit) => {
      // The job was settled from outside while it ran.
      if (input === HEALTH_URL) {
        await env.DB.prepare("UPDATE installs SET status = 'failed' WHERE id = ?1")
          .bind(installId)
          .run();
      }
      return fake.fetch(input, init);
    };
    await runInstall({
      params,
      step: fakeStep(),
      env: jobEnv(),
      deps: { fetch, signingKeys: fixture.keys },
    });
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = ?1")
      .bind(installId)
      .first();
    expect(install).toEqual({ status: "failed" });
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1").bind(jobId).first();
    expect(job).toEqual({ status: "succeeded" });
  });

  it("records the Durable Object migration tag the upload applied", async () => {
    const r = await install({
      bindings: [{ type: "durable_object_namespace", name: "ROOMS", class_name: "Room" }],
      migrations: [
        { tag: "v1", new_sqlite_classes: ["Room"] },
        { tag: "v2", new_sqlite_classes: ["Lobby"] },
      ],
    });
    expect(r.error).toBeNull();
    expect(r.fake.state.metadata?.migrations).toEqual({
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["Room"] }, { new_sqlite_classes: ["Lobby"] }],
    });
    expect(r.installRow?.do_migration_tag).toBe("v2");
  });
});
