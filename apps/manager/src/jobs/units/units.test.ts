import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import { workerUploadCost, workerUploadProblem } from "@appflare/schema";
import { describe, expect, it } from "vitest";
import { buildArtifactFixture, ZIP_URL } from "../../test/artifact-fixture";
import { ACC, fakeAccount, NEW_VERSION, TOKEN } from "../../test/fake-account";
import { redirectingArtifactHost } from "../../test/redirecting-host";
import { toStepError } from "../errors";
import { StepLog } from "../step-log";
import { failureError, settleUnit } from "./result";
import {
  createJobUnits,
  type D1BaselineInput,
  type D1MigrationsInput,
  type D1SchemaInput,
  type WorkerUploadInput,
} from "./units";

/**
 * The job units on their own: what each call costs in subrequests, and how a
 * failure crosses the call and becomes the error the step runner classifies.
 */

async function world(options: Parameters<typeof buildArtifactFixture>[0] = {}) {
  const fixture = await buildArtifactFixture(options);
  const account = fakeAccount(fixture);
  const host = redirectingArtifactHost(fixture);
  const requests: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    requests.push(input);
    return host.serve(input, init) ?? account.fetch(input, init);
  };
  return { fixture, account, fetch, requests };
}

function uploadInput(
  fixture: Awaited<ReturnType<typeof buildArtifactFixture>>,
  over: Partial<WorkerUploadInput> = {},
): WorkerUploadInput {
  return {
    accountId: ACC,
    artifact: { zipUrl: ZIP_URL, host: { kind: "catalog" } },
    workerName: "cut",
    modules: fixture.manifest.worker.modules,
    metadata: { main_module: "worker.js", bindings: [] },
    target: "version",
    ...over,
  };
}

describe("uploadWorker", () => {
  it("reads the modules through the release redirect once and uploads them in one request", async () => {
    const w = await world();
    const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch: w.fetch });
    const result = await units.uploadWorker(uploadInput(w.fixture));
    expect(result).toMatchObject({
      ok: true,
      value: { versionId: NEW_VERSION, scriptId: null, modules: 1 },
      // The redirect, the range from storage, the upload.
      subrequests: 3,
    });
    expect(result.log.requests).toEqual([
      `POST /accounts/${ACC}/workers/scripts/cut/versions -> 200`,
    ]);
    expect(w.account.state.versions[0]?.modules).toEqual(["worker.js"]);
  });

  it("uploads a Worker of 600 modules in one call, reading them with one range", async () => {
    const w = await world({
      extraModules: Array.from({ length: 599 }, (_, i) => ({
        content: `export const chunk${i} = ${JSON.stringify("x".repeat(2000))};`,
      })),
    });
    const modules = w.fixture.manifest.worker.modules;
    expect(modules).toHaveLength(600);
    // What the packer and the jobs plan: the redirect and one range.
    expect(workerUploadCost(modules)).toBe(2);
    expect(workerUploadProblem(modules)).toBeNull();
    const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch: w.fetch });
    const result = await units.uploadWorker(uploadInput(w.fixture));
    // What the call made: the planned reads, then the upload.
    expect(result).toMatchObject({ ok: true, value: { modules: 600 }, subrequests: 3 });
    expect(w.account.state.versions[0]?.modules).toHaveLength(600);
  });

  it("reads the API token from its own environment, never from its input", async () => {
    const w = await world();
    const result = await createJobUnits({}, { fetch: w.fetch }).uploadWorker(
      uploadInput(w.fixture),
    );
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "final",
        message: "the Cloudflare API token is not configured; finish setup first",
      },
    });
    expect(w.account.state.calls).toEqual([]);
  });

  it("fails for good, before uploading, when a module's bytes do not match the manifest", async () => {
    const w = await world({
      tweak: (m) => {
        const [module] = m.worker.modules;
        if (module !== undefined) module.sha256 = "0".repeat(64);
      },
    });
    const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch: w.fetch });
    const result = await units.uploadWorker(uploadInput(w.fixture));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: "final" });
    expect(() => settleUnit(result, new StepLog())).toThrow(NonRetryableError);
    expect(w.account.state.versions).toEqual([]);
  });

  it("refuses an input it does not understand", async () => {
    const w = await world();
    const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch: w.fetch });
    const result = await units.uploadWorker({ ...uploadInput(w.fixture), modules: [] });
    expect(result).toMatchObject({ ok: false, subrequests: 0, failure: { kind: "final" } });
    if (result.ok) return;
    expect(result.failure).toMatchObject({
      message: expect.stringMatching(/^the running version of Appflare cannot run uploadWorker/),
    });
    expect(w.requests).toEqual([]);
  });
});

