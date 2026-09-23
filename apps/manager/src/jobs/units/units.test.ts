import { NonRetryableError } from "cloudflare:workflows";
import { CloudflareApiError } from "@appflare/cf-api";
import { describe, expect, it } from "vitest";
import { buildArtifactFixture, ZIP_URL } from "../../test/artifact-fixture";
import { ACC, fakeAccount, NEW_VERSION, TOKEN } from "../../test/fake-account";
import { redirectingArtifactHost } from "../../test/redirecting-host";
import { toStepError } from "../errors";
import { StepLog } from "../step-log";
import { settleUnit } from "./result";
import { createJobUnits, type WorkerUploadInput } from "./units";

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
    const fixture = await buildArtifactFixture({
      bindings: [{ type: "d1", name: "DB" }],
      d1: { DB: [{ name: "0001_init.sql", content: "CREATE TABLE t (id TEXT);" }] },
    });
    const account = fakeAccount(fixture, { d1: [{ uuid: "d1-1", name: "cut-db" }] });
    const migration = fixture.manifest.d1Migrations.DB?.[0];
    if (migration === undefined) throw new Error("no migration in the fixture");
    const units = createJobUnits({ CF_API_TOKEN: TOKEN }, { fetch: account.fetch });
    const result = await units.applyD1Migration({
      accountId: ACC,
      artifact: { zipUrl: ZIP_URL, host: { kind: "catalog" } },
      databaseId: "d1-1",
      databaseName: "cut-db",
      file: migration,
      checkApplied: true,
    });
    const log = new StepLog();
    log.info("before");
    expect(settleUnit(result, log)).toEqual({ applied: true });
    expect(log.lines.map((l) => l.message)).toEqual(["before", "Applied 0001_init.sql to cut-db."]);
    // The retry check, the file, the query.
    expect(log.lines.at(-1)?.data).toEqual({ subrequests: 3 });
    expect(log.requests).toEqual([
      `POST /accounts/${ACC}/d1/database/d1-1/query -> 200`,
      `POST /accounts/${ACC}/d1/database/d1-1/query -> 200`,
    ]);
  });
});
