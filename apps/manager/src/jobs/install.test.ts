import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { MAX_WORKER_MODULES, type SigningKey, withRevisedCatalog } from "@appflare/schema";
import { beforeEach, describe, expect, it } from "vitest";
import { readCatalogRevision } from "../catalog/revisions.server";
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
  REVISED_URL,
  ZIP_URL,
} from "../test/artifact-fixture";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { redirectingArtifactHost, STORAGE_URL } from "../test/redirecting-host";
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
const WORKER_ORIGIN = "https://cut.appflare-dev.workers.dev";
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
  /** Cron triggers of the account's other Workers (each must be in `scripts` too). */
  otherCrons: Record<string, string[]>;
  /** Handlers `GET /workers/scripts` lists per Worker; a Worker not named lists none. */
  handlers: Record<string, string[]>;
  /** `PUT .../schedules` answers like a Workers Free account at its cron trigger limit. */
  freeCronLimit: boolean;
  subdomainEnabled: unknown;
  calls: string[];
  health: Array<{ status: number; body: string }>;
  /** Every URL the health check requested on the Worker's host, in order. */
  healthUrls: string[];
  /** Called on each health request (a test's fake clock makes probes slow). */
  onHealthProbe?: () => void;
  workflows: string[];
  /** Keys (`METHOD /path`) whose next call does its work and then answers 500. */
  failAfter: Set<string>;
  /** The query that applies this migration file answers `status`, without running, `times` times. */
  failMigration?: { file: string; status: number; times: number };
  /** When set, the script upload is refused with this status. */
  uploadStatus?: number;
  r2: string[];
  /** False: every R2 call is refused the way Cloudflare refuses an account without R2. */
  r2Enabled: boolean;
  /** Vectorize indexes with the create body each was made from. */
  vectorize: Array<{ name: string; config: unknown }>;
  /** The zip answers like a GitHub release asset: a 302 to a signed storage URL. */
  artifactRedirect: boolean;
  /** Files per upload bucket the session asks for (default: one bucket for all). */
  bucketSize?: number;
  /** The session asks for one upload request per file (`wrangler_single_asset_uploads`). */
  singleUploads: boolean;
  /** When set, requests for the zip throw this error from `fetch`. */
  artifactThrows?: string;
  /** Every request, by the step that was running (`step.names.at(-1)`). */
  requestsByStep: Record<string, string[]>;
  /** The running step's name; `install` wires it to the fake step. */
  stepOf?: () => string | undefined;
  queues: Array<{ queue_id: string; queue_name: string }>;
  /** Consumers per queue id, with the body each was created from. */
  consumers: Record<string, Array<Record<string, unknown> & { consumer_id: string }>>;
  /** The app's other Workers (`cut-<name>`), each with what its calls set. */
  others: Record<string, OtherScript>;
}

/** What the fake records for an app's Worker other than `cut`. */
interface OtherScript {
  metadata: Record<string, unknown> | null;
  secrets: Record<string, string>;
  schedules: string[];
  subdomain: unknown;
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
    otherCrons: {},
    handlers: {},
    freeCronLimit: false,
    subdomainEnabled: null,
    calls: [],
    health: [
      { status: 404, body: "error code: 1042\n" },
      { status: 200, body: "<html>cut</html>" },
    ],
    healthUrls: [],
    workflows: [],
    failAfter: new Set(),
    r2: [],
    r2Enabled: true,
    vectorize: [],
    artifactRedirect: false,
    singleUploads: false,
    requestsByStep: {},
    queues: [],
    consumers: {},
    others: {},
    ...over,
  };
  const host = redirectingArtifactHost(fixture);
  const sessionJwt = state.singleUploads
    ? `e30.${btoa(JSON.stringify({ wrangler_single_asset_uploads: true })).replace(/=+$/, "")}.sig`
    : "session-jwt";
  function storeUpload(hashes: Iterable<string>) {
    for (const hash of hashes) state.uploaded.add(hash);
    state.bucketUploads += 1;
    const done = state.bucketHashes.every((h) => state.uploaded.has(h));
    return ok({ jwt: done ? "completion-jwt" : null });
  }
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
    if (!path.startsWith("/workers/assets/upload") && auth !== `Bearer ${TOKEN}`) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "auth" }] },
        { status: 403 },
      );
    }
    if (path.startsWith("/r2/") && !state.r2Enabled) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }],
        },
        { status: 403 },
      );
    }
    const otherScript =
      /^(?:PUT|POST) \/workers\/scripts\/(cut-[a-z0-9-]+)(?:\/(secrets|schedules|subdomain|assets-upload-session))?$/.exec(
        key,
      );
    if (otherScript?.[1] !== undefined) {
      const name = otherScript[1];
      state.others[name] ??= { metadata: null, secrets: {}, schedules: [], subdomain: null };
      const w = state.others[name];
      switch (otherScript[2]) {
        case undefined: {
          const form = await request.formData();
          w.metadata = JSON.parse(String(form.get("metadata")));
          state.scripts.push(name);
          return ok({ id: name, deployment_id: VERSION_HEX });
        }
        case "secrets": {
          const body = (await request.json()) as { name: string; text: string };
          w.secrets[body.name] = body.text;
          return ok({ name: body.name, type: "secret_text" });
        }
        case "schedules": {
          const body = (await request.json()) as Array<{ cron: string }>;
          w.schedules = body.map((s) => s.cron);
          return ok({ schedules: body });
        }
        case "subdomain":
          w.subdomain = await request.json();
          return ok({ enabled: true, previews_enabled: true });
        default:
          return ok({ jwt: sessionJwt, buckets: [] });
      }
    }
    switch (key) {
      case "GET /r2/buckets": {
        const contains = url.searchParams.get("name_contains") ?? "";
        return ok({
          buckets: state.r2.filter((n) => n.includes(contains)).map((name) => ({ name })),
        });
      }
      case "POST /r2/buckets": {
        const { name } = (await request.json()) as { name: string };
        state.r2.push(name);
        return ok({ name });
      }
      case "GET /vectorize/v2/indexes":
        return ok(state.vectorize.map(({ name, config }) => ({ name, config })));
      case "POST /vectorize/v2/indexes": {
        const body = (await request.json()) as { name: string; config: unknown };
        state.vectorize.push(body);
        return ok({ name: body.name, config: body.config });
      }
      case "GET /tokens/verify":
        return ok({ id: "t", status: "active" });
      case "GET /workers/scripts":
        return ok(
          state.scripts.map((id) => ({
            id,
            ...(state.handlers[id] === undefined ? {} : { handlers: state.handlers[id] }),
          })),
        );
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
        const size = state.bucketSize ?? Math.max(1, needed.length);
        const buckets: string[][] = [];
        for (let i = 0; i < needed.length; i += size) buckets.push(needed.slice(i, i + size));
        return ok({ jwt: sessionJwt, buckets });
      }
      case "POST /workers/assets/upload": {
        if (auth !== `Bearer ${sessionJwt}`) return new Response("bad jwt", { status: 401 });
        return storeUpload((await request.formData()).keys());
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
        const others = Object.values(state.otherCrons).flat().length;
        if (state.freeCronLimit && others + body.length > 5) {
          // Cloudflare's answer, as a free account got it (account id replaced).
          return Response.json(
            {
              result: null,
              success: false,
              errors: [
                {
                  code: 10072,
                  message:
                    "This account has reached the Workers Free limit of 5 cron triggers per account. Upgrade to Workers Paid to increase this limit to 1,000: https://dash.cloudflare.com/<account>/workers/plans",
                  documentation_url:
                    "https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits",
                },
              ],
              messages: [],
            },
            { status: 400 },
          );
        }
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
    const schedules = /^GET \/workers\/scripts\/([^/]+)\/schedules$/.exec(key);
    if (schedules?.[1] !== undefined && state.scripts.includes(schedules[1])) {
      return ok({ schedules: (state.otherCrons[schedules[1]] ?? []).map((cron) => ({ cron })) });
    }
    if (key === "GET /queues") return ok(state.queues);
    if (key === "POST /queues") {
      const { queue_name } = (await request.json()) as { queue_name: string };
      const queue = { queue_id: `q-${state.queues.length + 1}`, queue_name };
      state.queues.push(queue);
      return ok(queue);
    }
    const consumers = /^(GET|POST) \/queues\/([^/]+)\/consumers$/.exec(key);
    if (consumers?.[2] !== undefined) {
      const queueId = consumers[2];
      state.consumers[queueId] ??= [];
      const list = state.consumers[queueId];
      if (consumers[1] === "GET") return ok(list);
      const body = (await request.json()) as Record<string, unknown>;
      const consumer = { ...body, consumer_id: `c-${queueId}-${list.length + 1}` };
      list.push(consumer);
      return ok(consumer);
    }
    const singleUpload = /^POST \/workers\/assets\/upload\/([0-9a-f]+)$/.exec(key);
    if (singleUpload?.[1] !== undefined) {
      if (auth !== `Bearer ${sessionJwt}`) return new Response("bad jwt", { status: 401 });
      return storeUpload([singleUpload[1]]);
    }
    const d1Query = /^POST \/d1\/database\/([^/]+)\/query$/.exec(key);
    if (d1Query) {
      const { sql } = (await request.json()) as { sql: string };
      const failing = state.failMigration;
      if (
        failing !== undefined &&
        failing.times > 0 &&
        sql.endsWith(`values ('${failing.file}');`)
      ) {
        failing.times -= 1;
        return Response.json(
          { success: false, errors: [{ code: 7500, message: 'near "BROKEN": syntax error' }] },
          { status: failing.status },
        );
      }
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
    const current = state.stepOf?.() ?? "(no step)";
    state.requestsByStep[current] ??= [];
    state.requestsByStep[current].push(input);
    if (input === ZIP_URL || input === STORAGE_URL) {
      if (state.artifactThrows !== undefined) throw new Error(state.artifactThrows);
      if (state.artifactRedirect) {
        const response = host.serve(input, init);
        // A followed redirect is two subrequests; record the second hop too.
        if (response?.redirected) state.requestsByStep[current].push(STORAGE_URL);
        if (response !== null) return response;
      }
    }
    const request = new Request(input, init);
    if (input.startsWith("https://api.cloudflare.com/")) return cloudflare(request);
    if (input.startsWith(`${WORKER_ORIGIN}/`)) {
      state.healthUrls.push(input);
      state.onHealthProbe?.();
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
      // As getCatalogManifest reads it: the form of the revision, when listed.
      loadApp: async () => ({
        app: fixture.index,
        manifest:
          fixture.revised === null
            ? fixture.manifest
            : withRevisedCatalog(fixture.manifest, fixture.revised.catalog),
      }),
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
      requirementsConfirmed: false,
      ...over,
    },
  );
  if (params === null) throw new Error("no Workflow params");
  return { ...ids, params: params as InstallJobParams };
}

