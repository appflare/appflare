import { reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { FetchLike } from "@appflare/cf-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createMigrator } from "../db/migrate";
import { migrations } from "../db/migrations/index";
import { sandboxBinding } from "../sandbox/binding";
import { ACC, TOKEN } from "../test/fake-account";
import { fakeEngine, TOO_MANY_SUBREQUESTS } from "../test/fake-invocations";
import { checkLiveHealthPhase } from "./install/phases";
import {
  countedUnits,
  FRESH_INVOCATION_SLEEP,
  InvocationBudget,
  SPEND_BEFORE_STEP,
} from "./invocation-budget";
import {
  JOB_HANDLERS,
  type JobEnv,
  type JobHandler,
  type JobParams,
  runJob as runJobOf,
  type StepRunner,
} from "./run-job";
import { createJobSteps, FRESH_INVOCATION_NOTE, type JobSteps, OWN_LIMIT_NOTE } from "./steps";
import type { JobUnitsApi } from "./units/units";

/**
 * A job's steps spread over Worker invocations on Workers Free, against a
 * fake engine that refuses a 51st request per invocation and resumes the job
 * in a new invocation after a sleep of 5 minutes (../test/fake-invocations.ts).
 */

const JOB = "job-spread";
const URL = "https://api.example.test/thing";

const ok: FetchLike = async () => new Response("ok");

beforeEach(async () => {
  await reset();
  await createMigrator(migrations).ensure(env.DB);
  await env.DB.prepare(
    "INSERT INTO jobs (id, install_id, kind, status, input_json) VALUES (?1, NULL, 'install', 'running', '{}')",
  )
    .bind(JOB)
    .run();
});

/** A job of `sizes.length` steps, step `i` making `sizes[i]` requests, run by the fake engine. */
async function runJob(
  sizes: readonly number[],
  opts: { spread?: boolean; units?: JobUnitsApi } = {},
) {
  return runSteps(async (steps) => {
    for (const [i, size] of sizes.entries()) {
      await steps.run(`step ${i + 1}`, async ({ fetch }) => {
        for (let n = 0; n < size; n++) {
          if (opts.units === undefined) await fetch(URL);
          else
            await steps.units.api.countCronTriggers({
              accountId: ACC,
              exclude: "cut",
              maxWorkers: 1,
            });
        }
        return {};
      });
    }
  }, opts);
}

/** `steps` of `size` requests each, named `prefix 1`, `prefix 2`. */
async function fetching(steps: JobSteps, prefix: string, sizes: readonly number[]) {
  for (const [i, size] of sizes.entries()) {
    await steps.run(`${prefix} ${i + 1}`, async ({ fetch }) => {
      for (let n = 0; n < size; n++) await fetch(URL);
      return {};
    });
  }
}

/** Runs `body` as a job in the fake engine, from the top in each invocation. */
async function runSteps(
  body: (steps: JobSteps, step: StepRunner) => Promise<void>,
  opts: { spread?: boolean; units?: JobUnitsApi; fetch?: FetchLike } = {},
) {
  const engine = fakeEngine();
  const base: JobEnv = { DB: env.DB, CF_API_TOKEN: TOKEN };
  const jobEnv: JobEnv =
    opts.units === undefined ? base : { ...base, SELF: engine.units(opts.units) };
  const spent: number[] = [];
  let error: unknown = null;
  try {
    await engine.run(async () => {
      const steps: JobSteps = createJobSteps(
        {
          params: {} as JobParams,
          step: engine.step,
          env: jobEnv,
          deps: { fetch: engine.fetch(opts.fetch ?? ok), now: () => 1_790_000_000_000 },
        },
        JOB,
      );
      steps.setAccountId(ACC);
      if (opts.spread !== false) steps.spreadOverInvocations();
      await body(steps, engine.step);
      spent.push(steps.invocation.spent);
    });
  } catch (e) {
    error = e;
  }
  const logs = (
    await env.DB.prepare("SELECT message FROM job_logs WHERE job_id = ?1 ORDER BY id")
      .bind(JOB)
      .all<{ message: string }>()
  ).results.map((r) => r.message);
  return { engine, error, logs, spent };
}

describe("invocation budget", () => {
  it("counts fetches, a followed redirect as two and a failure as one, and unit calls", async () => {
    const budget = new InvocationBudget();
    const redirected = Object.defineProperty(new Response("x"), "redirected", { value: true });
    const fetch = budget.countingFetch(async (input) => {
      if (input.endsWith("/fail")) throw new Error("connection reset");
      return input.endsWith("/moved") ? redirected : new Response("x");
    });
    await fetch(URL);
    await fetch(`${URL}/moved`);
    await expect(fetch(`${URL}/fail`)).rejects.toThrow("connection reset");
    expect(budget.spent).toBe(4);
    const calls: unknown[] = [];
    const api = countedUnits(
      {
        countCronTriggers: async (input: unknown) => {
          calls.push(input);
          return { ok: true };
        },
      } as unknown as JobUnitsApi,
      () => budget.add(1),
    );
    await api.countCronTriggers({ accountId: ACC, exclude: "cut", maxWorkers: 1 });
    expect(calls).toEqual([{ accountId: ACC, exclude: "cut", maxWorkers: 1 }]);
    expect(budget.spent).toBe(5);
  });

  it("asks for a fresh invocation only when the job spreads and the next step might not fit", () => {
    const budget = new InvocationBudget();
    budget.add(SPEND_BEFORE_STEP + 1);
    expect(budget.needsFresh()).toBe(false);
    budget.spread();
    expect(budget.needsFresh()).toBe(true);
    budget.fresh();
    expect(budget.spent).toBe(0);
    budget.add(SPEND_BEFORE_STEP);
    expect(budget.needsFresh()).toBe(false);
  });
});

describe("a job spread over invocations", () => {
  it("waits for a fresh invocation before a step that might not fit, and runs every step once", async () => {
    const r = await runJob(Array.from({ length: 14 }, () => 7));
    expect(r.error).toBeNull();
    // 98 requests: no invocation made more than 50.
    expect(r.engine.invocations.every((n) => n <= 50)).toBe(true);
    expect(r.engine.invocations.reduce((a, b) => a + b, 0)).toBe(98);
    expect(r.engine.invocations.length).toBe(3);
    // Each wait is a log line and a sleep of 5 minutes before the step it is for.
    expect(r.engine.sleeps).toEqual([
      { name: "fresh invocation before step 7", duration: FRESH_INVOCATION_SLEEP },
      { name: "fresh invocation before step 13", duration: FRESH_INVOCATION_SLEEP },
    ]);
    expect(r.logs.filter((m) => m === FRESH_INVOCATION_NOTE)).toHaveLength(2);
    // Every step's body ran once, the ones after a wait in the next invocation.
    const steps = r.engine.ran.filter((s) => s.name.startsWith("step "));
    expect(steps.map((s) => s.name)).toEqual(Array.from({ length: 14 }, (_, i) => `step ${i + 1}`));
    expect(steps.map((s) => s.invocation)).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2]);
    // The count starts again in each invocation, and the replay costs nothing.
    expect(r.spent.at(-1)).toBe(14);
  });

  it("counts calls to job units over SELF as one request each", async () => {
    const units = {
      countCronTriggers: async () => ({ ok: true, value: { count: 0 }, subrequests: 1, logs: [] }),
    } as unknown as JobUnitsApi;
    const r = await runJob(
      Array.from({ length: 10 }, () => 9),
      { units },
    );
    expect(r.error).toBeNull();
    expect(r.engine.invocations.every((n) => n <= 50)).toBe(true);
    expect(r.engine.invocations.reduce((a, b) => a + b, 0)).toBe(90);
    expect(r.engine.sleeps.length).toBe(r.engine.invocations.length - 1);
  });

  it("runs a step that still runs out once more in a fresh invocation", async () => {
    // 35 requests leave 15; the sixth step needs 20.
    const r = await runJob([7, 7, 7, 7, 7, 20, 3]);
    expect(r.error).toBeNull();
    expect(r.engine.sleeps.map((s) => s.name)).toEqual(["fresh invocation before step 6 again"]);
    const sixth = r.engine.ran.filter((s) => s.name.startsWith("step 6"));
    expect(sixth).toEqual([
      { name: "step 6", invocation: 0 },
      { name: "step 6 (again)", invocation: 1 },
    ]);
    expect(r.engine.invocations).toEqual([51, 23]);
  });

  it("fails as before when the job does not spread", async () => {
    const r = await runJob(
      Array.from({ length: 14 }, () => 7),
      { spread: false },
    );
    expect(String(r.error)).toContain(TOO_MANY_SUBREQUESTS.slice(0, 40));
    expect(r.engine.sleeps).toEqual([]);
    expect(r.engine.invocations).toEqual([51]);
  });
});

