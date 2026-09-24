import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { ACC, TOKEN } from "../test/fake-account";
import { fakeSandbox } from "../test/fake-sandbox";
import { fakeSelf } from "../test/fake-self";
import { fakeStep } from "../test/fake-step";
import type { JobEnv, JobParams } from "./run-job";
import {
  awaitSandboxSettledPhase,
  SANDBOX_SETTLE_IN_PLACE_STEP,
  SANDBOX_SETTLE_REMOTE_STEP,
  SANDBOX_SETTLE_STEP,
} from "./sandbox-settle";
import { createJobSteps } from "./steps";
import { SANDBOX_SETTLE } from "./units/sandbox-settle";

/**
 * The wait for the sandbox Worker to settle, against the fake `SANDBOX`
 * binding (whose `info()` reports the answering version from a script), a
 * fake Cloudflare API that lists the sandbox Worker's deployment, and the
 * fake Workflow engine; the unit runs behind a fake `SELF` (as over RPC) or
 * in the job's own invocation. Waits are recorded, not slept.
 */

const JOB = "job1";
const DEPLOYED = "22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PREVIOUS = "11111111-aaaa-4bbb-8ccc-dddddddddddd";
const DEPLOYMENTS = `/client/v4/accounts/${ACC}/workers/scripts/appflare-sandbox/deployments`;

function setup(opts: {
  versionIds?: string[];
  /** How the deployments API answers: the version at 100%, or an error status. */
  deployments?: { deployed: string } | { status: number };
  /** The unit runs over a (fake) `SELF` binding, in its own invocation. */
  remote?: boolean;
}) {
  const sandbox = fakeSandbox(null, { versionIds: opts.versionIds });
  const sleeps: number[] = [];
  const apiCalls: string[] = [];
  const answer = opts.deployments ?? { deployed: DEPLOYED };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    apiCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname !== DEPLOYMENTS) throw new Error(`unexpected ${input}`);
    if ("status" in answer) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "refused" }], messages: [] },
        { status: answer.status },
      );
    }
    return Response.json({
      success: true,
      errors: [],
      messages: [],
      result: {
        deployments: [
          { id: "dep-2", versions: [{ version_id: answer.deployed, percentage: 100 }] },
        ],
      },
    });
  };
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const base: JobEnv = { DB: env.DB, CF_API_TOKEN: TOKEN, SANDBOX: sandbox };
  const jobEnv: JobEnv = opts.remote ? { ...base, SELF: fakeSelf(base, { fetch, sleep }) } : base;
  const step = fakeStep();
  const steps = createJobSteps(
    {
      params: {} as JobParams,
      step,
      env: jobEnv,
      deps: { fetch, now: () => 1_790_000_000_000, sleep },
    },
    JOB,
  );
  return { sandbox, sleeps, apiCalls, step, steps };
}

async function logs() {
  return (
    await env.DB.prepare("SELECT level, message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(JOB)
      .all<{ level: string; message: string }>()
  ).results;
}

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await env.DB.prepare(
    "INSERT INTO jobs (id, install_id, kind, status) VALUES (?1, NULL, 'install', 'running')",
  )
    .bind(JOB)
    .run();
});

