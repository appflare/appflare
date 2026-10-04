import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import { readGateway, setUpGatewayCore } from "../gateway/gateway.server";
import { addExternalDomainCore } from "../installs/external-domains.server";
import { startDeleteRetainedCore } from "../installs/removed-apps.server";
import {
  StartUninstallError,
  type StartUninstallRequest,
  startUninstallCore,
} from "../installs/start-uninstall.server";
import { fakeSaas, GATEWAY_ZONE } from "../test/fake-saas";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import { recordProtectedInstall } from "../test/protected-install";
import type { JobEnv } from "./run-job";
import { API_STEP } from "./steps";
import {
  R2_MAX_LOCAL_PAGES_PER_RUN,
  R2_MAX_PAGES_PER_RUN,
  R2_OBJECTS_PER_LOCAL_STEP,
  R2_OBJECTS_PER_STEP,
  runUninstall,
  type UninstallJobParams,
} from "./uninstall";

/**
 * End-to-end test of the uninstall job against a stateful fake of the
 * Cloudflare API and the local D1. The Workflow engine is replaced by
 * `fakeStep` (inline steps, recorded sleeps).
 */

const ACC = "acc0000000000000000000000000000a";
const TOKEN = "cf-test-token-DO-NOT-LEAK";
const NOW = 1_790_000_000_000;

interface World {
  scripts: Set<string>;
  kv: Set<string>;
  d1: Set<string>;
  r2: Map<string, string[]>;
  queues: Set<string>;
  vectorize: Set<string>;
  /** Hyperdrive configuration ids. */
  hyperdrive: Set<string>;
  /** Pipelines objects as `<streams|sinks|pipelines>/<id>`. */
  pipelines: Set<string>;
  /** Buckets with an R2 Data Catalog. */
  catalogs: Set<string>;
  /** The token cannot remove a catalog (no Workers R2 Data Catalog: Edit). */
  catalogRefused?: boolean;
  /** Workflow names; deleting a Worker leaves them, as Cloudflare does. */
  workflows: Set<string>;
  /** Custom domains by id: hostname and the Worker it serves. */
  domains: Map<string, { hostname: string; service: string }>;
  calls: string[];
  /** `METHOD /path` keys answered once with this status instead of doing the work. */
  failOnce: Map<string, number>;
  /** Object keys whose delete answers 404 while they stay listed. */
  stuck: Set<string>;
  /** When set, the bucket listing never runs dry: every page holds fresh keys. */
  endless?: boolean;
  /** Worker consumers per queue id. */
  consumers: Map<string, Array<{ consumer_id: string; script_name?: string; service?: string }>>;
  /** Zone objects of wildcard domains: `<zone>/routes/<id>` and `<zone>/dns_records/<id>`. */
  zoneObjects: Set<string>;
}

function fakeWorld(over: Partial<World> = {}) {
  const world: World = {
    scripts: new Set(["appflare", "cut"]),
    kv: new Set(["kv-1"]),
    d1: new Set(["d1-1"]),
    r2: new Map([["cut-files", []]]),
    queues: new Set(["q-1"]),
    vectorize: new Set(["cut-vectors"]),
    hyperdrive: new Set(),
    pipelines: new Set(),
    catalogs: new Set(),
    workflows: new Set(["cut-jobs"]),
    domains: new Map(),
    calls: [],
    failOnce: new Map(),
    stuck: new Set(),
    consumers: new Map(),
    zoneObjects: new Set(),
    ...over,
  };
  const ok = (result: unknown, extra: Record<string, unknown> = {}) =>
    Response.json({ success: true, errors: [], messages: [], result, ...extra });
  const fail = (status: number, message: string) =>
    Response.json({ success: false, errors: [{ code: 10000, message }] }, { status });
  const gone = () => fail(404, "not found");

  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(`/client/v4/accounts/${ACC}`, "");
    const key = `${request.method} ${path}`;
    world.calls.push(`${key}${url.search}`);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return fail(403, "auth");
    const failing = world.failOnce.get(key);
    if (failing !== undefined) {
      world.failOnce.delete(key);
      return fail(failing, "injected failure");
    }
    if (key === "GET /workers/domains") {
      const hostname = url.searchParams.get("hostname");
      return ok(
        [...world.domains]
          .filter(([, d]) => hostname === null || d.hostname === hostname)
          .map(([id, d]) => ({ id, ...d, zone_id: "z1", zone_name: "example.com" })),
      );
    }
    let m = /^DELETE \/workers\/domains\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.domains.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/workers\/scripts\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.scripts.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/workflows\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.workflows.delete(m[1]) ? ok({ status: "ok" }) : gone();
    m = /^DELETE \/storage\/kv\/namespaces\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.kv.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/d1\/database\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.d1.delete(m[1]) ? ok(null) : gone();
    m = /^GET \/queues\/([^/]+)\/consumers$/.exec(key);
    if (m?.[1]) return world.queues.has(m[1]) ? ok(world.consumers.get(m[1]) ?? []) : gone();
    m = /^DELETE \/queues\/([^/]+)\/consumers\/([^/]+)$/.exec(key);
    if (m?.[1] && m[2]) {
      const list = world.consumers.get(m[1]) ?? [];
      const at = list.findIndex((c) => c.consumer_id === m?.[2]);
      if (at === -1) return gone();
      list.splice(at, 1);
      return ok(null);
    }
    m = /^DELETE \/client\/v4\/zones\/([^/]+)\/(workers\/routes|dns_records)\/([^/]+)$/.exec(key);
    if (m?.[1] && m[2] && m[3]) {
      const object = `${m[1]}/${m[2] === "dns_records" ? "dns_records" : "routes"}/${m[3]}`;
      return world.zoneObjects.delete(object) ? ok({ id: m[3] }) : gone();
    }
    m = /^DELETE \/queues\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.queues.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/vectorize\/v2\/indexes\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.vectorize.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/hyperdrive\/configs\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.hyperdrive.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/pipelines\/v1\/((?:streams|sinks|pipelines)\/[^/]+)$/.exec(key);
    if (m?.[1]) return world.pipelines.delete(m[1]) ? ok({}) : gone();
    m = /^POST \/r2-catalog\/([^/]+)\/delete$/.exec(key);
    if (m?.[1]) {
      if (world.catalogRefused === true) return fail(403, "Forbidden");
      if (!world.catalogs.delete(m[1])) {
        return Response.json(
          { success: false, errors: [{ code: 40401, message: "Catalog not found" }] },
          { status: 404 },
        );
      }
      return new Response(null, { status: 204 });
    }
    m = /^GET \/r2\/buckets\/([^/]+)\/objects$/.exec(key);
    if (m?.[1]) {
      const objects = world.r2.get(m[1]);
      if (objects === undefined) return gone();
      const perPage = Number(url.searchParams.get("per_page") ?? 1000);
      if (world.endless) {
        const n = world.calls.length;
        return ok(
          Array.from({ length: perPage }, (_, i) => ({ key: `gen-${n}-${i}` })),
          { result_info: { cursor: "more" } },
        );
      }
      const page = objects.slice(0, perPage);
      return ok(
        page.map((k) => ({ key: k, size: 1 })),
        objects.length > perPage ? { result_info: { cursor: "more", per_page: perPage } } : {},
      );
    }
    m = /^DELETE \/r2\/buckets\/([^/]+)\/objects\/(.+)$/.exec(key);
    if (m?.[1] && m[2]) {
      if (world.endless) return ok(null);
      const objects = world.r2.get(m[1]);
      // Each path segment is encoded on its own; `/` separates them.
      const k = m[2].split("/").map(decodeURIComponent).join("/");
      if (world.stuck.has(k)) return gone();
      if (objects === undefined || !objects.includes(k)) return gone();
      world.r2.set(
        m[1],
        objects.filter((o) => o !== k),
      );
      return ok(null);
    }
    m = /^DELETE \/r2\/buckets\/([^/]+)$/.exec(key);
    if (m?.[1]) {
      const objects = world.r2.get(m[1]);
      if (objects === undefined) return gone();
      if (objects.length > 0) return fail(409, "The bucket you tried to delete is not empty");
      world.r2.delete(m[1]);
      return ok(null);
    }
    return fail(404, `no route ${key}`);
  };
  return { world, fetch };
}

const jobEnv = (): JobEnv => ({ DB: env.DB, CF_API_TOKEN: TOKEN });

/**
 * An installed Cut with one resource of every kind, as the install job records
 * them. `worker: "none"` leaves out the Worker row (an install that failed
 * before its upload); `"pending"` records it without an id (upload response lost).
 */