describe("a block of steps that runs in one invocation", () => {
  it("waits for a fresh invocation before the block when it would not fit, never inside it", async () => {
    const r = await runSteps(async (steps) => {
      await fetching(steps, "before", [7, 7]);
      // 14 spent and 32 asked for: 46 fit. The block's eighth step starts at
      // 42, past where a lone step would wait.
      await steps.reserve("the block", 32, () => fetching(steps, "block", Array(8).fill(4)));
      // 46 spent and 20 asked for: a wait first.
      await steps.reserve("the second block", 20, () => fetching(steps, "second", [10, 10]));
    });
    expect(r.error).toBeNull();
    expect(r.engine.sleeps.map((s) => s.name)).toEqual([
      "fresh invocation before the second block",
    ]);
    const block = r.engine.ran.filter((s) => s.name.startsWith("block "));
    expect(block.map((s) => s.invocation)).toEqual(Array(8).fill(0));
    expect(r.engine.invocations).toEqual([46, 20]);
  });

  it("runs a block too big for one invocation a step at a time", async () => {
    const r = await runSteps(async (steps) => {
      await steps.reserve("the block", 60, () => fetching(steps, "block", Array(6).fill(10)));
    });
    expect(r.error).toBeNull();
    expect(Math.max(...r.engine.invocations)).toBeLessThanOrEqual(50);
    expect(r.engine.invocations.length).toBe(2);
  });

  it("keeps a live health check's probes in one invocation", async () => {
    let probes = 0;
    const answers: FetchLike = async (input) => {
      if (!input.startsWith("https://cut.")) return new Response("ok");
      probes += 1;
      return probes <= 2 ? new Response("down", { status: 503 }) : new Response("up");
    };
    let status: string | null = null;
    const r = await runSteps(
      async (steps, step) => {
        await fetching(steps, "before", [7, 7, 7, 7, 7]);
        // 35 spent: twelve probes of up to two requests would not fit.
        const health = await checkLiveHealthPhase(
          steps,
          step,
          "https://cut.appflare-dev.workers.dev/",
        );
        status = health.status;
      },
      { fetch: answers },
    );
    expect(r.error).toBeNull();
    expect(status).toBe("verified");
    expect(r.engine.sleeps[0]?.name).toBe("fresh invocation before health check");
    const checks = r.engine.ran.filter((s) => s.name.startsWith("health check "));
    expect(checks.map((s) => s.invocation)).toEqual([1, 1, 1]);
  });
});