describe("unit failures", () => {
  it("come back as the Cloudflare error, so 5xx retries and 4xx does not", async () => {
    for (const [status, retried] of [
      [500, true],
      [403, false],
    ] as const) {
      const w = await world();
      w.account.state.failOnce.set("POST /workers/scripts/cut/versions", status);
      const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch: w.fetch });
      const result = await units.uploadWorker(uploadInput(w.fixture));
      expect(result).toMatchObject({ ok: false, failure: { kind: "cloudflare", status } });
      let thrown: unknown = null;
      try {
        settleUnit(result, new StepLog());
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CloudflareApiError);
      expect(toStepError(thrown) instanceof NonRetryableError).toBe(!retried);
    }
  });

  it("bring their log lines and API calls into the step's log", async () => {
    const d = await d1World(1);
    const result = await d.units.applyD1Migrations(d.input);
    const log = new StepLog();
    log.info("before");
    expect(settleUnit(result, log)).toEqual({
      pending: 1,
      applied: 1,
      remaining: 0,
      next: null,
      failed: null,
    });
    expect(log.lines.map((l) => l.message)).toEqual([
      "before",
      "0 migration(s) already applied to cut-db; applying 1 of 1 new.",
      "Applied 0001_table1.sql to cut-db.",
    ]);
    // The table, the list, the file (through the redirect), the query.
    expect(log.lines.at(-1)?.data).toEqual({ subrequests: 5 });
    expect(log.requests).toEqual(
      Array(3).fill(`POST /accounts/${ACC}/d1/database/d1-1/query -> 200`),
    );
  });
});

/** A database, `count` migration files served through a release redirect, and the units. */
async function d1World(count: number) {
  const files = Array.from({ length: count }, (_, i) => ({
    name: `${String(i + 1).padStart(4, "0")}_table${i + 1}.sql`,
    content: `CREATE TABLE t${i + 1} (id TEXT);`,
  }));
  const fixture = await buildArtifactFixture({
    bindings: [{ type: "d1", name: "DB" }],
    d1: { DB: files },
  });
  const account = fakeAccount(fixture, { d1: [{ uuid: "d1-1", name: "cut-db" }] });
  const host = redirectingArtifactHost(fixture);
  /** Queries for these files answer with this status, without running, while `times` lasts. */
  const failing = new Map<string, { status: number; times: number }>();
  const fetch = async (input: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { sql?: string }) : {};
    for (const [file, fail] of failing) {
      if (fail.times > 0 && body.sql?.endsWith(`values ('${file}');`)) {
        fail.times -= 1;
        return Response.json(
          { success: false, errors: [{ code: 7500, message: 'near "BROKEN": syntax error' }] },
          { status: fail.status },
        );
      }
    }
    return host.serve(input, init) ?? account.fetch(input, init);
  };
  const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch });
  const input: D1MigrationsInput = {
    accountId: ACC,
    artifact: { zipUrl: ZIP_URL, host: { kind: "catalog" } },
    databaseId: "d1-1",
    databaseName: "cut-db",
    files: fixture.manifest.d1Migrations.DB ?? [],
  };
  const names = files.map((f) => f.name);
  /** How many queries ran `file` (its SQL and its d1_migrations row). */
  const runs = (file: string) =>
    account.state.queries.filter((q) => q.endsWith(`values ('${file}');`)).length;
  return { account, host, units, input, names, failing, runs };
}