async function seedInstall(
  status = "installed",
  worker: "recorded" | "pending" | "none" = "recorded",
): Promise<void> {
  const r = (id: string, kind: string, name: string, cfId: string | null, binding: string | null) =>
    env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES (?1, 'i1', ?2, ?3, ?4, ?5, 1)`,
    ).bind(id, kind, binding, name, cfId);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url, status, installed_at, updated_at)
       VALUES ('i1', 'cut', 'cut', 'cut', '1.0.0', 'u', ?1, 1, 1)`,
    ).bind(status),
    env.DB.prepare(
      `INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES ('j0', 'i1', 'install', ?1, '{}')`,
    ).bind(status === "failed" ? "failed" : "succeeded"),
    r("kv", "kv", "cut-cut-kv", "kv-1", "CUT_KV"),
    r("d1", "d1", "cut-db", "d1-1", "DB"),
    r("r2", "r2", "cut-files", "cut-files", "FILES"),
    r("queue", "queue", "cut-events", "q-1", "EVENTS"),
    r("vec", "vectorize", "cut-vectors", "cut-vectors", "VECTORS"),
    r("do", "durable_object", "Counter", null, "COUNTER"),
    ...(worker === "none"
      ? []
      : [r("worker", "worker", "cut", worker === "pending" ? null : "cut", null)]),
    r("wf", "workflow", "cut-jobs", null, "JOBS"),
    r("secret", "secret", "ADMIN_PASSWORD", null, "ADMIN_PASSWORD"),
    r("cron", "cron", "*/5 * * * *", null, null),
    r("sub", "subdomain", "cut.appflare-dev.workers.dev", null, null),
  ]);
}

const ALL_DATA = ["kv", "d1", "r2", "queue", "vec"];

async function start(request: StartUninstallRequest) {
  let params: UninstallJobParams | null = null;
  let n = 0;
  const { jobId } = await startUninstallCore(
    {
      db: env.DB,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      now: () => new Date(NOW),
      newId: () => `u${++n}-${Math.random().toString(36).slice(2, 8)}`,
    },
    request,
  );
  if (params === null) throw new Error("no Workflow params");
  return { jobId, params: params as UninstallJobParams };
}

async function uninstall(
  request: StartUninstallRequest,
  fake: ReturnType<typeof fakeWorld>,
  /** `local`: a manager without the `SELF` binding runs the units in the job's invocation. */
  units: "self" | "local" = "self",
) {
  const { jobId, params } = await start(request);
  return execute(jobId, params, fake, units);
}

/** Starts deleting what install `i1` kept (the removed apps settings), then runs the job. */
async function deleteRetained(
  fake: ReturnType<typeof fakeWorld>,
  units: "self" | "local" = "self",
) {
  let params: UninstallJobParams | null = null;
  const { jobId } = await startDeleteRetainedCore(
    {
      db: env.DB,
      createJob: async (id, p) => {
        params = p;
        return { id };
      },
      now: () => new Date(NOW),
      newId: () => `d-${Math.random().toString(36).slice(2, 8)}`,
    },
    "i1",
  );
  if (params === null) throw new Error("no Workflow params");
  return execute(jobId, params as UninstallJobParams, fake, units);
}

/** Runs a started uninstall job and reads back the job, the install, and its resources. */
async function execute(
  jobId: string,
  params: UninstallJobParams,
  fake: ReturnType<typeof fakeWorld>,
  units: "self" | "local",
) {
  const step = fakeStep();
  const self = fakeSelf(jobEnv(), { fetch: fake.fetch, now: () => NOW });
  let error: unknown = null;
  try {
    await runUninstall({
      params,
      step,
      env: units === "self" ? { ...jobEnv(), SELF: self } : jobEnv(),
      deps: { fetch: fake.fetch, now: () => NOW },
    });
  } catch (e) {
    error = e;
  }
  const job = await env.DB.prepare("SELECT status, error, input_json FROM jobs WHERE id = ?1")
    .bind(jobId)
    .first<{ status: string; error: string | null; input_json: string }>();
  const install = await env.DB.prepare(
    "SELECT status, uninstalled_at FROM installs WHERE id = 'i1'",
  ).first<{ status: string; uninstalled_at: number | null }>();
  const rows = (
    await env.DB.prepare(
      "SELECT id, deleted_at, retained_at FROM resources WHERE install_id = 'i1' ORDER BY rowid",
    ).all<{ id: string; deleted_at: number | null; retained_at: number | null }>()
  ).results;
  const state = (id: string) => {
    const row = rows.find((x) => x.id === id);
    return row?.deleted_at != null ? "deleted" : row?.retained_at != null ? "retained" : "live";
  };
  const logs = (
    await env.DB.prepare(
      "SELECT level, message, data_json FROM job_logs WHERE job_id = ?1 ORDER BY id",
    )
      .bind(jobId)
      .all<{ level: string; message: string; data_json: string | null }>()
  ).results;
  return { jobId, params, step, self, error, job, install, state, logs };
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await writeSettings(createDb(env.DB), { [SETTING.accountId]: ACC });
});

/** Records custom domains of install `i1` (`resources` kind `domain`). */
async function seedDomains(domains: Array<{ id: string; hostname: string; cfId: string | null }>) {
  for (const d of domains) {
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES (?1, 'i1', 'domain', NULL, ?2, ?3, 1)`,
    )
      .bind(d.id, d.hostname, d.cfId)
      .run();
  }
}

describe("uninstall job: Cloudflare Access protection", () => {
  it("removes the app's Access application and its own service token before the Worker", async () => {
    await seedInstall();
    await recordProtectedInstall({
      installId: "i1",
      authSecret: "auth-secret-0123456789abcdef",
      secret: "secret-DO-NOT-LEAK",
    });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:access_service_token:token', 'i1', 'access_service_token', NULL,
         'Appflare health checks i1', 'tok-i1', 1)`,
    ).run();
    const fake = fakeWorld();
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);

    expect(r.error).toBeNull();
    expect(r.install?.status).toBe("uninstalled");
    const names = r.step.names;
    expect(names.indexOf("remove Cloudflare Access protection")).toBe(
      names.indexOf("delete Worker cut") + 1,
    );
    const calls = fake.world.calls;
    const worker = calls.indexOf("DELETE /workers/scripts/cut?force=true");
    expect(calls.indexOf("DELETE /access/apps/app-i1")).toBeGreaterThan(worker);
    expect(calls.indexOf("DELETE /access/apps/app-i1")).toBeLessThan(
      calls.indexOf("DELETE /access/service_tokens/tok-i1"),
    );
    expect(r.state("i1:access_service_token:token")).toBe("deleted");
    expect((await env.DB.prepare("SELECT * FROM install_access").all()).results).toEqual([]);
    expect(JSON.stringify(r.logs)).not.toContain("DO-NOT-LEAK");
  });

  /** A protected Cut with a custom domain and the Access application of its public paths. */
  async function seedProtectedWithPaths() {
    await seedInstall();
    await recordProtectedInstall({
      installId: "i1",
      authSecret: "auth-secret-0123456789abcdef",
      secret: "secret-DO-NOT-LEAK",
    });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:access_app:bypass', 'i1', 'access_app', NULL, 'Appflare: Cut (cut) public paths', 'bypass-i1', 1)`,
    ).run();
    await seedDomains([{ id: "dom-a", hostname: "cut.example.com", cfId: "cfd-a" }]);
  }

  it("removes the public paths before any address is released, the application after the Worker", async () => {
    await seedProtectedWithPaths();
    const fake = fakeWorld();
    fake.world.domains.set("cfd-a", { hostname: "cut.example.com", service: "cut" });
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.error).toBeNull();
    const names = r.step.names;
    expect(names.indexOf("remove public paths from Cloudflare Access")).toBeLessThan(
      names.indexOf("remove custom domain cut.example.com"),
    );
    const calls = fake.world.calls;
    expect(calls.indexOf("DELETE /access/apps/bypass-i1")).toBeLessThan(
      calls.indexOf("DELETE /workers/domains/cfd-a"),
    );
    expect(calls.indexOf("DELETE /access/apps/app-i1")).toBeGreaterThan(
      calls.indexOf("DELETE /workers/scripts/cut?force=true"),
    );
    expect(r.state("i1:access_app:bypass")).toBe("deleted");
  });

  it("fails before anything is deleted when the public paths cannot be removed", async () => {
    await seedProtectedWithPaths();
    const world = fakeWorld();
    // Refused every time it is tried (a step is retried).
    const fake = {
      ...world,
      fetch: async (input: string, init?: RequestInit) => {
        if (init?.method === "DELETE" && String(input).includes("/access/apps/bypass-i1")) {
          world.world.calls.push("DELETE /access/apps/bypass-i1");
          return Response.json(
            { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
            { status: 403 },
          );
        }
        return world.fetch(input, init);
      },
    };
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^remove public paths from Cloudflare Access: /);
    expect(fake.world.calls).not.toContain("DELETE /workers/domains/cfd-a");
    expect(fake.world.calls).not.toContain("DELETE /workers/scripts/cut?force=true");
    expect(r.state("dom-a")).toBe("live");
  });

  it("marks the recorded Access application deleted with the token", async () => {
    await seedInstall();
    await recordProtectedInstall({
      installId: "i1",
      authSecret: "auth-secret-0123456789abcdef",
      secret: "secret-DO-NOT-LEAK",
    });
    // As protecting the app records it: the application is a resource of its own.
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:access_app:app', 'i1', 'access_app', NULL, 'Appflare: Cut (cut)', 'app-i1', 1)`,
    ).run();
    const fake = fakeWorld();
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);

    expect(r.error).toBeNull();
    expect(r.step.names).toContain("remove Cloudflare Access protection");
    expect(fake.world.calls).toContain("DELETE /access/apps/app-i1");
    expect(r.state("i1:access_app:app")).toBe("deleted");
    expect((await env.DB.prepare("SELECT * FROM install_access").all()).results).toEqual([]);
  });

  it("only warns when the protection cannot be removed: the app is already gone", async () => {
    await seedInstall();
    await recordProtectedInstall({
      installId: "i1",
      authSecret: "auth-secret-0123456789abcdef",
      secret: "secret-DO-NOT-LEAK",
    });
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:access_service_token:token', 'i1', 'access_service_token', NULL,
         'Appflare health checks i1', 'tok-i1', 1)`,
    ).run();
    const fake = fakeWorld();
    // A policy made in the dashboard still names the token.
    fake.world.failOnce.set("DELETE /access/service_tokens/tok-i1", 400);
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);

    expect(r.error).toBeNull();
    expect(r.install?.status).toBe("uninstalled");
    expect(fake.world.calls).toContain("DELETE /workers/scripts/cut?force=true");
    const warning = r.logs.find((l) =>
      l.message.includes("Could not remove the app's Cloudflare Access"),
    );
    expect(warning?.level).toBe("warn");
    expect(warning?.message).toContain('"Appflare health checks i1" service token');
    // What is left stays recorded, so it can still be found.
    expect(r.state("i1:access_service_token:token")).toBe("live");
  });
});

describe("uninstall job: wildcard domains", () => {
  async function seedWildcard() {
    const r = (id: string, kind: string, binding: string | null, name: string, cfId: string) =>
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES (?1, 'i1', ?2, ?3, ?4, ?5, 1)`,
      ).bind(id, kind, binding, name, cfId);
    const base = "tunnels.example.com";
    await env.DB.batch([
      r("wc", "wildcard_domain", null, base, "z1"),
      r("wc-rec-1", "dns_record", base, base, "z1/rec-1"),
      r("wc-rec-2", "dns_record", base, `*.${base}`, "z1/rec-2"),
      r("wc-route-1", "worker_route", base, `${base}/*`, "z1/route-1"),
      r("wc-route-2", "worker_route", base, `*.${base}/*`, "z1/route-2"),
    ]);
  }

  it("removes the routes, then the records, before the Worker", async () => {
    await seedInstall();
    await seedWildcard();
    const fake = fakeWorld({
      zoneObjects: new Set([
        "z1/dns_records/rec-1",
        "z1/dns_records/rec-2",
        "z1/routes/route-1",
        "z1/routes/route-2",
      ]),
    });
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);

    expect(r.error).toBeNull();
    expect(r.install?.status).toBe("uninstalled");
    expect(r.step.names.slice(0, 3)).toEqual([
      "start",
      "remove wildcard domain tunnels.example.com",
      "delete Worker cut",
    ]);
    const calls = fake.world.calls.filter((c) => c.startsWith("DELETE /client/v4/zones/"));
    expect(calls).toEqual([
      "DELETE /client/v4/zones/z1/workers/routes/route-1",
      "DELETE /client/v4/zones/z1/workers/routes/route-2",
      "DELETE /client/v4/zones/z1/dns_records/rec-1",
      "DELETE /client/v4/zones/z1/dns_records/rec-2",
    ]);
    expect(fake.world.calls.indexOf(calls[3] ?? "")).toBeLessThan(
      fake.world.calls.indexOf("DELETE /workers/scripts/cut?force=true"),
    );
    expect(fake.world.zoneObjects.size).toBe(0);
    for (const id of ["wc", "wc-rec-1", "wc-rec-2", "wc-route-1", "wc-route-2"]) {
      expect(r.state(id), id).toBe("deleted");
    }
    expect(r.logs[0]?.message).toContain("Removing wildcard domains: *.tunnels.example.com.");
  });

  it("counts records and routes that are already gone as removed", async () => {
    await seedInstall();
    await seedWildcard();
    const r = await uninstall({ installId: "i1", deleteResources: ALL_DATA }, fakeWorld());

    expect(r.job?.status).toBe("succeeded");
    expect(r.state("wc")).toBe("deleted");
    expect(r.logs.map((l) => l.message)).toContain(
      "Removed wildcard domain *.tunnels.example.com; already gone: tunnels.example.com/*, *.tunnels.example.com/*, tunnels.example.com, *.tunnels.example.com.",
    );
  });
});

