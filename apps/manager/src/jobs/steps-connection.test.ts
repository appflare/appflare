import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolateConnectionMemo } from "../cloudflare/connection.server";
import { generateGrantKey, importGrantKey, sealContext, sealValue } from "../cloudflare/grant-seal";
import { type GrantRow, replaceGrantStatements } from "../cloudflare/grant-store.server";
import { SIGN_IN_WORDS } from "../cloudflare/sign-in-words";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { NO_CONTAINERS_PERMISSION_REASON } from "../sandbox/preflight";
import { ACC } from "../test/fake-account";
import { fakeCloudflare } from "../test/fake-cloudflare";
import { fakeOAuth } from "../test/fake-oauth";
import { fakeStep } from "../test/fake-step";
import type { JobEnv, JobParams } from "./run-job";
import { createJobSteps, JobError } from "./steps";
import { runUnit } from "./units/result";

/**
 * Jobs and units on a manager connected with OAuth: a job that runs past its
 * access token's expiry keeps working (the next call renews it, and the
 * renewal counts toward the invocation's requests), and a job on a grant
 * Cloudflare refused ends with words an owner can act on.
 */

const JOB = "job-connection";
const START = 1_790_000_000_000;
const SCRIPTS = `GET /accounts/${ACC}/workers/scripts`;
let clock = START;
let keySecret = "";

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await env.DB.prepare(
    "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES (?1, NULL, 'install', 'running', '{}')",
  )
    .bind(JOB)
    .run();
  clock = START;
  keySecret = generateGrantKey();
  const memo = isolateConnectionMemo();
  memo.access = null;
  memo.keys.clear();
  memo.envKey = null;
});

afterEach(() => vi.restoreAllMocks());

async function seedGrant(over: Partial<GrantRow> = {}) {
  const key = await importGrantKey(keySecret);
  if (key === null) throw new Error("no key");
  const row: GrantRow = {
    id: "grant-job",
    clientId: "client-job",
    scopes: [],
    refreshToken: await sealValue(
      key.key,
      "cf-refresh-SECRET-0",
      sealContext("grant-job", "refresh"),
    ),
    accessToken: await sealValue(key.key, "cf-access-SECRET-0", sealContext("grant-job", "access")),
    accessExpiresAt: START + 30 * 60_000,
    keyId: key.id,
    status: "connected",
    problem: null,
    problemAt: null,
    connectedAt: START - 86_400_000,
    refreshedAt: START - 60_000,
    ...over,
  };
  await env.DB.batch(replaceGrantStatements(env.DB, row));
}

function jobSteps(
  fetch: typeof globalThis.fetch | ((i: string, init?: RequestInit) => Promise<Response>),
) {
  const jobEnv: JobEnv = { DB: env.DB, CF_GRANT_KEY: keySecret };
  const steps = createJobSteps(
    {
      params: {} as JobParams,
      step: fakeStep(),
      env: jobEnv,
      deps: { fetch, now: () => clock, sleep: async () => {} },
    },
    JOB,
  );
  steps.setAccountId(ACC);
  return steps;
}

async function jobLogs(): Promise<string> {
  const rows = await env.DB.prepare("SELECT message, data_json FROM job_logs WHERE job_id = ?1")
    .bind(JOB)
    .all();
  return JSON.stringify(rows.results);
}

describe("a job on an OAuth connection", () => {
  it("keeps working across an access token's expiry, and counts the renewal", async () => {
    await seedGrant();
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const oauth = fakeOAuth(api.fetch);
    const steps = jobSteps(oauth.fetch);
    await steps.run("list before", async ({ cf }) => {
      await cf().workers.listScripts();
      return {};
    });
    expect(steps.invocation.spent).toBe(1);
    // The job runs on for an hour: the stored access token has expired.
    clock += 60 * 60_000;
    await steps.run("list after", async ({ cf }) => {
      await cf().workers.listScripts();
      await cf().workers.listScripts();
      return {};
    });
    expect(api.calls.map((c) => c.authorization)).toEqual([
      "Bearer cf-access-SECRET-0",
      "Bearer cf-access-SECRET-1",
      "Bearer cf-access-SECRET-1",
    ]);
    expect(oauth.refreshes).toHaveLength(1);
    // Three API calls and the renewal, all in this invocation's count.
    expect(steps.invocation.spent).toBe(4);
    expect(await jobLogs()).not.toContain("SECRET");
  });

  it("ends a job on a refused grant with the reconnect message, without retrying", async () => {
    await seedGrant({ accessToken: null, accessExpiresAt: null });
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const oauth = fakeOAuth(api.fetch);
    oauth.next.push("invalid_grant");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await jobSteps(oauth.fetch)
      .run("list", async ({ cf }) => {
        await cf().workers.listScripts();
        return {};
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect((error as Error).message).toContain("An administrator must reconnect Cloudflare in");
    expect((error as Error).message).toContain("Your apps keep running.");
    expect(oauth.refreshes).toHaveLength(1);
    expect(api.calls).toEqual([]);
  });

  it("says what the sign-in needs where a step's refusal was written for a token", async () => {
    await seedGrant();
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const error = await jobSteps(fakeOAuth(api.fetch).fetch)
      .run("check containers", async () => {
        throw new JobError(NO_CONTAINERS_PERMISSION_REASON);
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect((error as Error).message).toBe(SIGN_IN_WORDS.get(NO_CONTAINERS_PERMISSION_REASON));
    expect(await jobLogs()).toContain("Reconnect Cloudflare");
    expect(await jobLogs()).not.toContain("API token");
  });

  it("retries a step while the new version with the key is still rolling out", async () => {
    await seedGrant({ connectedAt: START - 60_000 });
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const step = fakeStep();
    const steps = createJobSteps(
      {
        params: {} as JobParams,
        step,
        env: { DB: env.DB },
        deps: { fetch: api.fetch, now: () => clock },
      },
      JOB,
    );
    steps.setAccountId(ACC);
    const error = await steps
      .run("list", async ({ cf }) => {
        await cf().workers.listScripts();
        return {};
      })
      .catch((e: unknown) => e);
    // Retried by the engine (3 more attempts), then reported as is.
    expect(step.retried).toEqual({ list: 4 });
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect((error as Error).message).toContain("still redeploying");
  });
});

describe("a unit on an OAuth connection", () => {
  it("renews an expired access token with its own counted requests", async () => {
    await seedGrant({ accessExpiresAt: START - 1 });
    const api = fakeCloudflare({ [SCRIPTS]: { result: [] } });
    const oauth = fakeOAuth(api.fetch);
    const result = await runUnit(
      { DB: env.DB, CF_GRANT_KEY: keySecret },
      { fetch: oauth.fetch, now: () => clock, sleep: async () => {} },
      ACC,
      async ({ cf }) => (await cf().workers.listScripts()).length,
    );
    expect(result).toMatchObject({ ok: true, value: 0, subrequests: 2 });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
