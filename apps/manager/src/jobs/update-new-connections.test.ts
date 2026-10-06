import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { describeNeeds } from "../auto-update/cron.server";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import {
  readSourceBuild,
  sourceUpdateNeeds,
  updateFromSourceBuildCore,
} from "../installs/source-builds.server";
import {
  readInstall,
  type StartUpdateRequest,
  type StartUpdateResult,
  startRollbackCore,
  startUpdateCore,
} from "../installs/versions.server";
import {
  type ArtifactFixture,
  type ArtifactFixtureOptions,
  baseCatalog,
  buildArtifactFixture,
} from "../test/artifact-fixture";
import { ACC, type FakeAccount, fakeAccount, TOKEN } from "../test/fake-account";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import {
  cacheIndex,
  INSTALL_ID,
  OLD_VERSION,
  type SeedResource,
  seedInstall,
} from "../test/seed-install";
import { type RollbackJobParams, runRollback } from "./rollback";
import type { JobEnv } from "./run-job";
import { runUpdate, type UpdateJobParams } from "./update";

/**
 * The update job and its start path when a new version connects to a
 * database elsewhere (Hyperdrive) or streams events (Pipelines): what the
 * update asks the admin for, what the job creates and binds, and how a
 * failed attempt, a rollback, and a later version leave those resources.
 * Hyperdrive, Pipelines, R2 buckets and R2 Data Catalog are faked in front
 * of the shared fake account.
 */

const DB_PASSWORD = "db-pass-DO-NOT-LEAK";
const CONNECTION = `postgres://app:${DB_PASSWORD}@db.example.com:5432/app`;
const SINK_TOKEN = "sink-token-DO-NOT-LEAK";

const RESOURCES: SeedResource[] = [
  { kind: "kv", binding: "CUT_KV", name: "cut-cut-kv", cfId: "kv-1" },
  { kind: "worker", name: "cut", cfId: "cut" },
  { kind: "secret", binding: "ADMIN_PASSWORD", name: "ADMIN_PASSWORD" },
  { kind: "subdomain", name: "cut.appflare-dev.workers.dev" },
];

const BASE: ArtifactFixtureOptions = {
  version: "1.1.0",
  bindings: [{ type: "kv_namespace", name: "CUT_KV" }],
  assets: [{ route: "/app.js", content: "console.log('v1.1')" }],
};

const WITH_DATABASE: ArtifactFixtureOptions = {
  ...BASE,
  bindings: [...(BASE.bindings ?? []), { type: "hyperdrive", name: "HYPERDRIVE" }],
  catalog: {
    resources: { hyperdrive: { HYPERDRIVE: { protocol: "postgres", label: "Main database" } } },
  },
};

const sink = {
  type: "r2_data_catalog" as const,
  bucket: "WAREHOUSE",
  namespace: "cut",
  table: "events",
  tokenSecret: "CATALOG_TOKEN",
};

const WITH_STREAM: ArtifactFixtureOptions = {
  ...BASE,
  bindings: [...(BASE.bindings ?? []), { type: "pipelines", name: "EVENTS" }],
  catalog: {
    plan: "paid",
    secrets: [...baseCatalog().secrets, { name: "CATALOG_TOKEN", label: "R2 API token" }],
    resources: { pipelines: { EVENTS: { sink } } },
  },
};

/** The stream, sink and pipeline an install or an earlier update made for EVENTS. */
const STREAM_ROWS: SeedResource[] = [
  { kind: "r2", name: "cut-warehouse", cfId: "cut-warehouse" },
  { kind: "r2_catalog", name: "cut-warehouse", cfId: "cat-1" },
  { kind: "pipeline_stream", binding: "EVENTS", name: "cut_events_stream", cfId: "streams-1" },
  { kind: "pipeline_sink", name: "cut_events_sink", cfId: "sinks-1" },
  { kind: "pipeline", name: "cut_events_pipeline", cfId: "pipelines-1" },
];

type Named = { id: string; name: string; body: Record<string, unknown> };