describe("uninstall job: custom domains", () => {
  it("removes every custom domain before the Worker, even when the admin keeps all data", async () => {
    await seedInstall();
    await seedDomains([
      { id: "dom-a", hostname: "cut.example.com", cfId: "cfd-a" },
      // No id recorded: found by hostname, and only if it still serves this Worker.
      { id: "dom-b", hostname: "www.example.com", cfId: null },
    ]);
    const fake = fakeWorld({
      domains: new Map([
        ["cfd-a", { hostname: "cut.example.com", service: "cut" }],
        ["cfd-b", { hostname: "www.example.com", service: "cut" }],
        ["cfd-other", { hostname: "blog.example.com", service: "blog" }],
      ]),
    });
    // Ticking a domain changes nothing: it is not a data resource.
    const r = await uninstall({ installId: "i1", deleteResources: ["dom-a"] }, fake);

    expect(r.error).toBeNull();
    expect(r.params.deleteResources).toEqual([]);
    expect(r.install?.status).toBe("uninstalled");
    expect(r.step.names.slice(0, 4)).toEqual([
      "start",
      "remove custom domain cut.example.com",
      "remove custom domain www.example.com",
      "delete Worker cut",
    ]);
    const calls = fake.world.calls;
    const worker = calls.indexOf("DELETE /workers/scripts/cut?force=true");
    expect(calls.indexOf("DELETE /workers/domains/cfd-a")).toBeLessThan(worker);
    expect(calls.indexOf("DELETE /workers/domains/cfd-b")).toBeLessThan(worker);
    expect([...fake.world.domains.keys()]).toEqual(["cfd-other"]);
    expect(r.state("dom-a")).toBe("deleted");
    expect(r.state("dom-b")).toBe("deleted");
    for (const id of ALL_DATA) expect(r.state(id)).toBe("retained");
    expect(r.logs[0]?.message).toContain(
      "Removing custom domains: cut.example.com, www.example.com.",
    );
  });

  it("leaves a hostname alone when no id is recorded and it now serves another Worker", async () => {
    await seedInstall();
    await seedDomains([{ id: "dom-b", hostname: "www.example.com", cfId: null }]);
    const fake = fakeWorld({
      domains: new Map([["cfd-blog", { hostname: "www.example.com", service: "blog" }]]),
    });
    const r = await uninstall({ installId: "i1", deleteResources: ALL_DATA }, fake);

    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(fake.world.domains.has("cfd-blog")).toBe(true);
    expect(fake.world.calls.some((c) => c.startsWith("DELETE /workers/domains/"))).toBe(false);
    // No longer this install's: recorded as gone from it.
    expect(r.state("dom-b")).toBe("deleted");
    expect(r.logs.map((l) => l.message)).toContain(
      "Custom domain www.example.com now serves another Worker, so it was left alone.",
    );
  });

  it("counts a custom domain that is already gone as removed", async () => {
    await seedInstall();
    await seedDomains([
      { id: "dom-a", hostname: "cut.example.com", cfId: "cfd-a" },
      { id: "dom-b", hostname: "www.example.com", cfId: null },
    ]);
    const fake = fakeWorld();
    const r = await uninstall({ installId: "i1", deleteResources: ALL_DATA }, fake);

    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.state("dom-a")).toBe("deleted");
    expect(r.state("dom-b")).toBe("deleted");
    const messages = r.logs.map((l) => l.message);
    expect(messages).toContain("Custom domain cut.example.com was already gone.");
    expect(messages).toContain("Custom domain www.example.com was already gone.");
  });

  it("stops before the Worker when the token cannot remove a domain, and a retry finishes", async () => {
    await seedInstall();
    await seedDomains([{ id: "dom-a", hostname: "cut.example.com", cfId: "cfd-a" }]);
    const fake = fakeWorld({
      domains: new Map([["cfd-a", { hostname: "cut.example.com", service: "cut" }]]),
      failOnce: new Map([["DELETE /workers/domains/cfd-a", 403]]),
    });
    const r = await uninstall({ installId: "i1", deleteResources: ALL_DATA }, fake);

    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/^remove custom domain cut\.example\.com: .*Workers Routes: Edit/);
    expect(r.install?.status).toBe("uninstalling");
    expect(fake.world.scripts.has("cut")).toBe(true);
    expect(r.state("dom-a")).toBe("live");

    const retry = await uninstall({ installId: "i1", retry: true }, fake);
    expect(retry.job?.status).toBe("succeeded");
    expect(retry.state("dom-a")).toBe("deleted");
    expect(fake.world.domains.size).toBe(0);
    expect(fake.world.scripts.has("cut")).toBe(false);
  });
});