async function install(
  options: ArtifactFixtureOptions = {},
  world: Partial<FakeState> = {},
  input: Partial<StartInstallInput> = {},
  paramsOver: Partial<InstallJobParams> = {},
  clock?: { now: () => number; onSleep: (name: string, duration: string | number) => void },
  /** `local`: a manager without the `SELF` binding runs the units in the job's invocation. */
  units: "self" | "local" = "self",
  /** Runs once the install row exists, before the job starts. */
  beforeRun?: (installId: string, fixture: ArtifactFixture) => Promise<void>,
) {
  const fixture = await buildArtifactFixture(options);
  const fake = fakeWorld(fixture, world);
  const started = await start(fixture, input);
  const { jobId, installId } = started;
  const params = { ...started.params, ...paramsOver };
  await beforeRun?.(installId, fixture);
  const step = fakeStep(clock === undefined ? {} : { onSleep: clock.onSleep });
  fake.state.stepOf = () => step.names.at(-1);
  const self = fakeSelf(jobEnv(), {
    fetch: fake.fetch,
    ...(clock === undefined ? {} : { now: clock.now }),
  });
  let error: unknown = null;
  try {
    await runInstall({
      params,
      step,
      env: units === "self" ? { ...jobEnv(), SELF: self } : jobEnv(),
      deps: {
        fetch: fake.fetch,
        signingKeys: fixture.keys,
        ...(clock === undefined ? {} : { now: clock.now }),
      },
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
      health_status: string | null;
      health_checked_at: number | null;
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
  return { fixture, fake, step, self, error, job, installRow, resources, logs };
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
      "check cron trigger limit",
      "check KV namespace cut-cut-kv",
      "create KV namespace cut-cut-kv",
      "record KV namespace cut-cut-kv",
      "check D1 database cut-db",
      "create D1 database cut-db",
      "record D1 database cut-db",
      "look up workers.dev subdomain",
      "open assets upload session",
      "upload assets bucket 1/1",
      "record Worker name",
      "upload Worker script",
      "record Worker script",
      "D1 DB: apply migrations",
      "set secret ADMIN_PASSWORD",
      "set cron triggers",
      "enable workers.dev route",
      "health check 1",
      "health check 2",
      "finish",
    ]);
    expect(r.step.sleeps).toEqual(["health wait 1"]);
    // The subrequest-heavy work ran as units over SELF, each in its own invocation.
    expect(r.self.calls.map((c) => [c.unit, c.subrequests])).toEqual([
      ["countCronTriggers", 2], // the Worker list, the manager's schedule
      ["uploadAssetPart", 2], // one range for both files, one upload
      ["uploadWorker", 2], // one range for the module, one upload
      // The table, the list, one range for both files, one query per file.
      ["applyD1Migrations", 5],
    ]);
    for (const call of r.self.calls) expect(call.reported).toBe(call.subrequests);
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

  it("sends the install's stored workers.dev choice, keeping version previews on", async () => {
    const r = await install({}, {}, {}, {}, undefined, "self", async (installId) => {
      await env.DB.prepare("UPDATE installs SET workers_dev_enabled = 0 WHERE id = ?1")
        .bind(installId)
        .run();
    });
    expect(r.error).toBeNull();
    expect(r.fake.state.subdomainEnabled).toEqual({ enabled: false, previews_enabled: true });
    // No workers.dev route is recorded for a Worker that does not answer there.
    expect(r.resources.some((row) => (row as { kind: string }).kind === "subdomain")).toBe(false);
    expect(r.logs.some((l) => l.message.startsWith("Left https://cut."))).toBe(true);
  });

  it("creates a Vectorize index with the recorded shape and passes Workers AI through", async () => {
    // Shaped like second-brain-cloudflare: D1 whose schema the app creates at
    // runtime (no migration files), a Vectorize index, Workers AI, KV, a var,
    // and five cron triggers.
    const crons = ["0 1 * * *", "*/15 * * * *", "0 */6 * * *", "30 2 * * 1", "0 0 1 * *"];
    const r = await install({
      bindings: [
        { type: "d1", name: "DB" },
        { type: "vectorize", name: "VECTORIZE", dimensions: 384, metric: "cosine" },
        { type: "ai", name: "AI" },
        { type: "kv_namespace", name: "OAUTH_KV" },
        { type: "plain_text", name: "VECTORIZE_GRACE_MS", text: "300000" },
      ],
      d1: { DB: [] },
      crons,
    });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names).toEqual(
      expect.arrayContaining([
        "check Vectorize index cut-vectorize",
        "create Vectorize index cut-vectorize",
        "record Vectorize index cut-vectorize",
        "set cron triggers",
      ]),
    );
    // No migration files: nothing touches the database before the app does.
    expect(r.step.names.some((n) => n.startsWith("D1 DB"))).toBe(false);
    expect(r.fake.state.queries).toEqual([]);

    // `POST /vectorize/v2/indexes` with `{ name, config: { dimensions, metric } }`.
    expect(r.fake.state.vectorize).toEqual([
      { name: "cut-vectorize", config: { dimensions: 384, metric: "cosine" } },
    ]);
    expect(r.resources).toEqual(
      expect.arrayContaining([
        { kind: "vectorize", binding: "VECTORIZE", name: "cut-vectorize", cf_id: "cut-vectorize" },
        ...crons.map((cron) => ({ kind: "cron", binding: null, name: cron, cf_id: null })),
      ]),
    );
    // The upload binds the index by name and sends Workers AI as recorded; the
    // index shape stays out of the script metadata.
    expect(r.fake.state.metadata?.bindings).toEqual([
      { type: "d1", name: "DB", id: "d1-1" },
      { type: "vectorize", name: "VECTORIZE", index_name: "cut-vectorize" },
      { type: "ai", name: "AI" },
      { type: "kv_namespace", name: "OAUTH_KV", namespace_id: "kv-1" },
      { type: "plain_text", name: "VECTORIZE_GRACE_MS", text: "300000" },
      { type: "plain_text", name: "HOME_PAGE", text: "admin" },
    ]);
    expect(r.fake.state.schedules).toEqual(crons);
  });

  it("refuses an artifact whose Vectorize binding lacks the index shape, before creating anything", async () => {
    const r = await install({
      bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
      tweak: (m) => {
        m.worker.bindings.push({ type: "vectorize", name: "VECTORIZE" });
      },
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /^verify artifact manifest: .*a vectorize binding must record the index's dimensions and metric/s,
    );
    expect(r.fake.state.vectorize).toEqual([]);
    expect(r.fake.state.kv).toEqual([]);
  });

  it("uploads non-string vars as json and fills in the Worker's URL and name", async () => {
    const r = await install(
      {
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "json", name: "EMAIL_ADDRESSES", json: [] },
          { type: "plain_text", name: "PUBLIC_URL", text: "{{workerUrl}}" },
        ],
        catalog: {
          vars: [
            { name: "HOME_PAGE", label: "Home page", required: false },
            {
              name: "EMAIL_ADDRESSES",
              label: "Addresses",
              default: '["{{workerName}}@example.com"]',
              required: false,
            },
          ],
        },
      },
      {},
      { vars: { HOME_PAGE: "{{workerUrl}}/admin" } },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.metadata?.bindings).toEqual([
      { type: "kv_namespace", name: "CUT_KV", namespace_id: "kv-1" },
      { type: "json", name: "EMAIL_ADDRESSES", json: ["cut@example.com"] },
      { type: "plain_text", name: "PUBLIC_URL", text: "https://cut.appflare-dev.workers.dev" },
      {
        type: "plain_text",
        name: "HOME_PAGE",
        text: "https://cut.appflare-dev.workers.dev/admin",
      },
    ]);
  });

  it("installs the signed Worker with the form of a revision the catalog lists, and records it", async () => {
    const homePage = {
      name: "HOME_PAGE",
      label: "Home page",
      required: false,
      type: "select" as const,
      options: [
        { value: "default", label: "Show the landing page" },
        { value: "404", label: "Return an empty 404 response" },
      ],
      default: "404",
    };
    const greeting = { name: "GREETING", label: "Greeting", default: "hi", required: false };
    const r = await install({ revision: { vars: [homePage, greeting] } }, {}, { vars: {} });
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names).toContain("verify revised catalog manifest");
    // The revision's defaults, including a var only the revision declares.
    expect(r.fake.state.metadata?.bindings).toEqual(
      expect.arrayContaining([
        { type: "plain_text", name: "HOME_PAGE", text: "404" },
        { type: "plain_text", name: "GREETING", text: "hi" },
      ]),
    );
    // The install keeps the signed manifest; the revision is recorded for the release.
    expect(r.installRow?.manifest_json).toBe(new TextDecoder().decode(r.fixture.manifestBytes));
    const recorded = await readCatalogRevision(createDb(env.DB), r.fixture.digest);
    expect(recorded?.revision).toBe(2);
    expect(recorded?.catalog.vars).toEqual(r.fixture.revised?.catalog.vars);
    expect(recorded?.sha256).toBe(r.fixture.index.catalogManifest?.sha256);
    expect(recorded?.signature).toBe(r.fixture.index.catalogManifest?.signature);
  });

  it("refuses a revision whose bytes are not the ones the index lists, before creating anything", async () => {
    const r = await install(
      { revision: { summary: "Revised." } },
      {},
      {},
      {
        revisedCatalog: {
          url: REVISED_URL,
          sha256: "0".repeat(64),
          keyId: "test-key",
          signature: "x",
          revision: 2,
        },
      },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /verify revised catalog manifest: .*digest .* does not match the catalog index/,
    );
    expect(r.resources).toEqual([]);
  });

  it("refuses an unsigned revision, before creating anything", async () => {
    // The same revised bytes (the fixture is deterministic), listed without a signature.
    const listed = (await buildArtifactFixture({ revision: { summary: "Revised." } })).index
      .catalogManifest;
    if (listed === undefined) throw new Error("no revision");
    const r = await install(
      { revision: { summary: "Revised." } },
      {},
      {},
      { revisedCatalog: { ...listed, signature: "AAAA", revision: 2 } },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/verify revised catalog manifest: .*signature does not verify/);
    expect(r.resources).toEqual([]);
  });

  it("refuses a revision that changes what only a new build can change", async () => {
    const r = await install(
      { revision: { requires: ["r2"] } },
      {},
      { requirementsConfirmed: true },
    );
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/it changes requires, which only a new build can change/);
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

  describe("an app with many D1 migrations", () => {
    /** `count` migration files, each creating its own table. */
    const files = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        name: `${String(i + 1).padStart(4, "0")}_table${i + 1}.sql`,
        content: `CREATE TABLE t${i + 1} (id TEXT);`,
      }));
    const names = (count: number) => files(count).map((f) => f.name);
    const d1Steps = (r: Awaited<ReturnType<typeof install>>) =>
      r.step.names.filter((n) => n.startsWith("D1 DB"));
    const d1Calls = (r: Awaited<ReturnType<typeof install>>) =>
      r.self.calls.filter((c) => c.unit === "applyD1Migrations").map((c) => c.subrequests);
    /** How many queries ran each file (the file's SQL and its d1_migrations row). */
    const runs = (r: Awaited<ReturnType<typeof install>>, file: string) =>
      r.fake.state.queries.filter((q) => q.endsWith(`values ('${file}');`)).length;

    it("applies 30 migrations from a release asset in one unit call", async () => {
      const r = await install(
        { bindings: [{ type: "d1", name: "DB" }], d1: { DB: files(30) } },
        { artifactRedirect: true },
      );
      expect(r.error).toBeNull();
      expect(d1Steps(r)).toEqual(["D1 DB: apply migrations"]);
      // The table, the list, the redirect and one range for every file, one query per file.
      expect(d1Calls(r)).toEqual([34]);
      expect(r.fake.state.applied).toEqual(names(30));
    });

    it("continues in a further call from the first file that did not fit", async () => {
      const r = await install(
        { bindings: [{ type: "d1", name: "DB" }], d1: { DB: files(40) } },
        { artifactRedirect: true },
      );
      expect(r.error).toBeNull();
      expect(d1Steps(r)).toEqual([
        "D1 DB: apply migrations",
        "D1 DB: apply migrations from 0033_table33.sql",
      ]);
      expect(d1Calls(r)).toEqual([36, 12]);
      expect(r.fake.state.applied).toEqual(names(40));
    });

    it("resumes a retried call after the last applied file, without running any twice", async () => {
      const r = await install(
        { bindings: [{ type: "d1", name: "DB" }], d1: { DB: files(30) } },
        { failMigration: { file: "0013_table13.sql", status: 500, times: 1 } },
      );
      expect(r.error).toBeNull();
      expect(r.step.retried).toEqual({ "D1 DB: apply migrations": 2 });
      expect(r.fake.state.applied).toEqual(names(30));
      for (const file of names(30)) expect(runs(r, file)).toBe(1);
      // The second attempt listed 12 files as applied and started at the 13th.
      expect(r.logs.map((l) => l.message)).toContain(
        "12 migration(s) already applied to cut-db; applying 18 of 18 new.",
      );
    });

    it("stops at the file whose statement fails, with Cloudflare's error", async () => {
      const r = await install(
        { bindings: [{ type: "d1", name: "DB" }], d1: { DB: files(30) } },
        { failMigration: { file: "0024_table24.sql", status: 400, times: 1 } },
      );
      expect(r.job?.status).toBe("failed");
      expect(r.installRow?.status).toBe("failed");
      expect(r.job?.error).toBe(
        `D1 DB: apply migrations: 0024_table24.sql: Cloudflare API request failed: POST /accounts/${ACC}/d1/database/d1-1/query -> 400: [7500] near "BROKEN": syntax error`,
      );
      expect(r.step.retried).toEqual({});
      expect(r.fake.state.applied).toEqual(names(23));
      for (const file of names(30).slice(24)) expect(runs(r, file)).toBe(0);
      expect(r.step.names.at(-1)).toBe("mark install failed");
    });
  });

  it("runs the units in its own invocation when the Worker has no SELF binding", async () => {
    const options = {
      bindings: [{ type: "d1" as const, name: "DB" }],
      assets: [{ route: "/a.txt", content: "a" }],
      d1: { DB: [{ name: "0001_init.sql", content: "CREATE TABLE t (id TEXT);" }] },
    };
    const remote = await install(options);
    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
    const local = await install(options, {}, {}, {}, undefined, "local");
    expect(local.error).toBeNull();
    expect(local.job?.status).toBe("succeeded");
    expect(local.self.calls).toEqual([]);
    // The same steps, the same Cloudflare calls, the same outcome.
    expect(local.step.names).toEqual(remote.step.names);
    expect(local.fake.state.calls).toEqual(remote.fake.state.calls);
    expect(local.fake.state.applied).toEqual(["0001_init.sql"]);
    expect(local.logs.map((l) => l.message)).toEqual(remote.logs.map((l) => l.message));
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

  describe("asset upload from a release asset that redirects", () => {
    const smallFiles = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        route: `/f${i}.js`,
        content: `export const f${i} = ${i};`,
      }));
    const uploadSteps = (r: { step: { names: string[] } }) =>
      r.step.names.filter((n) => n.startsWith("upload assets bucket"));
    const artifactRequests = (r: { fake: { state: FakeState } }, name: string) =>
      (r.fake.state.requestsByStep[name] ?? []).filter((u) => u === ZIP_URL || u === STORAGE_URL);

    it("reads a bucket of 30 small files with one range request, following the redirect once", async () => {
      const r = await install({ assets: smallFiles(30) }, { artifactRedirect: true });
      expect(r.error).toBeNull();
      expect(uploadSteps(r)).toEqual(["upload assets bucket 1/1"]);
      // One redirect hop, one ranged read of the storage URL, one upload: 3, not 61.
      expect(r.fake.state.requestsByStep["upload assets bucket 1/1"]).toEqual([
        ZIP_URL,
        STORAGE_URL,
        "https://api.cloudflare.com/client/v4/accounts/acc0000000000000000000000000000a/workers/assets/upload?base64=true",
      ]);
      expect(r.fake.state.bucketUploads).toBe(1);
      expect([...r.fake.state.uploaded].sort()).toEqual([...r.fake.state.bucketHashes].sort());
      expect((r.fake.state.metadata?.assets as { jwt: string } | undefined)?.jwt).toBe(
        "completion-jwt",
      );
      expect(
        r.logs.some((l) =>
          /Uploaded 30 asset file\(s\), \d+ bytes, read with 1 range request\(s\)\./.test(
            l.message,
          ),
        ),
      ).toBe(true);
    });

    it("follows the redirect once per step when Cloudflare spreads the files over buckets", async () => {
      // The live failure: 27 files in three buckets of nine.
      const r = await install(
        { assets: smallFiles(27) },
        { artifactRedirect: true, bucketSize: 9 },
      );
      expect(r.error).toBeNull();
      expect(uploadSteps(r)).toEqual([
        "upload assets bucket 1/3",
        "upload assets bucket 2/3",
        "upload assets bucket 3/3",
      ]);
      for (const name of uploadSteps(r)) {
        expect(artifactRequests(r, name)).toEqual([ZIP_URL, STORAGE_URL]);
      }
      expect(r.fake.state.bucketUploads).toBe(3);
    });

    it("splits a bucket that does not fit one step, and no step passes 40 subrequests", async () => {
      // One upload request per file: 60 files cannot share one step.
      const r = await install(
        { assets: smallFiles(60) },
        { artifactRedirect: true, singleUploads: true },
      );
      expect(r.error).toBeNull();
      expect(uploadSteps(r)).toEqual([
        "upload assets bucket 1/1 part 1/2",
        "upload assets bucket 1/1 part 2/2",
      ]);
      for (const name of uploadSteps(r)) {
        expect(artifactRequests(r, name)).toEqual([ZIP_URL, STORAGE_URL]);
      }
      // Each part is one unit call: one redirect, one range, 30 or so uploads.
      const parts = r.self.calls.filter((c) => c.unit === "uploadAssetPart");
      expect(parts.map((c) => c.subrequests)).toEqual([36, 28]);
      for (const call of r.self.calls) expect(call.subrequests).toBeLessThan(40);
      expect(r.fake.state.bucketUploads).toBe(60);
      expect((r.fake.state.metadata?.assets as { jwt: string } | undefined)?.jwt).toBe(
        "completion-jwt",
      );
    });

    it("fails at once, without retrying, when the runtime refuses a subrequest", async () => {
      const r = await install(
        { assets: smallFiles(3) },
        {
          artifactThrows:
            "Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits",
        },
      );
      expect(r.error).toBeInstanceOf(Error);
      expect(r.step.retried["upload assets bucket 1/1"]).toBeUndefined();
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(
        /^upload assets bucket 1\/1: GET assets\/f0\.js and 2 more file\(s\) failed: Too many subrequests by single Worker invocation\. Cloudflare allows 50 subrequests per Worker invocation on the free plan, and a retry would make the same requests and hit the same limit, so the job stopped instead of retrying\.$/,
      );
    });
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

  describe("an app that requires R2", () => {
    const r2App: ArtifactFixtureOptions = {
      catalog: { requires: ["r2"] },
      bindings: [
        { type: "kv_namespace", name: "CUT_KV" },
        { type: "r2_bucket", name: "FILES" },
      ],
    };

    it("creates and records the bucket, and logs the confirmed requirement", async () => {
      const r = await install(r2App, {}, { requirementsConfirmed: true });
      expect(r.error).toBeNull();
      expect(r.fake.state.r2).toEqual(["cut-files"]);
      expect(r.resources).toContainEqual({
        kind: "r2",
        binding: "FILES",
        name: "cut-files",
        cf_id: "cut-files",
      });
      const messages = r.logs.map((l) => l.message);
      expect(messages).toContain(
        "Requires R2: R2 must be enabled on the account, which needs a payment method on file even on the free tier.",
      );
      expect(messages).toContain("The admin confirmed this account meets these requirements.");
      expect(messages).toContain("R2 is enabled on this account.");
    });

    it("stops before creating anything when R2 is not enabled, and says what to do", async () => {
      const r = await install(r2App, { r2Enabled: false }, { requirementsConfirmed: true });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toBe(
        "check R2 is enabled: R2 is not enabled on this Cloudflare account, so the R2 bucket cut-files cannot be created. Enable R2 in the Cloudflare dashboard under R2 Object Storage. Cloudflare asks for a payment method on file before enabling R2, even though its free tier costs nothing. Then try again.",
      );
      expect(r.installRow?.status).toBe("failed");
      expect(r.resources).toEqual([]);
      expect(r.fake.state.calls).not.toContain("POST /storage/kv/namespaces");
      // Not retried: the refusal is a 4xx.
      expect(r.fake.state.calls.filter((c) => c === "GET /r2/buckets")).toHaveLength(1);
    });

    it("refuses a job whose requirements were explicitly not confirmed", async () => {
      const r = await install(
        r2App,
        {},
        { requirementsConfirmed: true },
        { requirementsConfirmed: false },
      );
      expect(r.job?.error).toBe(
        "preflight checks: this app needs R2; confirm the account meets these requirements to install it",
      );
      expect(r.fake.state.calls).toEqual([]);
    });
  });

  describe("an app with cron triggers on a free account", () => {
    const cronApp: ArtifactFixtureOptions = { crons: ["0 1 * * *", "*/15 * * * *"] };
    /** The manager and two apps: 4 cron triggers on Workers with a scheduled handler. */
    const busy = (): Partial<FakeState> & Pick<FakeState, "handlers"> => ({
      scripts: ["appflare", "second-brain", "flaremo", "appflare-docs"],
      handlers: {
        appflare: ["fetch", "scheduled"],
        "second-brain": ["fetch", "scheduled"],
        flaremo: ["fetch", "scheduled", "queue"],
        "appflare-docs": ["fetch"],
      },
      otherCrons: {
        appflare: ["*/30 * * * *"],
        "second-brain": ["0 1 * * *", "0 13 * * *"],
        flaremo: ["17 3 * * *"],
      },
      freeCronLimit: true,
    });

    it("refuses before creating anything when its triggers would pass 5, naming the count", async () => {
      const r = await install(cronApp, busy());
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toBe(
        "check cron trigger limit: this app needs 2 cron triggers and the account's other Workers already use 4 (second-brain: 2, appflare: 1, flaremo: 1); Workers Free allows 5 per account, so this would make 6. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account). If it is already on Workers Paid, record that in Settings under Workers plan. Then try again.",
      );
      expect(r.installRow?.status).toBe("failed");
      expect(r.resources).toEqual([]);
      expect(r.step.names.slice(-2)).toEqual(["check cron trigger limit", "mark install failed"]);
      expect(r.step.retried).toEqual({});
      // Counted in a unit of its own; a Worker without a scheduled handler is not read.
      expect(r.self.calls.map((c) => [c.unit, c.subrequests])).toEqual([["countCronTriggers", 4]]);
      expect(r.fake.state.calls).not.toContain("GET /workers/scripts/appflare-docs/schedules");
      expect(r.fake.state.calls.some((c) => c.startsWith("POST ") || c.startsWith("PUT "))).toBe(
        false,
      );
    });

    it("installs when the triggers fit, and logs the count", async () => {
      const r = await install(cronApp, {
        ...busy(),
        otherCrons: { appflare: ["*/30 * * * *"], flaremo: ["17 3 * * *"] },
      });
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.schedules).toEqual(["0 1 * * *", "*/15 * * * *"]);
      expect(r.logs.map((l) => l.message)).toContain(
        "The account's other Workers use 2 cron triggers; with 2 more that is 4 of the 5 Workers Free allows.",
      );
    });

    it("skips the count when the admin confirmed Workers Paid", async () => {
      const r = await install(
        cronApp,
        { ...busy(), freeCronLimit: false },
        { paidConfirmed: true },
      );
      expect(r.error).toBeNull();
      expect(r.step.names).not.toContain("check cron trigger limit");
      expect(r.self.calls.map((c) => c.unit)).not.toContain("countCronTriggers");
      expect(r.fake.state.schedules).toEqual(["0 1 * * *", "*/15 * * * *"]);
    });

    it("skips the count when Settings records the account as on Workers Paid", async () => {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('account_plan', 'paid', 0)",
      ).run();
      const r = await install(cronApp, { ...busy(), freeCronLimit: false });
      expect(r.error).toBeNull();
      expect(r.step.names).not.toContain("check cron trigger limit");
      expect(r.fake.state.schedules).toEqual(["0 1 * * *", "*/15 * * * *"]);
    });

    it("skips the count when the capability probes detected Workers Paid, over a manual free", async () => {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('account_plan', 'free', 0), ('account_capabilities', ?, 0)",
      )
        .bind(
          JSON.stringify({
            checkedAt: "2026-09-24T00:00:00.000Z",
            r2: { state: "enabled" },
            containers: { state: "available" },
            workersPlan: { state: "paid" },
          }),
        )
        .run();
      const r = await install(cronApp, { ...busy(), freeCronLimit: false });
      expect(r.error).toBeNull();
      expect(r.step.names).not.toContain("check cron trigger limit");
    });

    it("counts when the probes detected Workers Free, over a manual paid", async () => {
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('account_plan', 'paid', 0), ('account_capabilities', ?, 0)",
      )
        .bind(
          JSON.stringify({
            checkedAt: "2026-09-24T00:00:00.000Z",
            r2: { state: "enabled" },
            containers: { state: "needs-workers-paid" },
            workersPlan: { state: "free" },
          }),
        )
        .run();
      const r = await install(cronApp, busy());
      expect(r.step.names).toContain("check cron trigger limit");
    });

    it("maps Cloudflare's refusal at the cron trigger step into what to do, without retrying", async () => {
      // A Worker without a scheduled handler still holds triggers, so the
      // count misses them and Cloudflare refuses the schedule.
      const account = busy();
      const r = await install(cronApp, {
        ...account,
        handlers: { ...account.handlers, flaremo: ["fetch"], "second-brain": ["fetch"] },
      });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toBe(
        'set cron triggers: Cloudflare refused 2 cron triggers: this account has reached the Workers Free limit of 5 cron triggers per account. The Worker "cut" is uploaded without them; uninstall this install to remove it. Remove a cron trigger from another Worker (for example by uninstalling an app that uses one), or upgrade the account to Workers Paid (1,000 per account), then try again.',
      );
      expect(r.step.retried).toEqual({});
      expect(
        r.fake.state.calls.filter((c) => c === "PUT /workers/scripts/cut/schedules"),
      ).toHaveLength(1);
      // The Worker exists and stays recorded; no cron trigger is.
      expect(r.resources).toContainEqual({
        kind: "worker",
        binding: null,
        name: "cut",
        cf_id: "cut",
      });
      expect(r.resources.some((row) => (row as { kind: string }).kind === "cron")).toBe(false);
      expect(r.fake.state.schedules).toEqual([]);
    });

    it("goes on without the count when the account has too many scheduled Workers to read", async () => {
      const many = Array.from({ length: 21 }, (_, i) => `worker-${i}`);
      const r = await install(cronApp, {
        scripts: many,
        handlers: Object.fromEntries(many.map((w) => [w, ["scheduled"]])),
      });
      expect(r.error).toBeNull();
      expect(r.logs.map((l) => l.message)).toContain(
        "Did not count the account's cron triggers: the account has 21 Workers with scheduled handlers, more than the 20 this check reads. Cloudflare checks the limit when the cron triggers are set.",
      );
      expect(r.fake.state.calls.filter((c) => c.endsWith("/schedules"))).toEqual([
        "PUT /workers/scripts/cut/schedules",
      ]);
    });
  });

  it("verifies a custom catalog's release with that catalog's pinned key, never the official keys", async () => {
    const seedCatalog = async (keys: SigningKey[]) => {
      await env.DB.prepare(
        `INSERT INTO catalogs (id, kind, label, colour, index_url, keys_json, enabled, added_at)
         VALUES ('acme', 'custom', 'Acme', 'blue', 'https://acme.test/index.json', ?1, 1, 1)`,
      )
        .bind(JSON.stringify(keys))
        .run();
    };
    // Pinned with another key: refused before anything is created, although
    // the release verifies with what the official catalog trusts in this test.
    const other = await buildArtifactFixture();
    const refused = await install({}, {}, {}, { catalogId: "acme" }, undefined, "self", () =>
      seedCatalog(other.keys),
    );
    expect(refused.job?.status).toBe("failed");
    expect(refused.job?.error).toMatch(
      /^verify artifact manifest: manifest signature does not verify with keyId "test-key"/,
    );
    expect(refused.fake.state.calls).toEqual([]);

    await reset();
    await createMigrator(migrations).ensure(env.DB);
    await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
    const installed = await install({}, {}, {}, { catalogId: "acme" }, undefined, "self", (_, f) =>
      seedCatalog(f.keys),
    );
    expect(installed.error).toBeNull();
    expect(installed.job?.status).toBe("succeeded");
  });

  it("fails when the custom catalog its app comes from was removed", async () => {
    const r = await install({}, {}, {}, { catalogId: "gone" });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      'catalog keys: the catalog "gone" this app comes from was removed from Appflare; add it again to install or update its apps',
    );
    expect(r.fake.state.calls).toEqual([]);
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

  it("keeps probing a route that is slow to go live, with backoff", async () => {
    const edge = { status: 404, body: "error code: 1042" };
    const r = await install(
      {},
      { health: [edge, edge, edge, edge, edge, { status: 401, body: "" }] },
    );
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(6);
    const waits = r.step.sleeps.flatMap((name, i) =>
      name.startsWith("health wait") ? [r.step.sleepDurations[i]] : [],
    );
    expect(waits).toEqual(["2 seconds", "3 seconds", "5 seconds", "8 seconds", "10 seconds"]);
    expect(r.installRow?.health_status).toBe("verified");
  });

  it("still installs a Worker it cannot verify within the window, and says so", async () => {
    const r = await install({}, { health: [{ status: 404, body: "error code: 1042" }] });
    expect(r.error).toBeNull();
    expect(r.job).toMatchObject({ status: "succeeded", error: null });
    expect(r.installRow?.status).toBe("installed");
    expect(r.installRow?.health_status).toBe("unverified");
    expect(r.installRow?.health_checked_at).not.toBeNull();
    // 2+3+5+8 s, then every 10 s: probes at 0, 2, 5, 10, 18, 28, ... 88 s.
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(12);
    expect(r.step.sleeps.filter((s) => s.startsWith("health wait"))).toHaveLength(11);
    expect(
      r.logs.some(
        (l) =>
          l.level === "warn" &&
          l.message.startsWith(`Could not verify ${HEALTH_URL} after 12 attempts`) &&
          l.message.includes("Open the app to check"),
      ),
    ).toBe(true);
    expect(r.logs.at(-1)?.message).toMatch(/\(health: not verified yet \(404 error code: 1042/);
  });

  it("ends the window by the clock when probes are slow", async () => {
    let clock = 1_000_000;
    const r = await install(
      {},
      {
        health: [{ status: 404, body: "error code: 1042" }],
        // Each probe takes 10 s (a timeout).
        onHealthProbe: () => {
          clock += 10_000;
        },
      },
      {},
      {},
      {
        now: () => clock,
        onSleep: (_name, duration) => {
          clock += Number.parseInt(String(duration), 10) * 1000;
        },
      },
    );
    expect(r.job?.status).toBe("succeeded");
    // Probes start at 0, 12, 25, 40, 58, 78, 98 s: the seventh is past 90 s.
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(7);
    expect(r.installRow?.health_status).toBe("unverified");
  });

  it("records a Worker that answers only 5xx as unhealthy without failing", async () => {
    const r = await install({}, { health: [{ status: 502, body: "bad gateway" }] });
    expect(r.job?.status).toBe("succeeded");
    expect(r.installRow?.status).toBe("installed");
    expect(r.installRow?.health_status).toBe("unhealthy");
    expect(r.logs.some((l) => l.level === "warn" && l.message.includes("server error"))).toBe(true);
  });

  it("accepts a plain 404 at the root once the window ends", async () => {
    const r = await install({}, { health: [{ status: 404, body: "Not found" }] });
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names.filter((n) => n.startsWith("health check"))).toHaveLength(12);
    expect(r.installRow?.health_status).toBe("verified");
  });

  it("probes the catalog's health path", async () => {
    const r = await install(
      {
        catalog: {
          install: {
            tier: "artifact",
            packageManager: "pnpm",
            wranglerConfig: "wrangler.jsonc",
            workerName: "cut",
            healthPath: "/api/health",
          },
        },
      },
      { health: [{ status: 200, body: '{"ok":true}' }] },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.healthUrls).toEqual([`${WORKER_ORIGIN}/api/health`]);
    expect(r.installRow?.health_status).toBe("verified");
    // The app's URL, not the health path, is what the admin opens.
    expect(r.logs.at(-1)?.message).toMatch(new RegExp(`at ${HEALTH_URL} \\(health: verified`));
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

  describe("an app with queue consumers", () => {
    const queueApp: ArtifactFixtureOptions = {
      bindings: [{ type: "queue", name: "JOBS" }],
      tweak: (m) => {
        m.worker.queueConsumers = [
          {
            queue: { binding: "JOBS" },
            max_batch_size: 5,
            max_batch_timeout: 2,
            max_retries: 3,
            dead_letter_queue: { name: "jobs-dlq" },
          },
          { queue: { name: "jobs-dlq" } },
        ];
      },
    };

    it("creates the dead-letter queue and attaches each consumer after the upload", async () => {
      const r = await install(queueApp);
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(r.fake.state.queues).toEqual([
        { queue_id: "q-1", queue_name: "cut-jobs" },
        { queue_id: "q-2", queue_name: "cut-jobs-dlq" },
      ]);
      expect(r.fake.state.consumers).toEqual({
        "q-1": [
          {
            type: "worker",
            script_name: "cut",
            dead_letter_queue: "cut-jobs-dlq",
            settings: { batch_size: 5, max_retries: 3, max_wait_time_ms: 2000 },
            consumer_id: "c-q-1-1",
          },
        ],
        "q-2": [{ type: "worker", script_name: "cut", consumer_id: "c-q-2-1" }],
      });
      const calls = r.fake.state.calls;
      expect(calls.indexOf("POST /queues/q-1/consumers")).toBeGreaterThan(
        calls.indexOf("PUT /workers/scripts/cut"),
      );
      // Only the producer binding reaches the upload; the dead-letter queue is not bound.
      expect(r.fake.state.metadata?.bindings).toContainEqual({
        type: "queue",
        name: "JOBS",
        queue_name: "cut-jobs",
      });
      expect(JSON.stringify(r.fake.state.metadata?.bindings)).not.toContain("dlq");
      expect(r.resources).toEqual(
        expect.arrayContaining([
          { kind: "queue", binding: "JOBS", name: "cut-jobs", cf_id: "q-1" },
          { kind: "queue", binding: null, name: "cut-jobs-dlq", cf_id: "q-2" },
          { kind: "queue_consumer", binding: null, name: "cut-jobs", cf_id: "c-q-1-1" },
          { kind: "queue_consumer", binding: null, name: "cut-jobs-dlq", cf_id: "c-q-2-1" },
        ]),
      );
    });

    it("does not attach a consumer twice when the response of the first attempt is lost", async () => {
      const r = await install(queueApp, { failAfter: new Set(["POST /queues/q-1/consumers"]) });
      expect(r.error).toBeNull();
      expect(r.fake.state.consumers["q-1"]).toHaveLength(1);
      expect(r.step.retried["attach consumer to queue cut-jobs"]).toBe(2);
      expect(r.resources).toContainEqual({
        kind: "queue_consumer",
        binding: null,
        name: "cut-jobs",
        cf_id: "c-q-1-1",
      });
    });

    it("refuses a consumer of a queue the Worker does not bind, before creating anything", async () => {
      const r = await install({
        ...queueApp,
        tweak: (m) => {
          m.worker.queueConsumers = [{ queue: { binding: "MISSING" } }];
        },
      });
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(/preflight checks: .*queue binding MISSING/);
      expect(r.fake.state.queues).toEqual([]);
    });
  });

  it("gives each rate limit a namespace of its own instead of the artifact's", async () => {
    const r = await install({
      bindings: [
        {
          type: "ratelimit",
          name: "LIMITER",
          namespace_id: "1001",
          simple: { limit: 20, period: 60 },
        },
      ],
    });
    expect(r.error).toBeNull();
    const bindings = (r.fake.state.metadata?.bindings ?? []) as Array<Record<string, unknown>>;
    const sent = bindings.find((b) => b.type === "ratelimit");
    expect(sent).toMatchObject({ name: "LIMITER", simple: { limit: 20, period: 60 } });
    const id = String(sent?.namespace_id);
    expect(id).toMatch(/^[1-9]\d*$/);
    expect(id).not.toBe("1001");
    expect(Number(id)).toBeLessThanOrEqual(2_147_483_647);
    expect(r.resources).toContainEqual({
      kind: "ratelimit",
      binding: "LIMITER",
      name: "LIMITER",
      cf_id: id,
    });
  });

  it("verifies an app in status-only mode by any answer of its own Worker", async () => {
    const r = await install(
      {
        catalog: {
          install: {
            tier: "artifact",
            packageManager: "pnpm",
            wranglerConfig: "wrangler.jsonc",
            workerName: "cut",
            healthMode: "status-only",
          },
        },
      },
      {
        health: [
          { status: 404, body: "error code: 1042\n" },
          { status: 500, body: "Cloudflare Access must be configured in production." },
        ],
      },
    );
    expect(r.error).toBeNull();
    expect(r.fake.state.healthUrls).toHaveLength(2);
    expect(r.installRow?.health_status).toBe("verified");
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

describe("install job, an app of several Workers", () => {
  /** The primary Worker binds the `jobs` Worker; `jobs` implements the Durable Object. */
  const twoWorkers = (): ArtifactFixtureOptions => ({
    bindings: [
      { type: "kv_namespace", name: "CUT_KV" },
      { type: "service", name: "JOBS", service: "{{workerName:jobs}}", entrypoint: "Jobs" },
      {
        type: "durable_object_namespace",
        name: "ROOM",
        class_name: "Room",
        script_name: "{{workerName:jobs}}",
      },
      { type: "plain_text", name: "JOBS_URL", text: "https://example.test" },
    ],
    otherWorkers: [
      {
        name: "jobs",
        bindings: [
          { type: "kv_namespace", name: "CUT_KV" },
          { type: "durable_object_namespace", name: "ROOM", class_name: "Room" },
        ],
        migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
        crons: ["*/5 * * * *"],
      },
    ],
    catalog: {
      secrets: [
        { name: "ADMIN_PASSWORD", label: "Admin password", generate: true, workers: ["app"] },
        { name: "SHARED_KEY", label: "Shared key", generate: true },
      ],
      vars: [
        { name: "JOBS_URL", label: "Jobs URL", default: "{{workerUrl:jobs}}", required: false },
      ],
    },
  });
  const secrets = { secrets: { ADMIN_PASSWORD: PASSWORD, SHARED_KEY: "shared" }, vars: {} };

  it("deploys the Worker the primary one binds to first, sharing the app's resources", async () => {
    const r = await install(twoWorkers(), {}, secrets);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const calls = r.fake.state.calls;
    expect(calls.indexOf("PUT /workers/scripts/cut-jobs")).toBeLessThan(
      calls.indexOf("PUT /workers/scripts/cut"),
    );
    // One KV namespace for the binding both Workers have.
    expect(r.fake.state.kv.map((k) => k.title)).toEqual(["cut-cut-kv"]);
    const jobs = r.fake.state.others["cut-jobs"];
    const jobsBindings = (jobs?.metadata?.bindings ?? []) as Array<Record<string, unknown>>;
    expect(jobsBindings).toContainEqual({
      type: "kv_namespace",
      name: "CUT_KV",
      namespace_id: "kv-1",
    });
    expect(jobs?.metadata?.migrations).toEqual({
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["Room"] }],
    });
    // Secrets go to the Workers that get them.
    expect(jobs?.secrets).toEqual({ SHARED_KEY: "shared" });
    expect(r.fake.state.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD, SHARED_KEY: "shared" });
    expect(jobs?.schedules).toEqual(["*/5 * * * *"]);
    expect(jobs?.subdomain).toEqual({ enabled: true, previews_enabled: true });
    // The primary Worker's bindings to the other one name its installed name.
    const bindings = (r.fake.state.metadata?.bindings ?? []) as Array<Record<string, unknown>>;
    expect(bindings).toContainEqual({
      type: "service",
      name: "JOBS",
      service: "cut-jobs",
      entrypoint: "Jobs",
    });
    expect(bindings).toContainEqual({
      type: "durable_object_namespace",
      name: "ROOM",
      class_name: "Room",
      script_name: "cut-jobs",
    });
    expect(bindings).toContainEqual({
      type: "plain_text",
      name: "JOBS_URL",
      text: "https://cut-jobs.appflare-dev.workers.dev",
    });
    expect(r.fake.state.metadata?.migrations).toBeUndefined();
    const workers = r.resources.filter((row) => row.kind === "worker").map((row) => row.name);
    expect(workers).toEqual(["cut-jobs", "cut"]);
    const recorded = await env.DB.prepare("SELECT worker_versions_json FROM installs").first<{
      worker_versions_json: string;
    }>();
    expect(JSON.parse(recorded?.worker_versions_json ?? "null")).toEqual({
      "cut-jobs": "01234567-89ab-cdef-0123-456789abcdef",
    });
    expect(r.resources.filter((row) => row.kind === "durable_object")).toEqual([
      { kind: "durable_object", binding: "ROOM", name: "Room", cf_id: null },
    ]);
    expect(r.resources.filter((row) => row.kind === "subdomain").map((row) => row.name)).toEqual([
      "cut-jobs.appflare-dev.workers.dev",
      "cut.appflare-dev.workers.dev",
    ]);
    // Step names never repeat, so each Worker's steps are its own.
    expect(new Set(r.step.names).size).toBe(r.step.names.length);
  });

  it("deploys a Worker that binds to the primary one after it", async () => {
    const r = await install({
      otherWorkers: [
        {
          name: "hooks",
          bindings: [{ type: "service", name: "APP", service: "{{workerName:app}}" }],
        },
      ],
    });
    expect(r.error).toBeNull();
    const calls = r.fake.state.calls;
    expect(calls.indexOf("PUT /workers/scripts/cut")).toBeLessThan(
      calls.indexOf("PUT /workers/scripts/cut-hooks"),
    );
    expect(r.fake.state.others["cut-hooks"]?.metadata?.bindings).toContainEqual({
      type: "service",
      name: "APP",
      service: "cut",
    });
    // The default secret goes to every Worker.
    expect(r.fake.state.others["cut-hooks"]?.secrets).toEqual({ ADMIN_PASSWORD: PASSWORD });
  });

  it("refuses more Workers than the free plan's request budget allows, before creating anything", async () => {
    const r = await install({
      otherWorkers: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("This app has 4 Workers; more than 3 Workers exceed");
    expect(r.fake.state.kv).toEqual([]);
  });

  it("refuses when one of the app's Worker names is taken, before creating anything", async () => {
    const r = await install(twoWorkers(), { scripts: ["appflare", "cut-jobs"] }, secrets);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toContain("a Worker named cut-jobs already exists");
    expect(r.fake.state.kv).toEqual([]);
  });
});