describe("applyD1Migrations", () => {
  it("applies 30 files in one call: 2 + 2 + one query per file", async () => {
    const d = await d1World(30);
    const result = await d.units.applyD1Migrations(d.input);
    expect(result).toMatchObject({
      ok: true,
      value: { applied: 30, remaining: 0, next: null },
      subrequests: 34,
    });
    expect(d.account.state.applied["d1-1"]).toEqual(d.names);
    // One redirect and one range for every file: the packer writes them side by side.
    expect(d.host.requests.map((r) => r.range)).toEqual([
      expect.stringMatching(/^bytes=/),
      expect.stringMatching(/^bytes=/),
    ]);
  });

  it("applies files in filename order whatever order it is given", async () => {
    const d = await d1World(3);
    await d.units.applyD1Migrations({ ...d.input, files: [...d.input.files].reverse() });
    expect(d.account.state.applied["d1-1"]).toEqual(d.names);
  });

  it("stops within its subrequest budget and says where to continue", async () => {
    const d = await d1World(40);
    const first = await d.units.applyD1Migrations(d.input);
    expect(first).toMatchObject({
      ok: true,
      value: { applied: 32, remaining: 8, next: "0033_table33.sql" },
      subrequests: 36,
    });
    const second = await d.units.applyD1Migrations(d.input);
    expect(second).toMatchObject({ ok: true, value: { applied: 8, remaining: 0, next: null } });
    expect(d.account.state.applied["d1-1"]).toEqual(d.names);
  });

  it("does nothing but check when every file is applied", async () => {
    const d = await d1World(2);
    await d.units.applyD1Migrations(d.input);
    const again = await d.units.applyD1Migrations(d.input);
    expect(again).toMatchObject({
      ok: true,
      value: { applied: 0, remaining: 0, next: null },
      subrequests: 2,
    });
  });

  it("resumes after the last file a failed call recorded", async () => {
    const d = await d1World(30);
    d.failing.set("0013_table13.sql", { status: 500, times: 1 });
    const failed = await d.units.applyD1Migrations(d.input);
    // The call reports what it applied, and the failure as part of its value.
    expect(failed).toMatchObject({
      ok: true,
      value: {
        pending: 30,
        applied: 12,
        remaining: 18,
        next: "0013_table13.sql",
        failed: { kind: "cloudflare", status: 500, subject: "0013_table13.sql" },
      },
    });
    expect(d.account.state.applied["d1-1"]).toEqual(d.names.slice(0, 12));
    const retried = await d.units.applyD1Migrations(d.input);
    expect(retried).toMatchObject({ ok: true, value: { applied: 18, remaining: 0 } });
    expect(d.account.state.applied["d1-1"]).toEqual(d.names);
    for (const file of d.names) expect(d.runs(file)).toBe(1);
  });

  it("stops at the file whose statement fails and fails the step with Cloudflare's error", async () => {
    const d = await d1World(30);
    d.failing.set("0024_table24.sql", { status: 400, times: 1 });
    const result = await d.units.applyD1Migrations(d.input);
    expect(d.account.state.applied["d1-1"]).toEqual(d.names.slice(0, 23));
    for (const file of d.names.slice(24)) expect(d.runs(file)).toBe(0);
    const value = settleUnit(result, new StepLog());
    expect(value).toMatchObject({ pending: 30, applied: 23, remaining: 7 });
    if (value.failed === null) throw new Error("the call did not report its failure");
    const thrown = failureError(value.failed);
    expect(thrown).toBeInstanceOf(CloudflareApiError);
    expect(thrown).toMatchObject({ status: 400 });
    const stepError = toStepError(thrown);
    expect(stepError).toBeInstanceOf(NonRetryableError);
    expect(stepError.message).toBe(
      `0024_table24.sql: Cloudflare API request failed: POST /accounts/${ACC}/d1/database/d1-1/query -> 400: [7500] near "BROKEN": syntax error`,
    );
  });
});

describe("applyD1Migrations and names upstream no longer ships", () => {
  it("logs recorded names the version does not ship and applies only the new files", async () => {
    const d = await d1World(3);
    d.account.state.applied["d1-1"] = ["0001_table1.sql", "0002_renamed.sql"];
    const result = await d.units.applyD1Migrations({
      ...d.input,
      shipped: d.names,
    });
    expect(result).toMatchObject({ ok: true, value: { applied: 2, remaining: 0 } });
    expect(result.log.lines.map((l) => l.message)).toContain(
      "d1_migrations of cut-db records 1 migration(s) this version does not ship (0002_renamed.sql); they stay recorded and nothing runs for them.",
    );
    expect(d.account.state.applied["d1-1"]).toEqual([
      "0001_table1.sql",
      "0002_renamed.sql",
      "0002_table2.sql",
      "0003_table3.sql",
    ]);
  });
});

const BASELINE_SQL = "CREATE TABLE links (id TEXT, slug TEXT);\nCREATE TABLE clicks (id TEXT);";