describe("a step that runs out inside a job unit", () => {
  it("fails the job as before: the unit's allowance is its own", async () => {
    const units = {
      countCronTriggers: async () => {
        throw new Error(TOO_MANY_SUBREQUESTS);
      },
    } as unknown as JobUnitsApi;
    const r = await runJob([7, 1], { units });
    expect(String(r.error)).toContain("Too many subrequests");
    expect(String(r.error)).not.toContain(OWN_LIMIT_NOTE);
    expect(r.engine.sleeps).toEqual([]);
    expect(r.engine.ran.some((s) => s.name.endsWith("(again)"))).toBe(false);
  });
});

describe("bindings a job calls directly", () => {
  it("counts each call to SANDBOX and JOBS, failed ones too, in the run's budget", async () => {
    const created: string[] = [];
    const sandbox = {
      fetch: async () => new Response("object"),
      info: async () => ({ version: "1" }),
      cleanup: async () => {
        throw new Error("refused");
      },
    };
    const jobs = {
      create: async (options: { id: string }) => {
        created.push(options.id);
        return { id: options.id };
      },
    };
    let spent: number[] = [];
    const handler: JobHandler = async (ctx) => {
      const steps = createJobSteps(ctx, JOB);
      steps.setAccountId(ACC);
      spent = [];
      await steps.run("call the bindings", async () => {
        const binding = sandboxBinding(ctx.env);
        if (binding === undefined) throw new Error("no SANDBOX");
        await binding.fetch("https://sandbox.appflare.internal/object");
        spent.push(steps.invocation.spent);
        await binding.info();
        await binding.cleanup({}).catch(() => null);
        spent.push(steps.invocation.spent);
        await ctx.env.JOBS?.create({ id: "next", params: { kind: "reconfigure", jobId: "next" } });
        spent.push(steps.invocation.spent);
        return {};
      });
      // A second step runner of the same run shares the count.
      spent.push(createJobSteps(ctx, JOB).invocation.spent);
    };
    await runJobOf(
      { kind: "install", jobId: JOB },
      fakeEngine().step,
      { DB: env.DB, CF_API_TOKEN: TOKEN, SANDBOX: sandbox, JOBS: jobs },
      { ...JOB_HANDLERS, install: handler },
    );
    expect(spent).toEqual([1, 3, 4, 4]);
    expect(created).toEqual(["next"]);
  });
});