/** Hyperdrive, Pipelines, R2 buckets and R2 Data Catalog, answered before the fake account. */
function sideServices() {
  const state = {
    hyperdrive: [] as Named[],
    streams: [] as Named[],
    sinks: [] as Named[],
    pipelines: [] as Named[],
    buckets: [] as string[],
    catalogs: {} as Record<string, { id: string; status: string }>,
    /** Each R2 Data Catalog call as `METHOD /path as <sink|manager>`. */
    catalogCalls: [] as string[],
    /** Every request this front answered, as `METHOD /path`. */
    calls: [] as string[],
    /** The manager's token lacks Pipelines: every Pipelines call answers 403, code 100. */
    pipelinesRefused: false,
  };
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const refuse = (status: number, code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }] }, { status });

  async function answer(request: Request, path: string): Promise<Response | null> {
    const auth = request.headers.get("authorization");
    const key = `${request.method} ${path}`;
    if (path.startsWith("/r2-catalog/")) {
      state.calls.push(key);
      const who =
        auth === `Bearer ${SINK_TOKEN}` ? "sink" : auth === `Bearer ${TOKEN}` ? "manager" : null;
      if (who === null) return refuse(403, 10000, "auth");
      state.catalogCalls.push(`${key} as ${who}`);
      const [, bucket = "", action = ""] = /^\/r2-catalog\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
      const found = state.catalogs[bucket];
      switch (`${request.method} ${action}`) {
        case "GET ":
          return found === undefined
            ? refuse(404, 40401, "Catalog not found")
            : ok({ bucket, ...found });
        case "POST enable": {
          const id = `cat-${Object.keys(state.catalogs).length + 1}`;
          state.catalogs[bucket] = { id, status: "active" };
          return ok({ id, name: `${ACC}_${bucket}` });
        }
        case "POST delete":
          delete state.catalogs[bucket];
          return new Response(null, { status: 204 });
        default:
          return ok(null);
      }
    }
    const list = /^(GET|POST) \/pipelines\/v1\/(streams|sinks|pipelines)$/.exec(key);
    const one = /^GET \/pipelines\/v1\/(streams|sinks)\/([^/]+)$/.exec(key);
    const hyperdrive = key === "GET /hyperdrive/configs" || key === "POST /hyperdrive/configs";
    const deleteConfig = /^DELETE \/hyperdrive\/configs\/([^/]+)$/.exec(key);
    if (deleteConfig !== null) {
      state.calls.push(key);
      if (auth !== `Bearer ${TOKEN}`) return refuse(403, 10000, "auth");
      const at = state.hyperdrive.findIndex((c) => c.id === deleteConfig[1]);
      if (at === -1) return refuse(404, 2000, "Not found");
      state.hyperdrive.splice(at, 1);
      return ok(null);
    }
    const buckets = key === "GET /r2/buckets" || key === "POST /r2/buckets";
    if (list === null && one === null && !hyperdrive && !buckets) return null;
    state.calls.push(key);
    if (auth !== `Bearer ${TOKEN}`) return refuse(403, 10000, "auth");
    if (one !== null) {
      // A stream with the schema it was made with; a sink with where it writes, never its token.
      if (state.pipelinesRefused) return refuse(403, 100, "Forbidden");
      const found = state[one[1] as "streams" | "sinks"].find((x) => x.id === one[2]);
      if (found === undefined) return refuse(404, 1000, "Not found");
      if (one[1] === "streams") {
        // As Cloudflare answers: a stream made without a schema has one `value` column.
        const schema = found.body.schema ?? {
          fields: [{ name: "value", type: "json", required: true }],
        };
        return ok({ id: found.id, name: found.name, schema });
      }
      const config = (found.body.config ?? {}) as Record<string, unknown>;
      return ok({
        id: found.id,
        name: found.name,
        type: "r2_data_catalog",
        config: {
          bucket: config.bucket,
          namespace: config.namespace,
          table_name: config.table_name,
        },
      });
    }
    if (list?.[2] !== undefined) {
      if (state.pipelinesRefused) return refuse(403, 100, "Forbidden");
      const what = list[2] as "streams" | "sinks" | "pipelines";
      if (list[1] === "GET") {
        return ok(
          state[what].map(({ id, name }) => ({ id, name })),
          {
            result_info: {
              page: 1,
              per_page: 100,
              count: state[what].length,
              total_count: state[what].length,
            },
          },
        );
      }
      const body = (await request.json()) as Record<string, unknown> & { name: string };
      const id = `${what}-${state[what].length + 1}`;
      state[what].push({ id, name: body.name, body });
      return ok({ id, name: body.name });
    }
    if (hyperdrive) {
      if (request.method === "GET") {
        return ok(
          state.hyperdrive.map(({ id, name }) => ({ id, name })),
          { result_info: { page: 1, per_page: 100, total_count: state.hyperdrive.length } },
        );
      }
      const body = (await request.json()) as Record<string, unknown> & { name: string };
      const id = `hd-${state.hyperdrive.length + 1}`;
      state.hyperdrive.push({ id, name: body.name, body });
      return ok({ id, name: body.name });
    }
    if (request.method === "GET") {
      const contains = new URL(request.url).searchParams.get("name_contains") ?? "";
      return ok({
        buckets: state.buckets.filter((n) => n.includes(contains)).map((name) => ({ name })),
      });
    }
    const { name } = (await request.json()) as { name: string };
    state.buckets.push(name);
    return ok({ name });
  }

  /** The fake account's fetch with these services in front of it. */
  const wrap =
    (inner: FetchLike): FetchLike =>
    async (input, init) => {
      if (input.startsWith("https://api.cloudflare.com/")) {
        const path = new URL(input).pathname.replace(`/client/v4/accounts/${ACC}`, "");
        if (/^\/(r2-catalog|pipelines|hyperdrive|r2\/buckets$)/.test(path)) {
          const answered = await answer(new Request(input, init), path);
          if (answered !== null) return answered;
        }
      }
      return inner(input, init);
    };
  return { state, wrap };
}

const jobEnv = (): JobEnv => ({ DB: env.DB, KV: env.KV, CF_API_TOKEN: TOKEN });

interface World {
  fixture: ArtifactFixture;
  fake: ReturnType<typeof fakeAccount>;
  side: ReturnType<typeof sideServices>;
  fetch: FetchLike;
}

async function world(
  options: ArtifactFixtureOptions,
  seed: Parameters<typeof seedInstall>[0] = {},
  account: Partial<FakeAccount> = {},
): Promise<World> {
  const fixture = await buildArtifactFixture(options);
  const fake = fakeAccount(fixture, {
    deployments: [{ id: "dep-0", versions: [{ version_id: OLD_VERSION, percentage: 100 }] }],
    // The serving version binds nothing these tests look for.
    versionBindings: { [OLD_VERSION]: [] },
    versionSecrets: { [OLD_VERSION]: ["ADMIN_PASSWORD"] },
    ...account,
  });
  const side = sideServices();
  await seedInstall({ resources: RESOURCES, ...seed });
  await cacheIndex(fixture);
  return { fixture, fake, side, fetch: side.wrap(fake.fetch) };
}

/** Starts an update the way the dialog does; returns the needs, or the Workflow params. */
async function start(
  w: Pick<World, "fixture">,
  request: Omit<StartUpdateRequest, "installId"> = {},
  jobId = "job1",
): Promise<{ result: StartUpdateResult; params: UpdateJobParams | null }> {
  let params: UpdateJobParams | null = null;
  const result = await startUpdateCore(
    {
      db: env.DB,
      loadApp: async () => w.fixture.index,
      loadManifest: async () => w.fixture.manifest,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      newId: () => jobId,
    },
    { installId: INSTALL_ID, ...request },
  );
  return { result, params };
}