describe("awaitSandboxSettledPhase", () => {
  it("waits until the deployed version answers several times in a row, in a unit of its own", async () => {
    // The previous version still answers twice after the secret write.
    const t = setup({ versionIds: [PREVIOUS, PREVIOUS, DEPLOYED], remote: true });
    const result = await awaitSandboxSettledPhase(t.steps, ACC);

    expect(result).toMatchObject({ mode: "deployed", settled: true, answered: DEPLOYED });
    expect(t.step.names).toEqual([SANDBOX_SETTLE_STEP]);
    expect(t.step.configs).toEqual([SANDBOX_SETTLE_REMOTE_STEP]);
    expect(t.sandbox.infoCalls).toBe(2 + SANDBOX_SETTLE.steadyAnswers);
    expect(t.sleeps).toEqual(Array(t.sandbox.infoCalls - 1).fill(SANDBOX_SETTLE.pollMs));
    expect(t.apiCalls).toEqual([`GET ${DEPLOYMENTS}`]);
    const lines = await logs();
    expect(lines.map((l) => l.level)).toEqual(["info"]);
    expect(lines[0]?.message).toBe(
      "The sandbox Worker is settled: Appflare waited for its deployed version 22222222, and version 22222222 answered (5 answer(s)).",
    );
  });

  it("starts counting again when an older version answers in between", async () => {
    const t = setup({ versionIds: [DEPLOYED, PREVIOUS, DEPLOYED] });
    await awaitSandboxSettledPhase(t.steps, ACC);
    expect(t.sandbox.infoCalls).toBe(2 + SANDBOX_SETTLE.steadyAnswers);
  });

  it("logs a warning and lets the run start when the deployed version never answers", async () => {
    const remote = setup({ versionIds: [PREVIOUS], remote: true });
    const result = await awaitSandboxSettledPhase(remote.steps, ACC);
    expect(result).toMatchObject({ mode: "deployed", settled: false, answered: PREVIOUS });
    expect(remote.sandbox.infoCalls).toBe(SANDBOX_SETTLE.maxAnswers);
    expect(remote.sleeps).toHaveLength(SANDBOX_SETTLE.maxAnswers - 1);
    const lines = await logs();
    expect(lines.map((l) => l.level)).toEqual(["warn"]);
    expect(lines[0]?.message).toMatch(
      /^The sandbox Worker did not settle within 58 seconds: Appflare waited for its deployed version 22222222, and it last answered from 11111111\. Starting anyway;/,
    );
  });

  it("asks at most 10 times, without retrying, when the unit runs in the job's own invocation", async () => {
    const t = setup({ versionIds: [PREVIOUS] });
    await awaitSandboxSettledPhase(t.steps, ACC);
    expect(t.step.configs).toEqual([SANDBOX_SETTLE_IN_PLACE_STEP]);
    // 1 deployments read and 10 answers: what the job's own invocation spends.
    expect(t.apiCalls).toHaveLength(1);
    expect(t.sandbox.infoCalls).toBe(SANDBOX_SETTLE.maxAnswersInPlace);
    expect((await logs())[0]?.message).toContain("did not settle within 18 seconds");
  });

  it("waits for one version to answer steadily when the deployments cannot be read now, and says so", async () => {
    const t = setup({ versionIds: [PREVIOUS, DEPLOYED], deployments: { status: 503 } });
    const result = await awaitSandboxSettledPhase(t.steps, ACC);
    // The first answer differs from the rest, which then answer steadily.
    expect(result).toMatchObject({ mode: "steady", settled: true, answered: DEPLOYED });
    expect(t.sandbox.infoCalls).toBe(1 + SANDBOX_SETTLE.steadyAnswers);
    expect((await logs())[0]?.message).toMatch(
      /^The sandbox Worker is settled: Appflare could not tell its deployed version \(its deployments could not be read \(.*503.*\)\), so waited for one version to answer 3 times in a row/,
    );
  });

  it("fails on a refused deployments read instead of waiting less carefully", async () => {
    const t = setup({ versionIds: [DEPLOYED], deployments: { status: 403 }, remote: true });
    await expect(awaitSandboxSettledPhase(t.steps, ACC)).rejects.toThrow(/403/);
    expect(t.sandbox.infoCalls).toBe(0);
  });

  it("does not wait for a sandbox Worker that does not report its version", async () => {
    const t = setup({});
    const result = await awaitSandboxSettledPhase(t.steps, ACC);
    expect(result.mode).toBe("unreported");
    expect(t.sandbox.infoCalls).toBe(1);
    expect(t.sleeps).toEqual([]);
    const lines = await logs();
    expect(lines.map((l) => l.level)).toEqual(["info"]);
    expect(lines[0]?.message).toContain("does not say which of its versions answers");
  });
});