describe("uninstall job: queue consumers", () => {
  /** Two queues of install `i1`, each with a consumer: one with its id, one without. */
  async function seedConsumers(): Promise<void> {
    const r = (
      id: string,
      kind: string,
      name: string,
      cfId: string | null,
      binding: string | null,
    ) =>
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES (?1, 'i1', ?2, ?3, ?4, ?5, 1)`,
      ).bind(id, kind, binding, name, cfId);
    await env.DB.batch([
      r("i1:queue:JOBS", "queue", "cut-jobs", "q-jobs", "JOBS"),
      r("i1:queue:jobs-dlq", "queue", "cut-jobs-dlq", "q-dlq", null),
      r("i1:queue_consumer:JOBS", "queue_consumer", "cut-jobs", "c-jobs", null),
      r("i1:queue_consumer:jobs-dlq", "queue_consumer", "cut-jobs-dlq", null, null),
    ]);
  }
  const world = () =>
    fakeWorld({
      queues: new Set(["q-1", "q-jobs", "q-dlq"]),
      consumers: new Map([
        ["q-jobs", [{ consumer_id: "c-jobs", script_name: "cut" }]],
        [
          "q-dlq",
          [
            { consumer_id: "c-other", script_name: "someone-else" },
            // The API may name the Worker `service` instead of `script_name`.
            { consumer_id: "c-dlq", service: "cut" },
          ],
        ],
      ]),
    });

  it("removes every consumer before the Worker and before the queues it reads", async () => {
    await seedInstall();
    await seedConsumers();
    const fake = world();
    const r = await uninstall(
      { installId: "i1", deleteResources: [...ALL_DATA, "i1:queue:JOBS", "i1:queue:jobs-dlq"] },
      fake,
    );
    expect(r.error).toBeNull();
    expect(r.install?.status).toBe("uninstalled");
    expect(r.step.names.slice(0, 4)).toEqual([
      "start",
      "remove consumer of queue cut-jobs",
      "remove consumer of queue cut-jobs-dlq",
      "delete Worker cut",
    ]);
    const calls = fake.world.calls;
    const worker = calls.indexOf("DELETE /workers/scripts/cut?force=true");
    expect(calls.indexOf("DELETE /queues/q-jobs/consumers/c-jobs")).toBeLessThan(worker);
    // No id recorded: found by the Worker's name, leaving another Worker's consumer alone.
    expect(calls.indexOf("DELETE /queues/q-dlq/consumers/c-dlq")).toBeLessThan(worker);
    expect(fake.world.consumers.get("q-dlq")).toEqual([
      { consumer_id: "c-other", script_name: "someone-else" },
    ]);
    expect(calls).toContain("DELETE /queues/q-jobs");
    expect(r.state("i1:queue_consumer:JOBS")).toBe("deleted");
    expect(r.state("i1:queue_consumer:jobs-dlq")).toBe("deleted");
    expect(r.state("i1:queue:jobs-dlq")).toBe("deleted");
  });

  it("removes consumers even when the admin keeps their queues, and counts gone ones as removed", async () => {
    await seedInstall();
    await seedConsumers();
    const fake = world();
    fake.world.consumers.set("q-jobs", []);
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.error).toBeNull();
    expect(r.state("i1:queue:JOBS")).toBe("retained");
    expect(r.state("i1:queue_consumer:JOBS")).toBe("deleted");
    expect(r.state("i1:queue_consumer:jobs-dlq")).toBe("deleted");
    expect(r.logs.map((l) => l.message)).toContain(
      'The consumer of the queue "cut-jobs" was already gone.',
    );
  });
});

describe("uninstall job: Hyperdrive configurations", () => {
  async function seedConfigs(): Promise<void> {
    const r = (id: string, kind: string, name: string, cfId: string, binding: string | null) =>
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES (?1, 'i1', ?2, ?3, ?4, ?5, 1)`,
      ).bind(id, kind, binding, name, cfId);
    await env.DB.batch([
      r("i1:hyperdrive:HYPERDRIVE", "hyperdrive", "cut-hyperdrive", "hd-1", "HYPERDRIVE"),
      // Made by a settings change that stopped before it was bound.
      r(
        "i1:hyperdrive:cut-hyperdrive-r01abcdef",
        "hyperdrive",
        "cut-hyperdrive-r01abcdef",
        "hd-2",
        null,
      ),
      // Replaced by a settings change, kept for a rollback to its snapshot.
      r(
        "i1:hyperdrive:cut-hyperdrive-r00000000",
        "hyperdrive_superseded",
        "cut-hyperdrive-r00000000",
        "hd-0",
        "HYPERDRIVE",
      ),
    ]);
  }

  it("deletes every configuration after the Worker, even when the admin keeps all data", async () => {
    await seedInstall();
    await seedConfigs();
    const fake = fakeWorld({ hyperdrive: new Set(["hd-1", "hd-0"]) });
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.error).toBeNull();
    expect(r.install?.status).toBe("uninstalled");
    const calls = fake.world.calls;
    const worker = calls.indexOf("DELETE /workers/scripts/cut?force=true");
    expect(calls.indexOf("DELETE /hyperdrive/configs/hd-1")).toBeGreaterThan(worker);
    expect(fake.world.hyperdrive.size).toBe(0);
    // One already gone counts as deleted.
    expect(r.state("i1:hyperdrive:HYPERDRIVE")).toBe("deleted");
    expect(r.state("i1:hyperdrive:cut-hyperdrive-r01abcdef")).toBe("deleted");
    expect(r.state("i1:hyperdrive:cut-hyperdrive-r00000000")).toBe("deleted");
    expect(calls).toContain("DELETE /hyperdrive/configs/hd-0");
    expect(r.logs.map((l) => l.message)).toContain(
      'Hyperdrive configuration "cut-hyperdrive-r01abcdef" was already gone.',
    );
    // Never offered as data to keep.
    expect(r.state("kv")).toBe("retained");
  });
});

