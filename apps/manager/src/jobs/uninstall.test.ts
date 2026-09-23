import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { SETTING, writeSettings } from "../db/settings";
import {
  StartUninstallError,
  type StartUninstallRequest,
  startUninstallCore,
} from "../installs/start-uninstall.server";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
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
  calls: string[];
  /** `METHOD /path` keys answered once with this status instead of doing the work. */
  failOnce: Map<string, number>;
  /** Object keys whose delete answers 404 while they stay listed. */
  stuck: Set<string>;
  /** When set, the bucket listing never runs dry: every page holds fresh keys. */
  endless?: boolean;
}

function fakeWorld(over: Partial<World> = {}) {
  const world: World = {
    scripts: new Set(["appflare", "cut"]),
    kv: new Set(["kv-1"]),
    d1: new Set(["d1-1"]),
    r2: new Map([["cut-files", []]]),
    queues: new Set(["q-1"]),
    vectorize: new Set(["cut-vectors"]),
    calls: [],
    failOnce: new Map(),
    stuck: new Set(),
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
    let m = /^DELETE \/workers\/scripts\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.scripts.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/storage\/kv\/namespaces\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.kv.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/d1\/database\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.d1.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/queues\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.queues.delete(m[1]) ? ok(null) : gone();
    m = /^DELETE \/vectorize\/v2\/indexes\/([^/]+)$/.exec(key);
    if (m?.[1]) return world.vectorize.delete(m[1]) ? ok(null) : gone();
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
    expect(fake.world.kv.size + fake.world.d1.size + fake.world.queues.size).toBe(0);
    expect(fake.world.r2.size).toBe(0);
    expect(fake.world.vectorize.size).toBe(0);
    expect(JSON.stringify(r.logs)).not.toContain(TOKEN);
    expect(r.logs.at(-1)?.message).toBe('Uninstalled "cut".');
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