/** A new database, a baseline and three migrations served through a release redirect. */
async function baselineWorld(content: string = BASELINE_SQL) {
  const fixture = await buildArtifactFixture({
    bindings: [{ type: "d1", name: "DB" }],
    d1: {
      DB: [
        { name: "0001_add_slug.sql", content: "ALTER TABLE links ADD COLUMN slug TEXT;" },
        { name: "0002_clicks.sql", content: "CREATE TABLE clicks (id TEXT);" },
        { name: "0003_it's.sql", content: "SELECT 1;" },
      ],
    },
    d1Baseline: { DB: { name: "db/schema.sql", content } },
  });
  const account = fakeAccount(fixture, { d1: [{ uuid: "d1-1", name: "cut-db" }] });
  const host = redirectingArtifactHost(fixture);
  let failBaseline = 0;
  const fetch = async (input: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { sql?: string }) : {};
    if (failBaseline > 0 && body.sql?.startsWith("CREATE TABLE links")) {
      failBaseline -= 1;
      return Response.json(
        { success: false, errors: [{ code: 7500, message: "table links already exists" }] },
        { status: 400 },
      );
    }
    return host.serve(input, init) ?? account.fetch(input, init);
  };
  const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch });
  const file = fixture.manifest.d1Baseline?.DB?.[0];
  if (file === undefined) throw new Error("the fixture has no baseline");
  const input: D1BaselineInput = {
    accountId: ACC,
    artifact: { zipUrl: ZIP_URL, host: { kind: "catalog" } },
    databaseId: "d1-1",
    databaseName: "cut-db",
    file,
    migrations: (fixture.manifest.d1Migrations.DB ?? []).map((f) => f.name),
  };
  return {
    fixture,
    account,
    host,
    units,
    input,
    failNext: () => {
      failBaseline = 1;
    },
  };
}

describe("applyD1Baseline", () => {
  it("runs the baseline and records every migration in one query, without running them", async () => {
    const d = await baselineWorld();
    const result = await d.units.applyD1Baseline(d.input);
    expect(result).toMatchObject({
      ok: true,
      value: { ran: true, recorded: 3 },
      // The table, the count, the redirect and the range, the baseline query.
      subrequests: 5,
    });
    const [create, count, baseline, ...rest] = d.account.state.queries;
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "d1_migrations"/);
    expect(count).toMatch(/^SELECT \(SELECT count\(\*\) FROM sqlite_master/);
    expect(baseline).toBe(
      `${BASELINE_SQL}\nINSERT OR IGNORE INTO "d1_migrations" (name)\nvalues ('0001_add_slug.sql'),\n('0002_clicks.sql'),\n('0003_it''s.sql');`,
    );
    expect(rest).toEqual([]);
    expect(d.account.state.applied["d1-1"]).toEqual([
      "0001_add_slug.sql",
      "0002_clicks.sql",
      "0003_it's.sql",
    ]);
    // No migration's SQL ran.
    expect(d.account.state.queries.some((q) => q.includes("ALTER TABLE"))).toBe(false);
    expect(result.log.lines.map((l) => l.message)).toContain(
      "Ran the baseline db/schema.sql on cut-db and recorded 3 migration(s) as applied without running them.",
    );
  });

  it("leaves the migrations unit nothing to apply afterwards", async () => {
    const d = await baselineWorld();
    await d.units.applyD1Baseline(d.input);
    const files = d.fixture.manifest.d1Migrations.DB ?? [];
    const next = await d.units.applyD1Migrations({ ...d.input, files });
    expect(next).toMatchObject({ ok: true, value: { pending: 0, applied: 0 } });
  });

  it("does not run the baseline again on a retry, and records nothing", async () => {
    const d = await baselineWorld();
    await d.units.applyD1Baseline(d.input);
    const before = d.account.state.queries.length;
    const again = await d.units.applyD1Baseline(d.input);
    // The table and the state, nothing read, nothing written.
    expect(again).toMatchObject({ ok: true, value: { ran: false, recorded: 0 }, subrequests: 2 });
    expect(d.account.state.queries.slice(before).map((q) => q.split("\n")[0])).toEqual([
      'CREATE TABLE IF NOT EXISTS "d1_migrations"(',
      "SELECT (SELECT count(*) FROM sqlite_master",
    ]);
    expect(d.account.state.applied["d1-1"]).toHaveLength(3);
  });

  it("leaves a database with recorded migrations and no tables to the migrations", async () => {
    const d = await baselineWorld();
    d.account.state.applied["d1-1"] = ["0001_add_slug.sql"];
    const result = await d.units.applyD1Baseline(d.input);
    expect(result).toMatchObject({ ok: true, value: { ran: false, recorded: 0 } });
    expect(d.account.state.queries.some((q) => q.startsWith("CREATE TABLE links"))).toBe(false);
    expect(d.account.state.applied["d1-1"]).toEqual(["0001_add_slug.sql"]);
    expect(result.log.lines.map((l) => l.message)).toContain(
      "cut-db already has 0 table(s) and 1 recorded migration(s), so the baseline db/schema.sql does not run; the migrations bring it up to date.",
    );
  });

  it("refuses a baseline that ends inside an unclosed comment, before sending it", async () => {
    const d = await baselineWorld(`${BASELINE_SQL}\n/* note`);
    const result = await d.units.applyD1Baseline(d.input);
    expect(result).toMatchObject({
      ok: false,
      failure: {
        kind: "final",
        message:
          "the baseline db/schema.sql cannot run: it ends inside a /* comment that is never closed",
      },
    });
    expect(d.account.state.queries.some((q) => q.startsWith("CREATE TABLE links"))).toBe(false);
    expect(d.account.state.applied["d1-1"] ?? []).toEqual([]);
  });

  it("fails with Cloudflare's error, naming the baseline, and records nothing", async () => {
    const d = await baselineWorld();
    d.failNext();
    const result = await d.units.applyD1Baseline(d.input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(toStepError(failureError(result.failure)).message).toBe(
      `db/schema.sql: Cloudflare API request failed: POST /accounts/${ACC}/d1/database/d1-1/query -> 400: [7500] table links already exists`,
    );
    expect(d.account.state.applied["d1-1"] ?? []).toEqual([]);
  });
});

/** A database, `count` schema files served through a release redirect, and the units. */
async function schemaWorld(count: number) {
  const files = Array.from({ length: count }, (_, i) => ({
    // Listed out of name order on purpose: schema files run in the catalog's order.
    name: `schema/${String(count - i).padStart(2, "0")}.sql`,
    content: `CREATE TABLE IF NOT EXISTS s${count - i} (id TEXT);`,
  }));
  const fixture = await buildArtifactFixture({
    bindings: [{ type: "d1", name: "DB" }],
    d1Schema: { DB: files },
  });
  const account = fakeAccount(fixture, { d1: [{ uuid: "d1-1", name: "cut-db" }] });
  const host = redirectingArtifactHost(fixture);
  /** Queries containing this text answer with this status, without running, while `times` lasts. */
  const failing = new Map<string, { status: number; times: number }>();
  const fetch = async (input: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { sql?: string }) : {};
    for (const [text, fail] of failing) {
      if (fail.times > 0 && body.sql?.includes(text)) {
        fail.times -= 1;
        return Response.json(
          { success: false, errors: [{ code: 7500, message: "no such table: s0" }] },
          { status: fail.status },
        );
      }
    }
    return host.serve(input, init) ?? account.fetch(input, init);
  };
  const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch });
  const input: D1SchemaInput = {
    accountId: ACC,
    artifact: { zipUrl: ZIP_URL, host: { kind: "catalog" } },
    databaseId: "d1-1",
    databaseName: "cut-db",
    files: fixture.manifest.d1Schema?.DB ?? [],
  };
  return { account, host, units, input, files, failing };
}