describe("uninstall job: Pipelines", () => {
  /** A stream with its sink, pipeline, own bucket and that bucket's Data Catalog. */
  async function seedPipelines(): Promise<void> {
    const r = (id: string, kind: string, name: string, cfId: string, binding: string | null) =>
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES (?1, 'i1', ?2, ?3, ?4, ?5, 1)`,
      ).bind(id, kind, binding, name, cfId);
    await env.DB.batch([
      r("wh", "r2", "cut-warehouse", "cut-warehouse", null),
      r("cat", "r2_catalog", "cut-warehouse", "cat-1", null),
      r("stream", "pipeline_stream", "cut_events_stream", "s1", "EVENTS"),
      r("sink", "pipeline_sink", "cut_events_sink", "k1", null),
      r("pipe", "pipeline", "cut_events_pipeline", "p1", null),
    ]);
  }
  const world = () =>
    fakeWorld({
      r2: new Map([
        ["cut-files", []],
        ["cut-warehouse", ["__r2_data_catalog/x/data.parquet"]],
      ]),
      pipelines: new Set(["streams/s1", "sinks/k1", "pipelines/p1"]),
      catalogs: new Set(["cut-warehouse"]),
    });

  it("deletes the pipeline, sink and stream after the Worker, then the bucket with its catalog", async () => {
    await seedInstall();
    await seedPipelines();
    const fake = world();
    const r = await uninstall({ installId: "i1", deleteResources: [...ALL_DATA, "wh"] }, fake);
    expect(r.error).toBeNull();
    expect(r.install?.status).toBe("uninstalled");
    const calls = fake.world.calls;
    const at = (call: string) => calls.indexOf(call);
    expect(at("DELETE /pipelines/v1/pipelines/p1")).toBeGreaterThan(
      at("DELETE /workers/scripts/cut?force=true"),
    );
    expect(at("DELETE /pipelines/v1/pipelines/p1")).toBeLessThan(
      at("DELETE /pipelines/v1/sinks/k1"),
    );
    expect(at("DELETE /pipelines/v1/sinks/k1")).toBeLessThan(at("DELETE /pipelines/v1/streams/s1"));
    // The catalog goes before the bucket is emptied.
    expect(at("POST /r2-catalog/cut-warehouse/delete?force=true")).toBeGreaterThan(
      at("DELETE /pipelines/v1/streams/s1"),
    );
    expect(at("POST /r2-catalog/cut-warehouse/delete?force=true")).toBeLessThan(
      calls.findIndex((c) => c.startsWith("GET /r2/buckets/cut-warehouse/objects")),
    );
    expect(fake.world.pipelines.size).toBe(0);
    expect(fake.world.catalogs.size).toBe(0);
    expect(fake.world.r2.has("cut-warehouse")).toBe(false);
    for (const id of ["stream", "sink", "pipe", "cat", "wh"]) expect(r.state(id)).toBe("deleted");
  });

  it("keeps a kept bucket's catalog with it, listed as kept, and deletes both later", async () => {
    await seedInstall();
    await seedPipelines();
    const fake = world();
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.error).toBeNull();
    // Streams, sinks and pipelines are never kept.
    for (const id of ["stream", "sink", "pipe"]) expect(r.state(id)).toBe("deleted");
    expect(r.state("wh")).toBe("retained");
    expect(r.state("cat")).toBe("retained");
    expect(fake.world.calls.some((c) => c.startsWith("POST /r2-catalog/"))).toBe(false);

    const later = await deleteRetained(fake);
    expect(later.error).toBeNull();
    expect(later.state("wh")).toBe("deleted");
    expect(later.state("cat")).toBe("deleted");
    expect(fake.world.catalogs.size).toBe(0);
  });

  it("deletes the bucket anyway, with a warning, when the token cannot remove its catalog", async () => {
    await seedInstall();
    await seedPipelines();
    const fake = world();
    fake.world.catalogRefused = true;
    const r = await uninstall({ installId: "i1", deleteResources: [...ALL_DATA, "wh"] }, fake);
    expect(r.error).toBeNull();
    expect(r.state("wh")).toBe("deleted");
    expect(r.state("cat")).toBe("deleted");
    expect(r.logs).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringMatching(
          /^Cloudflare refused to remove the R2 Data Catalog of "cut-warehouse" \(Forbidden\); the bucket is deleted anyway/,
        ),
      }),
    );
  });

  it("counts a pipeline object that is already gone as deleted", async () => {
    await seedInstall();
    await seedPipelines();
    const fake = world();
    fake.world.pipelines.delete("sinks/k1");
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.error).toBeNull();
    expect(r.state("sink")).toBe("deleted");
    expect(r.logs.map((l) => l.message)).toContain(
      'The Pipelines sink "cut_events_sink" was already gone.',
    );
  });
});

describe("uninstall job", () => {
  it("deletes the Worker and every ticked resource, emptying the R2 bucket in pages", async () => {
    await seedInstall();
    const objects = Array.from({ length: 45 }, (_, i) => `photos/${i} a.jpg`);
    const fake = fakeWorld({ r2: new Map([["cut-files", objects]]) });
    const r = await uninstall({ installId: "i1", deleteResources: ALL_DATA }, fake);

    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.job?.error).toBeNull();
    expect(r.install).toEqual({ status: "uninstalled", uninstalled_at: NOW });
    for (const id of [...ALL_DATA, "do", "worker", "wf", "secret", "cron", "sub"]) {
      expect(r.state(id)).toBe("deleted");
    }
    expect(r.step.names).toEqual([
      "start",
      "delete Worker cut",
      // Deleting a Worker leaves its Workflows, so each goes by name right after it.
      "delete Workflow cut-jobs",
      "delete KV namespace cut-cut-kv",
      "delete D1 database cut-db",
      "empty R2 bucket cut-files page 1",
      "empty R2 bucket cut-files page 2",
      "delete R2 bucket cut-files",
      "delete queue cut-events",
      "delete Vectorize index cut-vectors",
      "finish",
    ]);
    expect(r.step.configs.every((c) => c === API_STEP)).toBe(true);
    // Each page of object deletions is one unit call over SELF, in its own invocation.
    expect(r.step.sleeps).toEqual([]);
    expect(r.self.calls.map((c) => c.unit)).toEqual(["emptyR2Page", "emptyR2Page"]);
    for (const call of r.self.calls) {
      expect(call.subrequests).toBeLessThan(40);
      expect(call.reported).toBe(call.subrequests);
    }
    expect(fake.world.calls).toContain(`DELETE /workers/scripts/cut?force=true`);
    expect(fake.world.calls).toContain(
      `GET /r2/buckets/cut-files/objects?per_page=${R2_OBJECTS_PER_STEP}`,
    );
    // A nested key with a space: segments encoded, `/` kept.
    expect(fake.world.calls).toContain("DELETE /r2/buckets/cut-files/objects/photos/0%20a.jpg");
    expect(fake.world.scripts).toEqual(new Set(["appflare"]));
    expect(fake.world.workflows.size).toBe(0);
    expect(fake.world.kv.size + fake.world.d1.size + fake.world.queues.size).toBe(0);
    expect(fake.world.r2.size).toBe(0);
    expect(fake.world.vectorize.size).toBe(0);
    expect(JSON.stringify(r.logs)).not.toContain(TOKEN);
    expect(r.logs.at(-1)?.message).toBe('Uninstalled "cut".');
  });

  it("counts a Workflow that is already gone as deleted, and leaves one an app's installer created", async () => {
    await seedInstall();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, managed_by, created_at)
       VALUES ('wf-app', 'i1', 'workflow', NULL, 'cut-app-flow', NULL, 'app', 1)`,
    ).run();
    const fake = fakeWorld({ workflows: new Set(["cut-app-flow"]) });
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);

    expect(r.error).toBeNull();
    expect(r.state("wf")).toBe("deleted");
    expect(r.state("wf-app")).toBe("live");
    expect(fake.world.calls).toContain("DELETE /workflows/cut-jobs");
    expect(fake.world.calls).not.toContain("DELETE /workflows/cut-app-flow");
    expect(fake.world.workflows).toEqual(new Set(["cut-app-flow"]));
    expect(r.logs.map((l) => l.message)).toContain('Workflow "cut-jobs" was already gone.');
  });

  it("keeps unticked resources, marked retained, without touching them", async () => {
    await seedInstall();
    const fake = fakeWorld({ r2: new Map([["cut-files", ["keep.txt"]]]) });
    const r = await uninstall({ installId: "i1", deleteResources: ["d1", "worker"] }, fake);

    expect(r.error).toBeNull();
    expect(r.params.deleteResources).toEqual(["d1"]);
    expect(r.install?.status).toBe("uninstalled");
    expect(r.state("d1")).toBe("deleted");
    expect(r.state("worker")).toBe("deleted");
    for (const id of ["kv", "r2", "queue", "vec"]) expect(r.state(id)).toBe("retained");
    expect(fake.world.kv).toEqual(new Set(["kv-1"]));
    expect(fake.world.r2.get("cut-files")).toEqual(["keep.txt"]);
    expect(fake.world.calls.some((c) => c.includes("/r2/") || c.includes("/kv/"))).toBe(false);
    expect(r.logs.at(-1)?.message).toBe(
      'Uninstalled "cut". Kept in the account: cut-cut-kv, cut-files, cut-events, cut-vectors.',
    );
  });

  it("counts a Worker or resource that is already gone as deleted", async () => {
    await seedInstall();
    const fake = fakeWorld({ scripts: new Set(["appflare"]), kv: new Set(), r2: new Map() });
    const r = await uninstall({ installId: "i1", deleteResources: ALL_DATA }, fake);

    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names).toContain("empty R2 bucket cut-files page 1");
    expect(r.step.names).not.toContain("empty R2 bucket cut-files page 2");
    for (const id of [...ALL_DATA, "worker"]) expect(r.state(id)).toBe("deleted");
    const messages = r.logs.map((l) => l.message);
    expect(messages).toContain('Worker "cut" was already gone.');
    expect(messages).toContain('KV namespace "cut-cut-kv" was already gone.');
  });

  it("never deletes a Worker the install did not record, even when one of that name exists", async () => {
    // The install failed before its upload, for example because the account
    // already had its own Worker named "cut".
    await seedInstall("failed", "none");
    const fake = fakeWorld({ scripts: new Set(["appflare", "cut"]) });
    const r = await uninstall({ installId: "i1", deleteResources: ALL_DATA }, fake);
    expect(r.error).toBeNull();
    expect(r.install?.status).toBe("uninstalled");
    expect(r.step.names[1]).toBe("skip Worker cut");
    expect(fake.world.calls.some((c) => c.startsWith("DELETE /workers/scripts"))).toBe(false);
    expect(fake.world.scripts).toEqual(new Set(["appflare", "cut"]));
    expect(r.state("do")).toBe("deleted");
    expect(r.logs.map((l) => l.message)).toContain(
      'No Worker is recorded for this install; skipping. A Worker named "cut" in the account is not this install\'s and stays untouched.',
    );
  });

  it("deletes a Worker recorded before its upload even when the version was never recorded", async () => {
    await seedInstall("failed", "pending");
    const fake = fakeWorld();
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.error).toBeNull();
    expect(r.step.names[1]).toBe("delete Worker cut");
    expect(fake.world.calls).toContain("DELETE /workers/scripts/cut?force=true");
    expect(fake.world.scripts).toEqual(new Set(["appflare"]));
  });

  it("skips a data resource with no recorded id, marking it deleted with a warning", async () => {
    await seedInstall();
    await env.DB.prepare("UPDATE resources SET cf_id = NULL WHERE id = 'kv'").run();
    const fake = fakeWorld();
    const r = await uninstall({ installId: "i1", deleteResources: ["kv"] }, fake);
    expect(r.error).toBeNull();
    expect(r.state("kv")).toBe("deleted");
    expect(fake.world.calls.some((c) => c.includes("/storage/kv/"))).toBe(false);
    expect(fake.world.kv).toEqual(new Set(["kv-1"]));
    expect(r.logs.find((l) => l.message.startsWith("No Cloudflare id"))?.level).toBe("warn");
  });

  it("stops when a deleted object is still listed instead of looping", async () => {
    await seedInstall();
    const fake = fakeWorld({
      r2: new Map([["cut-files", ["a", ...Array.from({ length: 40 }, (_, i) => `b${i}`)]]]),
      stuck: new Set(["a"]),
    });
    const r = await uninstall({ installId: "i1", deleteResources: ["r2"] }, fake);
    expect(r.job?.error).toBe(
      'empty R2 bucket cut-files page 2: the object "a" is still listed after it was deleted; retry the uninstall in a minute',
    );
    expect(r.install?.status).toBe("uninstalling");
    expect(r.state("r2")).toBe("live");
  });

  it("stops after a run's page cap and continues on retry", async () => {
    await seedInstall();
    const fake = fakeWorld({ endless: true });
    const r = await uninstall({ installId: "i1", deleteResources: ["r2"] }, fake);
    expect(r.step.names.filter((n) => n.startsWith("empty R2 bucket"))).toHaveLength(
      R2_MAX_PAGES_PER_RUN,
    );
    expect(r.job?.error).toBe(
      `empty R2 bucket cut-files: one run deletes at most ${R2_MAX_PAGES_PER_RUN * R2_OBJECTS_PER_STEP} R2 objects (${R2_MAX_PAGES_PER_RUN} page(s) of ${R2_OBJECTS_PER_STEP}); this run deleted ${R2_MAX_PAGES_PER_RUN * R2_OBJECTS_PER_STEP}, and cut-files still holds more. Retry the uninstall to continue`,
    );
    expect(r.install?.status).toBe("uninstalling");
    // A full page is one list call and one delete per object: under 40 per unit call.
    expect(new Set(r.self.calls.map((c) => c.subrequests))).toEqual(
      new Set([1 + R2_OBJECTS_PER_STEP]),
    );
    expect(1 + R2_OBJECTS_PER_STEP).toBeLessThan(40);
  });

  it("deletes one page of 30 per run when the Worker has no SELF binding", async () => {
    await seedInstall();
    const fake = fakeWorld({ endless: true });
    const r = await uninstall({ installId: "i1", deleteResources: ["r2"] }, fake, "local");
    expect(r.self.calls).toEqual([]);
    expect(R2_MAX_LOCAL_PAGES_PER_RUN).toBe(1);
    expect(r.step.names.filter((n) => n.startsWith("empty R2 bucket"))).toEqual([
      "empty R2 bucket cut-files page 1",
    ]);
    // What a page cost before job units: one list and 30 deletes in the job's invocation.
    expect(fake.world.calls).toContain(
      `GET /r2/buckets/cut-files/objects?per_page=${R2_OBJECTS_PER_LOCAL_STEP}`,
    );
    expect(
      fake.world.calls.filter((c) => c.startsWith("DELETE /r2/buckets/cut-files/objects/")),
    ).toHaveLength(R2_OBJECTS_PER_LOCAL_STEP);
    expect(r.job?.error).toBe(
      `empty R2 bucket cut-files: one run deletes at most ${R2_OBJECTS_PER_LOCAL_STEP} R2 objects (1 page(s) of ${R2_OBJECTS_PER_LOCAL_STEP}); this run deleted ${R2_OBJECTS_PER_LOCAL_STEP}, and cut-files still holds more. Retry the uninstall to continue`,
    );
  });

  it("names a bucket it has not reached as not emptied yet when the cap stops the run", async () => {
    await seedInstall();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('r2b', 'i1', 'r2', 'MORE', 'cut-more', 'cut-more', 1)`,
    ).run();
    const fake = fakeWorld({
      r2: new Map([
        ["cut-files", ["a.txt"]],
        ["cut-more", ["b.txt"]],
      ]),
    });
    const r = await uninstall({ installId: "i1", deleteResources: ["r2", "r2b"] }, fake, "local");
    expect(r.step.names.filter((n) => n.startsWith("empty R2 bucket"))).toEqual([
      "empty R2 bucket cut-files page 1",
    ]);
    expect(r.job?.error).toBe(
      `empty R2 bucket cut-more: one run deletes at most ${R2_OBJECTS_PER_LOCAL_STEP} R2 objects (1 page(s) of ${R2_OBJECTS_PER_LOCAL_STEP}); this run deleted 1, and cut-more is not emptied yet. Retry the uninstall to continue`,
    );
    expect(r.state("r2")).toBe("deleted");
    expect(r.state("r2b")).toBe("live");
  });

  it("refuses an object key it cannot address rather than deleting another one", async () => {
    await seedInstall();
    const fake = fakeWorld({ r2: new Map([["cut-files", ["ok.txt", "a/../b"]]]) });
    const r = await uninstall({ installId: "i1", deleteResources: ["r2"] }, fake);
    expect(r.job?.error).toMatch(
      /^empty R2 bucket cut-files page 1: the object "a\/\.\.\/b" cannot be deleted through the Cloudflare API/,
    );
    expect(fake.world.calls.some((c) => c.includes("/objects/"))).toBe(false);
  });

  it("explains a bucket Cloudflare refuses to delete, and a retry can keep it", async () => {
    await seedInstall();
    const fake = fakeWorld({ failOnce: new Map([["DELETE /r2/buckets/cut-files", 409]]) });
    const first = await uninstall({ installId: "i1", deleteResources: ["kv", "r2"] }, fake);
    expect(first.job?.error).toMatch(
      /^delete R2 bucket cut-files: Cloudflare refused to delete the bucket \(.*409.*\)\. A bucket with incomplete multipart uploads cannot be deleted/,
    );
    expect(first.state("kv")).toBe("deleted");
    const second = await uninstall({ installId: "i1", retry: true, deleteResources: [] }, fake);
    expect(second.error).toBeNull();
    expect(second.install?.status).toBe("uninstalled");
    expect(second.state("r2")).toBe("retained");
    expect(second.step.names).toEqual(["start", "skip Worker cut", "finish"]);
    expect(second.logs.map((l) => l.message)).toContain(
      'Worker "cut" was deleted by an earlier run.',
    );
  });

  it("retries a 5xx inside the step and fails on a 4xx, then a retry deletes only what is left", async () => {
    await seedInstall();
    const fake = fakeWorld({
      failOnce: new Map([
        ["DELETE /storage/kv/namespaces/kv-1", 503],
        ["DELETE /d1/database/d1-1", 403],
      ]),
    });
    const first = await uninstall({ installId: "i1", deleteResources: ["kv", "d1", "r2"] }, fake);

    expect(first.error).toBeInstanceOf(Error);
    expect(first.step.retried["delete KV namespace cut-cut-kv"]).toBe(2);
    expect(first.job?.status).toBe("failed");
    expect(first.job?.error).toMatch(
      /^delete D1 database cut-db: Cloudflare API request failed: DELETE /,
    );
    expect(first.install).toEqual({ status: "uninstalling", uninstalled_at: null });
    expect(first.state("worker")).toBe("deleted");
    expect(first.state("kv")).toBe("deleted");
    expect(first.state("d1")).toBe("live");
    expect(first.state("r2")).toBe("live");
    expect(first.state("queue")).toBe("retained");
    expect(first.step.names.at(-1)).toBe("mark uninstall failed");
    expect(first.logs.at(-1)?.message).toMatch(/^Uninstall failed at "delete D1 database cut-db"/);

    // Starting over is refused; retrying picks up exactly what is left.
    await expect(start({ installId: "i1", deleteResources: ["d1"] })).rejects.toThrow(
      /already started\. Retry it instead/,
    );
    const second = await uninstall({ installId: "i1", retry: true }, fake);
    expect(second.params.deleteResources).toEqual(["d1", "r2"]);
    expect(second.error).toBeNull();
    expect(second.step.names).toEqual([
      "start",
      "skip Worker cut",
      "delete D1 database cut-db",
      "empty R2 bucket cut-files page 1",
      "delete R2 bucket cut-files",
      "finish",
    ]);
    expect(second.install?.status).toBe("uninstalled");
    expect(second.state("d1")).toBe("deleted");
    expect(second.state("r2")).toBe("deleted");
    for (const id of ["queue", "vec"]) expect(second.state(id)).toBe("retained");
    expect(fake.world.queues).toEqual(new Set(["q-1"]));
  });

  it("fails before touching Cloudflare when no API token is configured", async () => {
    await seedInstall();
    const fake = fakeWorld();
    const { params, jobId } = await start({ installId: "i1", deleteResources: ALL_DATA });
    await expect(
      runUninstall({ params, step: fakeStep(), env: { DB: env.DB }, deps: { fetch: fake.fetch } }),
    ).rejects.toThrow(/token is not configured/);
    const job = await env.DB.prepare("SELECT error FROM jobs WHERE id = ?1").bind(jobId).first();
    expect(job?.error).toBe(
      "start: the Cloudflare API token is not configured; finish setup first",
    );
    expect(fake.world.calls).toEqual([]);
  });
});

describe("startUninstallCore", () => {
  it("records the job and the ticked ids, and marks the install uninstalling", async () => {
    await seedInstall();
    const { jobId, params } = await start({
      installId: "i1",
      deleteResources: ["kv", "kv", "secret"],
    });
    expect(params).toEqual({ kind: "uninstall", jobId, installId: "i1", deleteResources: ["kv"] });
    const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?1").bind(jobId).first();
    expect(job).toMatchObject({
      install_id: "i1",
      kind: "uninstall",
      status: "queued",
      workflow_instance_id: jobId,
    });
    expect(JSON.parse(String(job?.input_json))).toEqual({
      installId: "i1",
      deleteResources: ["kv"],
      retry: false,
    });
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first();
    expect(install).toEqual({ status: "uninstalling" });
    const retained = await env.DB.prepare(
      "SELECT id FROM resources WHERE retained_at IS NOT NULL ORDER BY rowid",
    ).all<{ id: string }>();
    expect(retained.results.map((x) => x.id)).toEqual(["d1", "r2", "queue", "vec"]);
  });

  it("refuses ids that are not live resources of the install", async () => {
    await seedInstall();
    await env.DB.prepare("UPDATE resources SET deleted_at = 1 WHERE id = 'd1'").run();
    await expect(
      start({ installId: "i1", deleteResources: ["kv", "d1", "other"] }),
    ).rejects.toThrow("Not a resource of this install that still exists: d1, other.");
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first();
    expect(install).toEqual({ status: "installed" });
  });

  it("refuses installs that are busy, uninstalled, or missing, and a retry that has nothing to retry", async () => {
    await expect(start({ installId: "nope", deleteResources: [] })).rejects.toThrow(
      "There is no such install.",
    );
    await seedInstall();
    await expect(start({ installId: "i1", retry: true })).rejects.toThrow(
      "Only an unfinished uninstall can be retried.",
    );
    for (const [status, message] of [
      ["installing", /A job of this install is running/],
      ["updating", /A job of this install is running/],
      ["uninstalled", /already uninstalled/],
    ] as const) {
      await env.DB.prepare("UPDATE installs SET status = ?1 WHERE id = 'i1'").bind(status).run();
      await expect(start({ installId: "i1", deleteResources: [] })).rejects.toThrow(message);
    }
  });

  it("does not start while another job of the install is queued or running", async () => {
    await seedInstall();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('busy', 'i1', 'update', 'running')",
    ).run();
    await expect(start({ installId: "i1", deleteResources: ALL_DATA })).rejects.toBeInstanceOf(
      StartUninstallError,
    );
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first();
    expect(install).toEqual({ status: "installed" });
    const retained = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM resources WHERE retained_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(retained?.n).toBe(0);
  });

  it("keeps the install uninstalling, ready to retry, when the Workflow cannot be created", async () => {
    await seedInstall();
    await expect(
      startUninstallCore(
        {
          db: env.DB,
          createJob: async () => {
            throw new Error("binding unavailable");
          },
          newId: () => "ux",
        },
        { installId: "i1", deleteResources: ALL_DATA },
      ),
    ).rejects.toThrow("start: could not create the job: binding unavailable");
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 'ux'").first();
    expect(job).toEqual({ status: "failed" });
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first();
    expect(install).toEqual({ status: "uninstalling" });
    const { params } = await start({ installId: "i1", retry: true });
    expect(params.deleteResources).toEqual(ALL_DATA);
  });
});

describe("deleting the data an uninstall kept", () => {
  /** Uninstalls `i1` keeping every data resource, then forgets the calls it made. */
  async function uninstallKeepingAll(fake: ReturnType<typeof fakeWorld>) {
    await seedInstall();
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.install?.status).toBe("uninstalled");
    for (const id of ALL_DATA) expect(r.state(id)).toBe("retained");
    fake.world.calls.length = 0;
  }

  it("runs only the data resource steps, over SELF, and leaves the install uninstalled", async () => {
    const objects = Array.from({ length: 45 }, (_, i) => `photos/${i}.jpg`);
    const fake = fakeWorld({ r2: new Map([["cut-files", objects]]) });
    await uninstallKeepingAll(fake);

    const r = await deleteRetained(fake);

    expect(r.error).toBeNull();
    expect(r.params).toMatchObject({ kind: "uninstall", deleteRetained: true });
    expect(r.params.deleteResources).toEqual(ALL_DATA);
    expect(JSON.parse(String(r.job?.input_json))).toEqual({
      installId: "i1",
      deleteResources: ALL_DATA,
      deleteRetained: true,
    });
    expect(r.job?.status).toBe("succeeded");
    expect(r.install).toEqual({ status: "uninstalled", uninstalled_at: NOW });
    for (const id of ALL_DATA) expect(r.state(id)).toBe("deleted");
    expect(r.step.names).toEqual([
      "start",
      "delete KV namespace cut-cut-kv",
      "delete D1 database cut-db",
      "empty R2 bucket cut-files page 1",
      "empty R2 bucket cut-files page 2",
      "delete R2 bucket cut-files",
      "delete queue cut-events",
      "delete Vectorize index cut-vectors",
      "finish",
    ]);
    expect(r.self.calls.map((c) => c.unit)).toEqual(["emptyR2Page", "emptyR2Page"]);
    // The Worker and what went with it are not touched again.
    expect(fake.world.calls.some((c) => c.includes("/workers/"))).toBe(false);
    expect(fake.world.kv.size + fake.world.d1.size + fake.world.queues.size).toBe(0);
    expect(fake.world.r2.size + fake.world.vectorize.size).toBe(0);
    expect(JSON.stringify(r.logs)).not.toContain(TOKEN);
    expect(r.logs.at(-1)?.message).toBe(
      'Deleted everything "cut" kept. Nothing of it is left in the account.',
    );
    // The history stays: the install row and every job.
    const jobs = await env.DB.prepare(
      "SELECT kind, status FROM jobs WHERE install_id = 'i1' ORDER BY rowid",
    ).all();
    expect(jobs.results).toEqual([
      { kind: "install", status: "succeeded" },
      { kind: "uninstall", status: "succeeded" },
      { kind: "uninstall", status: "succeeded" },
    ]);
  });

  it("fails with what to do next, and a second run deletes only what is left", async () => {
    const fake = fakeWorld({
      r2: new Map([["cut-files", ["a.txt"]]]),
      failOnce: new Map([["DELETE /r2/buckets/cut-files", 409]]),
    });
    await uninstallKeepingAll(fake);

    const first = await deleteRetained(fake);
    expect(first.job?.status).toBe("failed");
    expect(first.job?.error).toMatch(
      /^delete R2 bucket cut-files: Cloudflare refused to delete the bucket .*then run Delete retained data again$/,
    );
    expect(first.install?.status).toBe("uninstalled");
    expect(first.state("kv")).toBe("deleted");
    expect(first.state("d1")).toBe("deleted");
    expect(first.state("r2")).toBe("retained");
    expect(first.logs.at(-1)?.message).toMatch(/run Delete retained data again/);

    const second = await deleteRetained(fake);
    expect(second.error).toBeNull();
    expect(second.params.deleteResources).toEqual(["r2", "queue", "vec"]);
    expect(second.step.names).toEqual([
      "start",
      "empty R2 bucket cut-files page 1",
      "delete R2 bucket cut-files",
      "delete queue cut-events",
      "delete Vectorize index cut-vectors",
      "finish",
    ]);
    for (const id of ALL_DATA) expect(second.state(id)).toBe("deleted");
  });

  /** A later install `i2` under the same Worker name, recording a bucket and an index of the same names. */
  async function reinstallUnderSameName(fake: ReturnType<typeof fakeWorld>) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO installs (id, app_slug, worker_name, instance_name, catalog_version, artifact_url, status, installed_at, updated_at)
         VALUES ('i2', 'cut', 'cut', 'cut', '1.1.0', 'u', 'installed', 2, 2)`,
      ),
      env.DB.prepare(
        `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
         VALUES ('i2-r2', 'i2', 'r2', 'FILES', 'cut-files', 'cut-files', 2),
                ('i2-vec', 'i2', 'vectorize', 'VECTORS', 'cut-vectors', 'cut-vectors', 2)`,
      ),
    ]);
    fake.world.r2.set("cut-files", ["new.txt"]);
    fake.world.vectorize.add("cut-vectors");
  }

  it("never touches a bucket or index whose name a later install now records", async () => {
    const fake = fakeWorld({ r2: new Map([["cut-files", ["old.txt"]]]) });
    await uninstallKeepingAll(fake);
    // The admin deletes the kept bucket and index in the dashboard, then
    // installs again under the same Worker name, which creates new ones.
    fake.world.r2.delete("cut-files");
    fake.world.vectorize.delete("cut-vectors");
    await reinstallUnderSameName(fake);

    const r = await deleteRetained(fake);

    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    expect(r.step.names).toEqual([
      "start",
      "delete KV namespace cut-cut-kv",
      "delete D1 database cut-db",
      "delete queue cut-events",
      "finish",
    ]);
    expect(fake.world.calls.some((c) => c.includes("/r2/") || c.includes("/vectorize/"))).toBe(
      false,
    );
    expect(fake.world.r2.get("cut-files")).toEqual(["new.txt"]);
    expect(fake.world.vectorize.has("cut-vectors")).toBe(true);
    // Only this app's rows are recorded as gone; the new install's stay live.
    for (const id of ALL_DATA) expect(r.state(id)).toBe("deleted");
    const theirs = await env.DB.prepare(
      "SELECT id, deleted_at, retained_at FROM resources WHERE install_id = 'i2' ORDER BY rowid",
    ).all();
    expect(theirs.results).toEqual([
      { id: "i2-r2", deleted_at: null, retained_at: null },
      { id: "i2-vec", deleted_at: null, retained_at: null },
    ]);
    const warnings = r.logs.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings).toEqual([
      'R2 bucket "cut-files" is recorded by the install "cut" now, so it belongs to that install; left alone, and no longer listed as kept by this app.',
      'Vectorize index "cut-vectors" is recorded by the install "cut" now, so it belongs to that install; left alone, and no longer listed as kept by this app.',
    ]);
    expect(r.logs.at(-1)?.message).toBe(
      'Deleted everything "cut" kept that no other install uses now.',
    );
  });

  it("refuses to start when all that is left has a name a later install records", async () => {
    const fake = fakeWorld();
    await seedInstall();
    // Keep only the bucket and the index.
    await uninstall({ installId: "i1", deleteResources: ["kv", "d1", "queue"] }, fake);
    await reinstallUnderSameName(fake);
    fake.world.calls.length = 0;

    await expect(
      startDeleteRetainedCore({ db: env.DB, createJob: async (id) => ({ id }) }, "i1"),
    ).rejects.toThrow(
      'Everything this app kept has a name another install uses now: cut-files (now used by "cut"), cut-vectors (now used by "cut"). Appflare never deletes another install\'s data. Forget this app to stop listing it.',
    );
    const jobs = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE install_id = 'i1' AND input_json LIKE '%deleteRetained%'",
    ).first<{ n: number }>();
    expect(jobs?.n).toBe(0);
    expect(fake.world.calls).toEqual([]);
  });

  it("stops at a run's page cap and says how to continue", async () => {
    const fake = fakeWorld({ endless: true });
    await uninstallKeepingAll(fake);
    const r = await deleteRetained(fake, "local");
    expect(r.job?.status).toBe("failed");
    expect(r.job?.error).toMatch(/still holds more\. Run Delete retained data again to continue$/);
    expect(r.install?.status).toBe("uninstalled");
  });

  it("is refused unless the install is uninstalled, kept something, and is idle", async () => {
    const startFor = (installId: string) =>
      startDeleteRetainedCore({ db: env.DB, createJob: async (id) => ({ id }) }, installId);
    await expect(startFor("nope")).rejects.toThrow("There is no such install.");
    await seedInstall();
    await expect(startFor("i1")).rejects.toThrow(/Only an uninstalled app's kept data/);

    await env.DB.prepare("UPDATE installs SET status = 'uninstalled' WHERE id = 'i1'").run();
    await expect(startFor("i1")).rejects.toThrow("Nothing this app kept is left in the account.");

    await env.DB.prepare("UPDATE resources SET retained_at = 1 WHERE id = 'kv'").run();
    await env.DB.prepare(
      "INSERT INTO jobs (id, install_id, kind, status) VALUES ('busy', 'i1', 'uninstall', 'running')",
    ).run();
    await expect(startFor("i1")).rejects.toThrow(
      /Another job of this install is queued or running/,
    );

    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = 'busy'").run();
    await env.DB.prepare(
      "INSERT INTO jobs (id, kind, status) VALUES ('self', 'self_update', 'running')",
    ).run();
    await expect(startFor("i1")).rejects.toThrow(/Appflare is updating itself \(job self\)/);

    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(n?.n).toBe(3);
  });

  it("records the failure when the Workflow cannot be created; the install stays uninstalled", async () => {
    await seedInstall("uninstalled");
    await env.DB.prepare("UPDATE resources SET retained_at = 1 WHERE id = 'd1'").run();
    await expect(
      startDeleteRetainedCore(
        {
          db: env.DB,
          createJob: async () => {
            throw new Error("binding unavailable");
          },
          newId: () => "dx",
        },
        "i1",
      ),
    ).rejects.toThrow("start: could not create the job: binding unavailable");
    const job = await env.DB.prepare("SELECT status FROM jobs WHERE id = 'dx'").first();
    expect(job).toEqual({ status: "failed" });
    const install = await env.DB.prepare("SELECT status FROM installs WHERE id = 'i1'").first();
    expect(install).toEqual({ status: "uninstalled" });
  });
});