async function run(w: World, params: UpdateJobParams) {
  const step = fakeStep();
  let error: unknown = null;
  try {
    await runUpdate({
      params,
      step,
      env: { ...jobEnv(), SELF: fakeSelf(jobEnv(), { fetch: w.fetch }) },
      deps: { fetch: w.fetch, signingKeys: w.fixture.keys },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1")
    .bind(params.jobId)
    .first<{ status: string; error: string | null; input_json: string }>();
  const snapshot = await env.DB.prepare("SELECT * FROM snapshots WHERE job_id = ?1")
    .bind(params.jobId)
    .first<Record<string, unknown>>();
  const logs = (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(params.jobId)
      .all<{ level: string; message: string }>()
  ).results;
  return { step, error, job, snapshot, logs, resources: await rows() };
}

async function rows() {
  return (
    await env.DB.prepare(
      "SELECT kind, binding, name, cf_id, deleted_at FROM resources WHERE install_id = ?1 ORDER BY rowid",
    )
      .bind(INSTALL_ID)
      .all<{
        kind: string;
        binding: string | null;
        name: string;
        cf_id: string | null;
        deleted_at: number | null;
      }>()
  ).results;
}

/** The bindings of the version the update uploaded. */
const uploadedBindings = (w: World) =>
  (w.fake.state.versions.at(-1)?.metadata.bindings ?? []) as Array<Record<string, unknown>>;

/** The catalog moves on to another version: the index lists it and its artifact is served. */
async function nextVersion(w: World, options: ArtifactFixtureOptions): Promise<void> {
  const next = await buildArtifactFixture(options);
  const inner = w.fetch;
  w.fetch = async (input, init) => next.serve(input, init) ?? inner(input, init);
  w.fixture = next;
  await cacheIndex(next);
}

/** Rolls the install back to the version before the update `jobId`. */
async function rollBack(w: World, jobId: string): Promise<void> {
  let rollback: RollbackJobParams | null = null;
  await startRollbackCore(
    {
      db: env.DB,
      createJob: async (id, p) => {
        rollback = p;
        return { id };
      },
      newId: () => `rb-${jobId}`,
    },
    { installId: INSTALL_ID, snapshotId: jobId },
  );
  if (rollback === null) throw new Error("no rollback params");
  await runRollback({
    params: rollback,
    step: fakeStep(),
    env: jobEnv(),
    deps: { fetch: w.fetch },
  });
  const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?1")
    .bind(`rb-${jobId}`)
    .first<{ status: string }>();
  if (job?.status !== "succeeded") throw new Error(`the rollback ended ${job?.status}`);
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
});

describe("a version that connects to a database elsewhere", () => {
  it("asks for the connection string, and leaves the update for an admin", async () => {
    const w = await world(WITH_DATABASE);
    const { result, params } = await start(w);
    expect(params).toBeNull();
    expect(result).toMatchObject({
      version: "1.1.0",
      needsSecrets: [],
      needsDatabases: [{ binding: "HYPERDRIVE", protocol: "postgres", label: "Main database" }],
    });
    if ("jobId" in result) throw new Error("the update started");
    // Automatic updates and Update all take this path and say why they wait.
    expect(describeNeeds(result)).toBe("a connection string for HYPERDRIVE");
  });

  it("refuses a connection string the install form would refuse, without repeating it", async () => {
    const w = await world(WITH_DATABASE);
    const wrong = `mysql://app:${DB_PASSWORD}@db.example.com/app`;
    const refused = await start(w, { hyperdrive: { HYPERDRIVE: wrong } }).catch((e: Error) => e);
    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toMatch(/Main database \(HYPERDRIVE\)/);
    expect(String(refused)).not.toContain(DB_PASSWORD);
    await expect(start(w, { hyperdrive: { OTHER: CONNECTION } })).rejects.toThrow(
      /does not take a connection string for: OTHER/,
    );
  });

  it("creates the configuration first, binds it, and never records the connection string", async () => {
    const w = await world(WITH_DATABASE);
    const { params } = await start(w, { hyperdrive: { HYPERDRIVE: ` ${CONNECTION} ` } });
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    // Before the assets and the upload; after the snapshot.
    const names = r.step.names;
    expect(names.indexOf("record snapshot")).toBeLessThan(
      names.indexOf("create Hyperdrive configuration cut-hyperdrive"),
    );
    expect(names.indexOf("record Hyperdrive configuration cut-hyperdrive")).toBeLessThan(
      names.indexOf("upload Worker version"),
    );
    expect(w.side.state.hyperdrive).toEqual([
      {
        id: "hd-1",
        name: "cut-hyperdrive",
        body: {
          name: "cut-hyperdrive",
          origin: expect.objectContaining({
            scheme: "postgres",
            host: "db.example.com",
            port: 5432,
            database: "app",
            user: "app",
          }),
        },
      },
    ]);
    expect(uploadedBindings(w)).toContainEqual({
      type: "hyperdrive",
      name: "HYPERDRIVE",
      id: "hd-1",
    });
    expect(r.resources).toContainEqual({
      kind: "hyperdrive",
      binding: "HYPERDRIVE",
      name: "cut-hyperdrive",
      cf_id: "hd-1",
      deleted_at: null,
    });
    // The serving version bound no configuration: the snapshot says so.
    expect(r.snapshot?.hyperdrive_json).toBe("{}");
    expect(JSON.parse(r.job?.input_json ?? "{}").hyperdrive).toEqual(["HYPERDRIVE"]);
    const recorded = JSON.stringify([r.job, r.logs, r.resources, r.snapshot]);
    expect(recorded).not.toContain(DB_PASSWORD);
    expect(recorded).not.toContain("db.example.com");
  });

  it("refuses to run without the connection string, before anything changes", async () => {
    const w = await world(WITH_DATABASE);
    const { params } = await start(w, { hyperdrive: { HYPERDRIVE: CONNECTION } });
    if (params === null) throw new Error("the update did not start");
    const { hyperdrive: _dropped, ...without } = params;
    const r = await run(w, without);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /^plan update: This version connects HYPERDRIVE to a database elsewhere, and the update was started without its connection string/,
    );
    expect(r.snapshot).toBeNull();
    expect(w.side.state.calls).toEqual([]);
  });

  it("keeps a configuration a failed attempt made, and does not ask for its connection string again", async () => {
    const w = await world(WITH_DATABASE, {
      resources: [
        ...RESOURCES,
        { kind: "hyperdrive", binding: "HYPERDRIVE", name: "cut-hyperdrive", cfId: "hd-9" },
      ],
    });
    const { result, params } = await start(w);
    expect("needsDatabases" in result).toBe(false);
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("succeeded");
    expect(w.side.state.calls).toEqual([]);
    expect(uploadedBindings(w)).toContainEqual({
      type: "hyperdrive",
      name: "HYPERDRIVE",
      id: "hd-9",
    });
  });

  describe("a configuration a failed attempt made, which the installed version does not use", () => {
    const seeded = {
      resources: [
        ...RESOURCES,
        {
          kind: "hyperdrive" as const,
          binding: "HYPERDRIVE",
          name: "cut-hyperdrive",
          cfId: "hd-9",
        },
      ],
    };
    const REPLACEMENT = "cut-hyperdrive-rjob2";

    it("is offered for replacing to an admin who pressed Update, and kept when left empty", async () => {
      const w = await world(WITH_DATABASE, seeded);
      const offered = await start(w, { offerChoices: true });
      expect(offered.params).toBeNull();
      if ("jobId" in offered.result) throw new Error("the update started");
      expect(offered.result.replaceableDatabases).toEqual([
        { binding: "HYPERDRIVE", protocol: "postgres", label: "Main database" },
      ]);
      expect(offered.result.needsDatabases).toBeUndefined();
      await expect(
        start(w, { offerChoices: true, hyperdrive: { HYPERDRIVE: "postgres://nope" } }),
      ).rejects.toThrow(/Main database \(HYPERDRIVE\)/);
      // The dialog sends only the fields filled in: none keeps the configuration.
      // (An unattended start is not offered the choice: see the test above.)
      const kept = await start(w, { offerChoices: true, hyperdrive: {} });
      if (kept.params === null) throw new Error("the update did not start");
      expect(kept.params.hyperdrive).toBeUndefined();
    });

    it("is replaced by a configuration made from the string given, which the version binds", async () => {
      const w = await world(WITH_DATABASE, seeded);
      w.side.state.hyperdrive.push({ id: "hd-9", name: "cut-hyperdrive", body: {} });
      const { params } = await start(
        w,
        { offerChoices: true, hyperdrive: { HYPERDRIVE: CONNECTION } },
        "job2",
      );
      if (params === null) throw new Error("the update did not start");
      const r = await run(w, params);
      expect(r.error).toBeNull();
      expect(r.job?.status).toBe("succeeded");
      expect(w.side.state.hyperdrive.map((c) => [c.id, c.name])).toEqual([
        ["hd-9", "cut-hyperdrive"],
        ["hd-2", REPLACEMENT],
      ]);
      expect(uploadedBindings(w)).toContainEqual({
        type: "hyperdrive",
        name: "HYPERDRIVE",
        id: "hd-2",
      });
      // The replaced one stays, superseded, for a rollback; the next update deletes it.
      expect(r.resources.filter((x) => x.kind.startsWith("hyperdrive"))).toEqual([
        {
          kind: "hyperdrive_superseded",
          binding: "HYPERDRIVE",
          name: "cut-hyperdrive",
          cf_id: "hd-9",
          deleted_at: null,
        },
        {
          kind: "hyperdrive",
          binding: "HYPERDRIVE",
          name: REPLACEMENT,
          cf_id: "hd-2",
          deleted_at: null,
        },
      ]);
      const recorded = JSON.stringify([r.job, r.logs, r.resources]);
      expect(recorded).not.toContain(DB_PASSWORD);
    });

    it("deletes the configuration it made when the new version never serves", async () => {
      const w = await world(WITH_DATABASE, seeded, {
        previews: [{ status: 500, body: "boom" }],
      });
      const { params } = await start(
        w,
        { offerChoices: true, hyperdrive: { HYPERDRIVE: CONNECTION } },
        "job2",
      );
      if (params === null) throw new Error("the update did not start");
      const r = await run(w, params);
      expect(r.job?.status).toBe("failed");
      expect(w.side.state.calls).toContain("DELETE /hyperdrive/configs/hd-1");
      expect(w.side.state.hyperdrive).toEqual([]);
      // The configuration the install had stays bound to its binding.
      expect(r.resources.filter((x) => x.kind.startsWith("hyperdrive"))).toEqual([
        {
          kind: "hyperdrive",
          binding: "HYPERDRIVE",
          name: "cut-hyperdrive",
          cf_id: "hd-9",
          deleted_at: null,
        },
        expect.objectContaining({
          name: REPLACEMENT,
          binding: null,
          deleted_at: expect.any(Number),
        }),
      ]);
    });

    it("keeps the configuration it made, unbound, when a full deploy that started fails", async () => {
      // A Durable Object migration makes the update one script upload, with no canary.
      const w = await world(
        {
          ...WITH_DATABASE,
          bindings: [
            ...(WITH_DATABASE.bindings ?? []),
            { type: "durable_object_namespace", name: "ROOMS", class_name: "Room" },
          ],
          migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
        },
        seeded,
      );
      w.side.state.hyperdrive.push({ id: "hd-9", name: "cut-hyperdrive", body: {} });
      const inner = w.fetch;
      w.fetch = async (input, init) =>
        init?.method === "PUT" && new URL(input).pathname.endsWith("/workers/scripts/cut")
          ? Response.json(
              { success: false, errors: [{ code: 10021, message: "deploy refused" }] },
              { status: 400 },
            )
          : inner(input, init);
      const { params } = await start(
        w,
        { offerChoices: true, confirmNoPreview: true, hyperdrive: { HYPERDRIVE: CONNECTION } },
        "job2",
      );
      if (params === null) throw new Error("the update did not start");
      const r = await run(w, params);
      expect(r.job?.status).toBe("failed");
      expect(r.job?.error).toMatch(/^deploy Worker script: /);
      // Neither deleted nor switched: the install's configuration keeps the binding.
      expect(w.side.state.calls).not.toContain("DELETE /hyperdrive/configs/hd-2");
      expect(w.side.state.hyperdrive.map((c) => c.id)).toEqual(["hd-9", "hd-2"]);
      expect(r.resources.filter((x) => x.kind.startsWith("hyperdrive"))).toEqual([
        {
          kind: "hyperdrive",
          binding: "HYPERDRIVE",
          name: "cut-hyperdrive",
          cf_id: "hd-9",
          deleted_at: null,
        },
        { kind: "hyperdrive", binding: null, name: REPLACEMENT, cf_id: "hd-2", deleted_at: null },
      ]);
      expect(r.logs).toContainEqual({
        level: "error",
        message: `The Hyperdrive configurations made for this update (${REPLACEMENT}) stay in place, as the deploy that started may have made the new version use them; the bindings keep the configurations they had, and uninstalling the app deletes these.`,
      });
    });
  });

  it("leaves the configuration in place on a rollback, and a later update binds it again", async () => {
    const w = await world(WITH_DATABASE);
    const first = await start(w, { hyperdrive: { HYPERDRIVE: CONNECTION } });
    if (first.params === null) throw new Error("the update did not start");
    expect((await run(w, first.params)).job?.status).toBe("succeeded");

    let rollback: RollbackJobParams | null = null;
    await startRollbackCore(
      {
        db: env.DB,
        createJob: async (id, p) => {
          rollback = p;
          return { id };
        },
        newId: () => "rb1",
      },
      { installId: INSTALL_ID, snapshotId: "job1" },
    );
    if (rollback === null) throw new Error("no rollback params");
    await runRollback({
      params: rollback,
      step: fakeStep(),
      env: jobEnv(),
      deps: { fetch: w.fetch },
    });
    const rolledBack = await env.DB.prepare(
      "SELECT status, error FROM jobs WHERE id = 'rb1'",
    ).first<{
      status: string;
      error: string | null;
    }>();
    expect(rolledBack).toEqual({ status: "succeeded", error: null });
    expect(w.fake.state.deployments[0]?.versions[0]?.version_id).toBe(OLD_VERSION);
    // Left in place, still bound to its binding's name, for the next update.
    expect(await rows()).toContainEqual({
      kind: "hyperdrive",
      binding: "HYPERDRIVE",
      name: "cut-hyperdrive",
      cf_id: "hd-1",
      deleted_at: null,
    });

    // The catalog's version is newer again: the update binds the same configuration.
    const again = await start(w, {}, "job2");
    expect("needsDatabases" in again.result).toBe(false);
    if (again.params === null) throw new Error("the second update did not start");
    const r = await run(w, again.params);
    expect(r.job?.status).toBe("succeeded");
    expect(w.side.state.hyperdrive).toHaveLength(1);
    expect(uploadedBindings(w)).toContainEqual({
      type: "hyperdrive",
      name: "HYPERDRIVE",
      id: "hd-1",
    });
  });

  it("leaves the configuration in place when a later version drops the database", async () => {
    const w = await world(
      { ...BASE, version: "1.2.0" },
      {
        resources: [
          ...RESOURCES,
          { kind: "hyperdrive", binding: "HYPERDRIVE", name: "cut-hyperdrive", cfId: "hd-1" },
        ],
      },
    );
    const { params } = await start(w);
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("succeeded");
    expect(r.logs).toContainEqual({
      level: "info",
      message:
        'Binding HYPERDRIVE is not in this version; its hyperdrive "cut-hyperdrive" is left in place.',
    });
    expect(r.resources).toContainEqual(
      expect.objectContaining({ kind: "hyperdrive", cf_id: "hd-1", deleted_at: null }),
    );
    expect(w.side.state.calls).toEqual([]);
  });
});

describe("a version that streams events", () => {
  const request = { paidConfirmed: true };

  it("asks for a new sink token like any new secret, and creates the bucket, catalog, stream, sink and pipeline", async () => {
    const w = await world(WITH_STREAM);
    const asked = await start(w, request);
    if ("jobId" in asked.result) throw new Error("the update started");
    expect(asked.result.needsSecrets.map((s) => s.name)).toEqual(["CATALOG_TOKEN"]);
    expect(asked.result.streamTokens).toEqual(["CATALOG_TOKEN"]);
    expect(asked.result.heldSecrets).toBeUndefined();

    const { params } = await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const names = r.step.names;
    // The permission is checked before the snapshot; the stream comes last of the resources.
    expect(names.indexOf("check Pipelines")).toBeLessThan(names.indexOf("record snapshot"));
    expect(names).toEqual(
      expect.arrayContaining([
        "create R2 bucket cut-warehouse",
        "turn on R2 Data Catalog for cut-warehouse",
        "create Pipelines stream cut_events_stream",
        "create Pipelines sink cut_events_sink",
        "create pipeline cut_events_pipeline",
      ]),
    );
    expect(names.indexOf("record pipeline cut_events_pipeline")).toBeLessThan(
      names.indexOf("upload Worker version"),
    );
    expect(w.side.state.buckets).toEqual(["cut-warehouse"]);
    expect(w.side.state.catalogCalls).toEqual([
      "GET /r2-catalog/cut-warehouse as sink",
      "POST /r2-catalog/cut-warehouse/enable as sink",
    ]);
    expect(w.side.state.sinks[0]?.body).toMatchObject({
      name: "cut_events_sink",
      type: "r2_data_catalog",
      config: {
        account_id: ACC,
        bucket: "cut-warehouse",
        namespace: "cut",
        table_name: "events",
        token: SINK_TOKEN,
      },
    });
    expect(w.side.state.pipelines[0]?.body).toEqual({
      name: "cut_events_pipeline",
      sql: "INSERT INTO cut_events_sink SELECT * FROM cut_events_stream",
    });
    const bindings = uploadedBindings(w);
    expect(bindings).toContainEqual({ type: "pipelines", name: "EVENTS", stream: "streams-1" });
    expect(bindings).toContainEqual({
      type: "secret_text",
      name: "CATALOG_TOKEN",
      text: SINK_TOKEN,
    });
    expect(r.resources.map((x) => [x.kind, x.name])).toEqual(
      expect.arrayContaining([
        ["r2", "cut-warehouse"],
        ["r2_catalog", "cut-warehouse"],
        ["pipeline_stream", "cut_events_stream"],
        ["pipeline_sink", "cut_events_sink"],
        ["pipeline", "cut_events_pipeline"],
        ["secret", "CATALOG_TOKEN"],
      ]),
    );
    expect(JSON.stringify([r.job, r.logs, r.resources])).not.toContain(SINK_TOKEN);
  });

  it("asks again for a token the Worker already has, and keeps the bucket's own Data Catalog", async () => {
    const w = await world(
      {
        ...WITH_STREAM,
        bindings: [...(WITH_STREAM.bindings ?? []), { type: "r2_bucket", name: "WAREHOUSE" }],
      },
      {
        resources: [
          ...RESOURCES,
          { kind: "secret", binding: "CATALOG_TOKEN", name: "CATALOG_TOKEN" },
          { kind: "r2", binding: "WAREHOUSE", name: "cut-warehouse", cfId: "cut-warehouse" },
        ],
      },
    );
    // The bucket has a catalog Appflare did not record (the app's own tables).
    w.side.state.catalogs["cut-warehouse"] = { id: "cat-app", status: "active" };
    const asked = await start(w, request);
    if ("jobId" in asked.result) throw new Error("the update started");
    expect(asked.result.needsSecrets.map((s) => s.name)).toEqual(["CATALOG_TOKEN"]);
    expect(asked.result.heldSecrets).toEqual(["CATALOG_TOKEN"]);
    expect(asked.result.streamTokens).toEqual(["CATALOG_TOKEN"]);
    await expect(start(w, { ...request, secrets: {} })).rejects.toThrow(
      /CATALOG_TOKEN\) is required/,
    );

    const { params } = await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("succeeded");
    expect(w.side.state.buckets).toEqual([]);
    expect(w.side.state.catalogCalls).toEqual(["GET /r2-catalog/cut-warehouse as sink"]);
    expect(w.side.state.catalogs["cut-warehouse"]).toEqual({ id: "cat-app", status: "active" });
    expect(r.logs).toContainEqual({
      level: "info",
      message:
        "Secret CATALOG_TOKEN: set again with the new version, to the value given for this update.",
    });
    expect(uploadedBindings(w)).toContainEqual({
      type: "secret_text",
      name: "CATALOG_TOKEN",
      text: SINK_TOKEN,
    });
  });

  it("finishes a stream a failed update left without its sink and pipeline", async () => {
    const w = await world(WITH_STREAM, {
      resources: [
        ...RESOURCES,
        { kind: "secret", binding: "CATALOG_TOKEN", name: "CATALOG_TOKEN" },
        ...STREAM_ROWS.slice(0, 3),
      ],
    });
    w.side.state.streams.push({ id: "streams-1", name: "cut_events_stream", body: {} });
    w.side.state.catalogs["cut-warehouse"] = { id: "cat-1", status: "active" };
    const asked = await start(w, request);
    if ("jobId" in asked.result) throw new Error("the update started");
    expect(asked.result.heldSecrets).toEqual(["CATALOG_TOKEN"]);
    const { params } = await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names).not.toContain("create Pipelines stream cut_events_stream");
    expect(r.step.names).not.toContain("turn on R2 Data Catalog for cut-warehouse");
    // The installed version does not describe the stream: it is read before the plan.
    expect(w.side.state.calls).toContain("GET /pipelines/v1/streams/streams-1");
    expect(w.side.state.streams).toHaveLength(1);
    expect(w.side.state.sinks.map((s) => s.name)).toEqual(["cut_events_sink"]);
    expect(w.side.state.pipelines.map((p) => p.name)).toEqual(["cut_events_pipeline"]);
    expect(uploadedBindings(w)).toContainEqual({
      type: "pipelines",
      name: "EVENTS",
      stream: "streams-1",
    });
  });

  it("keeps a whole stream without asking for its token", async () => {
    const w = await world(WITH_STREAM, {
      resources: [
        ...RESOURCES,
        { kind: "secret", binding: "CATALOG_TOKEN", name: "CATALOG_TOKEN" },
        ...STREAM_ROWS,
      ],
      manifestJson: JSON.stringify({
        version: "1.0.0",
        worker: { migrations: [], bindings: [{ type: "pipelines", name: "EVENTS" }] },
        catalog: { resources: { pipelines: { EVENTS: { sink } } } },
      }),
    });
    const { result, params } = await start(w, request);
    expect("jobId" in result).toBe(true);
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("succeeded");
    expect(w.side.state.calls).toEqual([]);
  });

  it("refuses before the snapshot when the token lacks Pipelines", async () => {
    const w = await world(WITH_STREAM);
    w.side.state.pipelinesRefused = true;
    const { params } = await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^check Pipelines: Cloudflare refused the Pipelines call/);
    expect(r.snapshot).toBeNull();
    expect(w.fake.state.versions).toEqual([]);
  });

  describe("a recorded stream the installed version does not describe, which cannot be read", () => {
    /** The stream (and its sink with `withSink`) a failed update made; Cloudflare still has them. */
    async function halfMade(withSink: boolean): Promise<World> {
      const w = await world(WITH_STREAM, {
        resources: [
          ...RESOURCES,
          { kind: "secret", binding: "CATALOG_TOKEN", name: "CATALOG_TOKEN" },
          ...STREAM_ROWS.slice(0, withSink ? 4 : 3),
        ],
      });
      w.side.state.streams.push({ id: "streams-1", name: "cut_events_stream", body: {} });
      if (withSink) {
        w.side.state.sinks.push({
          id: "sinks-1",
          name: "cut_events_sink",
          body: { config: { bucket: "cut-warehouse", namespace: "cut", table_name: "events" } },
        });
      }
      return w;
    }

    /** Answers `GET /pipelines/v1/<what>/<id>` with `status` instead of the fake. */
    function failRead(w: World, what: "streams" | "sinks", status: number): void {
      const inner = w.fetch;
      w.fetch = async (input, init) =>
        (init?.method ?? "GET") === "GET" &&
        new URL(input).pathname.endsWith(`/pipelines/v1/${what}/${what}-1`)
          ? Response.json(
              { success: false, errors: [{ code: status === 403 ? 100 : 1000, message: "no" }] },
              { status },
            )
          : inner(input, init);
    }

    async function runUpdateOf(w: World) {
      // A stream without its sink asks for the sink's token; one with it does not.
      const asked = await start(w, request);
      const { params } =
        asked.params === null
          ? await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } })
          : asked;
      if (params === null) throw new Error("the update did not start");
      return run(w, params);
    }

    /** Failed in the read, before the snapshot, with nothing made. */
    function expectNothingMade(
      w: World,
      r: Awaited<ReturnType<typeof run>>,
      had: { streams: number; sinks: number },
    ) {
      expect(r.job?.status).toBe("failed");
      expect(r.snapshot).toBeNull();
      expect(r.step.names).not.toContain("record snapshot");
      expect(w.side.state.calls.filter((c) => c.startsWith("POST "))).toEqual([]);
      expect(w.side.state.streams).toHaveLength(had.streams);
      expect(w.side.state.sinks).toHaveLength(had.sinks);
      expect(w.side.state.pipelines).toEqual([]);
      expect(w.fake.state.versions).toEqual([]);
    }

    it("says the stream is gone when Cloudflare no longer has it", async () => {
      const w = await halfMade(false);
      w.side.state.streams = [];
      const r = await runUpdateOf(w);
      expect(r.job?.error).toBe(
        "read Pipelines streams: The Pipelines stream of EVENTS (id streams-1), which an earlier update made, is gone from the account; uninstall the app and install this version instead",
      );
      expect(w.side.state.calls).toContain("GET /pipelines/v1/streams/streams-1");
      expectNothingMade(w, r, { streams: 0, sinks: 0 });
    });

    it("says the sink is gone when Cloudflare no longer has it", async () => {
      const w = await halfMade(true);
      w.side.state.sinks = [];
      const r = await runUpdateOf(w);
      expect(r.job?.error).toBe(
        "read Pipelines streams: The Pipelines sink of EVENTS (id sinks-1), which an earlier update made, is gone from the account; uninstall the app and install this version instead",
      );
      expectNothingMade(w, r, { streams: 1, sinks: 0 });
    });

    it("fails on a refusal to read the stream, naming the permission", async () => {
      const w = await halfMade(false);
      w.side.state.pipelinesRefused = true;
      const r = await runUpdateOf(w);
      expect(r.job?.error).toMatch(
        /^read Pipelines streams: Cloudflare refused the Pipelines call/,
      );
      expectNothingMade(w, r, { streams: 1, sinks: 0 });
    });

    it("fails on a refusal to read the sink, naming the permission", async () => {
      const w = await halfMade(true);
      failRead(w, "sinks", 403);
      const r = await runUpdateOf(w);
      expect(r.job?.error).toMatch(
        /^read Pipelines streams: Cloudflare refused the Pipelines call/,
      );
      expectNothingMade(w, r, { streams: 1, sinks: 1 });
    });

    it.each([
      ["stream", "streams"],
      ["sink", "sinks"],
    ] as const)("fails when Cloudflare cannot answer for the %s", async (_, what) => {
      const w = await halfMade(true);
      failRead(w, what, 503);
      const r = await runUpdateOf(w);
      expect(r.job?.error).toMatch(/^read Pipelines streams: /);
      expect(r.job?.error).not.toMatch(/gone from the account|refused the Pipelines call/);
      expectNothingMade(w, r, { streams: 1, sinks: 1 });
    });
  });

  it("names the update, not a reinstall, when the sink cannot be made", async () => {
    const w = await world(WITH_STREAM);
    const inner = w.fetch;
    w.fetch = async (input, init) =>
      input.endsWith("/pipelines/v1/sinks") && init?.method === "POST"
        ? Response.json(
            { success: false, errors: [{ code: 1000, message: "bad token" }] },
            { status: 400 },
          )
        : inner(input, init);
    const { params } = await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /^create Pipelines sink cut_events_sink: Cloudflare could not create the sink of EVENTS \(bad token\)\. .*then start the update again$/,
    );
    // What was made stays recorded; the next attempt finishes it.
    expect(r.resources.map((x) => x.kind)).toEqual(
      expect.arrayContaining(["r2", "r2_catalog", "pipeline_stream"]),
    );
    expect(w.fake.state.versions).toEqual([]);
    const next = await start(w, request, "job2");
    if ("jobId" in next.result) throw new Error("the retry started without the token");
    expect(next.result.heldSecrets).toBeUndefined();
    expect(next.result.needsSecrets.map((s) => s.name)).toEqual(["CATALOG_TOKEN"]);
  });

  /** A later version's stream of another shape. */
  const withSchema: ArtifactFixtureOptions = {
    ...WITH_STREAM,
    version: "1.2.0",
    catalog: {
      ...WITH_STREAM.catalog,
      resources: {
        pipelines: {
          EVENTS: { schema: { fields: [{ name: "url", type: "string" }] }, sink },
        },
      },
    },
  };

  it("refuses a later version of another shape than the stream a rolled-back update made", async () => {
    const w = await world(WITH_STREAM);
    const first = await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    if (first.params === null) throw new Error("the update did not start");
    expect((await run(w, first.params)).job?.status).toBe("succeeded");
    // Back on the version without EVENTS; its stream, sink and pipeline stay recorded.
    await rollBack(w, "job1");

    await nextVersion(w, withSchema);
    // The rollback took the token off with the version that brought it.
    const { params } = await start(
      w,
      { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } },
      "job2",
    );
    if (params === null) throw new Error("the second update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /^plan update: .*Binding EVENTS sends events to the Pipelines stream "cut_events_stream", which an earlier update made; this version changes its schema\. .*needs a fresh install\./,
    );
    // Read as Cloudflare has it, before anything changed.
    expect(w.side.state.calls).toEqual(
      expect.arrayContaining([
        "GET /pipelines/v1/streams/streams-1",
        "GET /pipelines/v1/sinks/sinks-1",
      ]),
    );
    expect(r.snapshot).toBeNull();
    expect(w.side.state.streams).toHaveLength(1);
  });

  it("refuses a version of another shape than a stream a failed update left half made", async () => {
    const w = await world(WITH_STREAM);
    const inner = w.fetch;
    let sinkRefused = true;
    w.fetch = async (input, init) =>
      sinkRefused && input.endsWith("/pipelines/v1/sinks") && init?.method === "POST"
        ? Response.json(
            { success: false, errors: [{ code: 1000, message: "bad token" }] },
            { status: 400 },
          )
        : inner(input, init);
    const first = await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    if (first.params === null) throw new Error("the update did not start");
    expect((await run(w, first.params)).job?.status).toBe("failed");
    sinkRefused = false;

    await nextVersion(w, withSchema);
    const { params } = await start(
      w,
      { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } },
      "job2",
    );
    if (params === null) throw new Error("the second update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /stream "cut_events_stream", which an earlier update made; this version changes its schema\./,
    );
    // The stream has no recorded sink: only the stream is read, and no sink is made.
    expect(w.side.state.calls).toContain("GET /pipelines/v1/streams/streams-1");
    expect(w.side.state.calls.filter((c) => c.startsWith("GET /pipelines/v1/sinks/"))).toEqual([]);
    expect(w.side.state.sinks).toEqual([]);
    expect(r.snapshot).toBeNull();
  });

  it("refuses a version whose events land in another table than a half-made stream's sink", async () => {
    const w = await world(
      {
        ...WITH_STREAM,
        catalog: {
          ...WITH_STREAM.catalog,
          resources: { pipelines: { EVENTS: { sink: { ...sink, table: "clicks" } } } },
        },
      },
      {
        resources: [
          ...RESOURCES,
          { kind: "secret", binding: "CATALOG_TOKEN", name: "CATALOG_TOKEN" },
          ...STREAM_ROWS.slice(0, 4),
        ],
      },
    );
    w.side.state.streams.push({ id: "streams-1", name: "cut_events_stream", body: {} });
    w.side.state.sinks.push({
      id: "sinks-1",
      name: "cut_events_sink",
      body: { config: { bucket: "cut-warehouse", namespace: "cut", table_name: "events" } },
    });
    // Only the pipeline is missing: no token is asked for.
    const { result, params } = await start(w, request);
    expect("jobId" in result).toBe(true);
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(
      /changes the table its events land in \(from cut-warehouse cut\.events to cut-warehouse cut\.clicks\)/,
    );
    expect(w.side.state.pipelines).toEqual([]);
  });

  it("finishes a stream a failed update left without its pipeline, without asking for the token", async () => {
    const w = await world(WITH_STREAM, {
      resources: [
        ...RESOURCES,
        { kind: "secret", binding: "CATALOG_TOKEN", name: "CATALOG_TOKEN" },
        ...STREAM_ROWS.slice(0, 4),
      ],
    });
    w.side.state.streams.push({ id: "streams-1", name: "cut_events_stream", body: {} });
    w.side.state.sinks.push({
      id: "sinks-1",
      name: "cut_events_sink",
      body: { config: { bucket: "cut-warehouse", namespace: "cut", table_name: "events" } },
    });
    const { result, params } = await start(w, request);
    expect("jobId" in result).toBe(true);
    if (params === null) throw new Error("the update did not start");
    expect(params.secrets).toEqual({});
    const r = await run(w, params);
    expect(r.job?.status).toBe("succeeded");
    expect(w.side.state.sinks).toHaveLength(1);
    expect(w.side.state.pipelines.map((p) => p.name)).toEqual(["cut_events_pipeline"]);
    // The Worker keeps the token it has.
    expect(uploadedBindings(w).some((b) => b.name === "CATALOG_TOKEN")).toBe(false);
  });

  it("names exactly what to delete when a sink of its name exists unrecorded", async () => {
    const w = await world(WITH_STREAM, {
      resources: [
        ...RESOURCES,
        { kind: "secret", binding: "CATALOG_TOKEN", name: "CATALOG_TOKEN" },
        ...STREAM_ROWS.slice(0, 3),
      ],
    });
    w.side.state.streams.push({ id: "streams-1", name: "cut_events_stream", body: {} });
    // An earlier attempt made the sink and the pipeline but never heard back.
    w.side.state.sinks.push({ id: "sinks-1", name: "cut_events_sink", body: {} });
    w.side.state.pipelines.push({ id: "pipelines-1", name: "cut_events_pipeline", body: {} });
    const { params } = await start(w, { ...request, secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    if (params === null) throw new Error("the update did not start");
    const r = await run(w, params);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toBe(
      'check Pipelines names for EVENTS: the pipeline "cut_events_pipeline" and the Pipelines sink "cut_events_sink" already exist in this account, but Appflare has no record of them and does not adopt what it has not recorded; an earlier attempt may have made them without hearing back from Cloudflare. Delete them in the Cloudflare dashboard under Pipelines (or run wrangler pipelines delete cut_events_pipeline, then wrangler pipelines sinks delete cut_events_sink), then start the update again.',
    );
  });
});