describe("applyD1Schema", () => {
  it("runs the files as they are, in the order given, and records none of them", async () => {
    const d = await schemaWorld(3);
    const result = await d.units.applyD1Schema(d.input);
    expect(result).toMatchObject({
      ok: true,
      value: { applied: 3, remaining: 0, next: null, failed: null },
      // The redirect, one range for the three files, one query per file.
      subrequests: 5,
    });
    expect(d.account.state.queries).toEqual(d.files.map((f) => f.content));
    expect(d.account.state.applied["d1-1"] ?? []).toEqual([]);
    expect(result.log.lines.map((l) => l.message)).toContain(
      "Ran the schema file schema/03.sql on cut-db.",
    );
    // Run again, they run again: nothing says they already ran.
    await d.units.applyD1Schema(d.input);
    expect(d.account.state.queries).toHaveLength(6);
  });

  it("runs as many as fit its subrequest budget and names the next one", async () => {
    const d = await schemaWorld(40);
    const first = await d.units.applyD1Schema(d.input);
    expect(first).toMatchObject({
      ok: true,
      value: { applied: 34, remaining: 6, next: "schema/06.sql" },
      subrequests: 36,
    });
    const rest = d.input.files.slice(34);
    const second = await d.units.applyD1Schema({ ...d.input, files: rest });
    expect(second).toMatchObject({ ok: true, value: { applied: 6, remaining: 0, next: null } });
    expect(d.account.state.queries).toEqual(d.files.map((f) => f.content));
  });

  it("stops at the file that fails and reports it with Cloudflare's error", async () => {
    const d = await schemaWorld(3);
    d.failing.set("s2 ", { status: 400, times: 1 });
    const value = settleUnit(await d.units.applyD1Schema(d.input), new StepLog());
    expect(value).toMatchObject({ applied: 1, remaining: 2, next: "schema/02.sql" });
    if (value.failed === null) throw new Error("the call did not report its failure");
    expect(toStepError(failureError(value.failed)).message).toBe(
      `schema/02.sql: Cloudflare API request failed: POST /accounts/${ACC}/d1/database/d1-1/query -> 400: [7500] no such table: s0`,
    );
    expect(d.account.state.queries).toEqual([d.files[0]?.content]);
  });
});