describe("uninstall job: external domains", () => {
  /** The uninstall fake, with the gateway's calls answered by the SaaS fake. */
  function withSaas(saas: ReturnType<typeof fakeSaas>) {
    const fake = fakeWorld();
    const fetch = async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      const gatewayCall =
        path.includes("/zones/") || path.includes("/values/") || path.includes("/appflare-gateway");
      return gatewayCall ? saas.fetch(input, init) : fake.fetch(input, init);
    };
    return { world: fake.world, fetch };
  }

  async function gatewayWith(hostnames: string[]) {
    const saas = fakeSaas();
    await setUpGatewayCore(
      { db: env.DB, api: saas.api, sleep: async () => {} },
      {
        zoneId: GATEWAY_ZONE.id,
      },
    );
    for (const hostname of hostnames) {
      await addExternalDomainCore(
        { db: env.DB, api: saas.api },
        { installId: "i1", hostname, validation: "http" },
      );
    }
    return saas;
  }

  it("removes each custom hostname and routing entry, then the gateway's binding, before the Worker", async () => {
    await seedInstall();
    const saas = await gatewayWith(["a.customer.test", "b.customer.test"]);
    const kvId = (await readGateway(createDb(env.DB)))?.kvId ?? "";
    expect(Object.keys(saas.world.values[kvId] ?? {})).toHaveLength(2);

    const r = await uninstall({ installId: "i1", deleteResources: [] }, withSaas(saas));

    expect(r.error).toBeNull();
    expect(r.step.names.slice(0, 5)).toEqual([
      "start",
      "remove external domain a.customer.test",
      "remove external domain b.customer.test",
      "remove gateway binding APP_I1",
      "delete Worker cut",
    ]);
    expect(saas.world.hostnames).toEqual([]);
    expect(saas.world.values[kvId]).toEqual({});
    expect(saas.world.patches.at(-1)).toEqual({ name: "appflare-gateway", env: { APP_I1: null } });
    expect(r.logs[0]?.message).toContain(
      "Removing external domains: a.customer.test, b.customer.test.",
    );
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM resources WHERE install_id = 'i1' AND kind = 'custom_hostname' AND deleted_at IS NULL",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("still removes the binding on a retry after the domains were removed", async () => {
    await seedInstall();
    const saas = await gatewayWith(["a.customer.test"]);
    // A run that removed the domain and then failed.
    saas.world.hostnames = [];
    await env.DB.prepare(
      "UPDATE resources SET deleted_at = 1 WHERE install_id = 'i1' AND kind = 'custom_hostname'",
    ).run();
    const r = await uninstall({ installId: "i1", deleteResources: [] }, withSaas(saas));
    expect(r.error).toBeNull();
    expect(r.step.names).toContain("remove gateway binding APP_I1");
    expect(saas.world.scripts["appflare-gateway"]?.some((b) => b.name === "APP_I1")).toBe(false);
  });
});