describe("a version that changes the app's email and adds a database", () => {
  const withEmail = (version: string, rules: string[]) => ({
    ...WITH_DATABASE,
    version,
    catalog: {
      ...WITH_DATABASE.catalog,
      install: { ...baseCatalog().install, emailRouting: { rules, catchAll: false } },
    },
  });

  it("asks for both, waits for an admin, and starts only once both are given", async () => {
    const installed = await buildArtifactFixture({
      ...withEmail("1.0.0", ["inbox"]),
      bindings: BASE.bindings,
    });
    const w = await world(withEmail("1.1.0", ["alerts"]), {
      manifestJson: new TextDecoder().decode(installed.manifestBytes),
    });
    // What the cron and Update all see: the needs, not a job.
    const { result, params } = await start(w);
    expect(params).toBeNull();
    if ("jobId" in result) throw new Error("the update started");
    expect(result.needsDatabases?.map((d) => d.binding)).toEqual(["HYPERDRIVE"]);
    expect(result.emailRouting).toContain("alerts");
    expect(describeNeeds(result)).toBe(
      "a connection string for HYPERDRIVE, a look at how it changes the app's email",
    );
    // One without the other is not enough.
    const onlyDatabase = await start(w, { hyperdrive: { HYPERDRIVE: CONNECTION } });
    expect("jobId" in onlyDatabase.result).toBe(false);
    const onlyEmail = await start(w, { confirmEmailRouting: "1.1.0" });
    expect("jobId" in onlyEmail.result).toBe(false);
    const both = await start(w, {
      hyperdrive: { HYPERDRIVE: CONNECTION },
      confirmEmailRouting: "1.1.0",
    });
    expect(both.params?.hyperdrive).toEqual({ HYPERDRIVE: CONNECTION });
  });
});

describe("an update from a reviewed build", () => {
  /** A catalog app's build from source, reviewed and ready to update the install. */
  async function reviewedBuild(options: ArtifactFixtureOptions): Promise<void> {
    const fixture = await buildArtifactFixture(options);
    await env.DB.prepare(
      `INSERT INTO source_builds (id, install_id, purpose, origin, app_slug, repo, status,
         commit_sha, ref, version, digest, manifest_key, artifact_key, image, manifest_json,
         built_at, created_at, updated_at)
       VALUES ('build1', ?1, 'update', 'source', 'cut', 'MendyLanda/cut', 'built', ?2, 'main',
         ?3, ?4, 'builds/m.json', 'builds/a.zip', 'docker.io/appflare/sandbox:test', ?5, 1, 1, 1)`,
    )
      .bind(
        INSTALL_ID,
        "f".repeat(40),
        fixture.manifest.version,
        fixture.digest,
        new TextDecoder().decode(fixture.manifestBytes),
      )
      .run();
  }

  async function needsOfBuild() {
    const build = await readSourceBuild(env.DB, "build1");
    if (build?.manifest == null) throw new Error("the build did not parse");
    return sourceUpdateNeeds(env.DB, await readInstall(env.DB, INSTALL_ID), build.manifest);
  }

  async function startFromBuild(input: {
    secrets?: Record<string, string>;
    hyperdrive?: Record<string, string>;
  }) {
    let params: UpdateJobParams | null = null;
    const started = await updateFromSourceBuildCore(
      {
        db: env.DB,
        createJob: async (id, p) => {
          params = p;
          return { id };
        },
        newId: () => "job1",
      },
      { buildId: "build1", ...input },
    );
    return { started, params: params as UpdateJobParams | null };
  }

  it("asks for a new database's connection string as the update dialog does", async () => {
    await seedInstall({ resources: RESOURCES });
    await reviewedBuild(WITH_DATABASE);
    expect((await needsOfBuild()).needsDatabases).toEqual([
      { binding: "HYPERDRIVE", protocol: "postgres", label: "Main database" },
    ]);
    await expect(startFromBuild({})).rejects.toThrow(/Main database \(HYPERDRIVE\) is required/);
    const wrong = await startFromBuild({
      hyperdrive: { HYPERDRIVE: `mysql://app:${DB_PASSWORD}@db.example.com/app` },
    }).catch((e: Error) => e);
    expect(String(wrong)).toMatch(/Main database \(HYPERDRIVE\)/);
    expect(String(wrong)).not.toContain(DB_PASSWORD);

    const { started, params } = await startFromBuild({ hyperdrive: { HYPERDRIVE: CONNECTION } });
    expect(started.jobId).toBe("job1");
    expect(params?.hyperdrive).toEqual({ HYPERDRIVE: CONNECTION });
    expect(params?.prebuilt).toMatchObject({ buildId: "build1", origin: "source" });
    const job = await env.DB.prepare("SELECT input_json FROM jobs WHERE id = 'job1'").first<{
      input_json: string;
    }>();
    expect(JSON.parse(job?.input_json ?? "{}").hyperdrive).toEqual(["HYPERDRIVE"]);
    expect(job?.input_json).not.toContain(DB_PASSWORD);
  });

  it("offers to replace a configuration an earlier update made, as the dialog does", async () => {
    await seedInstall({
      resources: [
        ...RESOURCES,
        { kind: "hyperdrive", binding: "HYPERDRIVE", name: "cut-hyperdrive", cfId: "hd-9" },
      ],
    });
    await reviewedBuild(WITH_DATABASE);
    const needs = await needsOfBuild();
    expect(needs.needsDatabases).toBeUndefined();
    expect(needs.replaceableDatabases).toEqual([
      { binding: "HYPERDRIVE", protocol: "postgres", label: "Main database" },
    ]);
    const wrong = await startFromBuild({
      hyperdrive: { HYPERDRIVE: `mysql://app:${DB_PASSWORD}@db.example.com/app` },
    }).catch((e: Error) => e);
    expect(String(wrong)).toMatch(/Main database \(HYPERDRIVE\)/);
    expect(String(wrong)).not.toContain(DB_PASSWORD);
    const { params } = await startFromBuild({ hyperdrive: { HYPERDRIVE: CONNECTION } });
    expect(params?.hyperdrive).toEqual({ HYPERDRIVE: CONNECTION });
  });

  it("asks again for a sink token the Worker has, and passes it on as the dialog does", async () => {
    await seedInstall({
      resources: [
        ...RESOURCES,
        { kind: "secret", binding: "CATALOG_TOKEN", name: "CATALOG_TOKEN" },
      ],
    });
    await reviewedBuild(WITH_STREAM);
    const needs = await needsOfBuild();
    expect(needs.needsSecrets.map((s) => s.name)).toEqual(["CATALOG_TOKEN"]);
    expect(needs.heldSecrets).toEqual(["CATALOG_TOKEN"]);
    expect(needs.streamTokens).toEqual(["CATALOG_TOKEN"]);
    expect(needs.needsDatabases).toBeUndefined();
    await expect(startFromBuild({})).rejects.toThrow(/R2 API token \(CATALOG_TOKEN\) is required/);
    const { params } = await startFromBuild({ secrets: { CATALOG_TOKEN: SINK_TOKEN } });
    expect(params?.secrets).toEqual({ CATALOG_TOKEN: SINK_TOKEN });
    expect(params?.hyperdrive).toBeUndefined();
  });
});