describe("uninstall job, an app of several Workers", () => {
  it("deletes every other Worker of the app before the primary one", async () => {
    await seedInstall();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:worker:cut-jobs', 'i1', 'worker', NULL, 'cut-jobs', 'cut-jobs', 1),
              ('i1:subdomain:cut-jobs', 'i1', 'subdomain', NULL, 'cut-jobs.appflare-dev.workers.dev', NULL, 1)`,
    ).run();
    const fake = fakeWorld({ scripts: new Set(["appflare", "cut", "cut-jobs"]) });
    const r = await uninstall({ installId: "i1", deleteResources: ALL_DATA }, fake);
    expect(r.error).toBeNull();
    expect(r.job?.status).toBe("succeeded");
    const calls = fake.world.calls;
    expect(calls.indexOf("DELETE /workers/scripts/cut-jobs?force=true")).toBeGreaterThan(-1);
    expect(calls.indexOf("DELETE /workers/scripts/cut-jobs?force=true")).toBeLessThan(
      calls.indexOf("DELETE /workers/scripts/cut?force=true"),
    );
    expect(fake.world.scripts).toEqual(new Set(["appflare"]));
    expect(r.state("i1:worker:cut-jobs")).toBe("deleted");
    expect(r.state("i1:subdomain:cut-jobs")).toBe("deleted");
    expect(r.step.names.slice(0, 3)).toEqual([
      "start",
      "delete Worker cut-jobs",
      "delete Worker cut",
    ]);
  });

  it("counts another Worker that is already gone as deleted", async () => {
    await seedInstall();
    await env.DB.prepare(
      `INSERT INTO resources (id, install_id, kind, binding, name, cf_id, created_at)
       VALUES ('i1:worker:cut-jobs', 'i1', 'worker', NULL, 'cut-jobs', 'cut-jobs', 1)`,
    ).run();
    const fake = fakeWorld();
    const r = await uninstall({ installId: "i1", deleteResources: [] }, fake);
    expect(r.error).toBeNull();
    expect(r.state("i1:worker:cut-jobs")).toBe("deleted");
    expect(r.logs.some((l) => l.message === 'Worker "cut-jobs" was already gone.')).toBe(true);
  });
});
