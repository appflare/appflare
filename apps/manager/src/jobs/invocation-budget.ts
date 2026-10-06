import type { FetchLike } from "@appflare/cf-api";
import { FREE_PLAN_SUBREQUESTS } from "@appflare/schema";
import type { JobUnitName, JobUnitsApi } from "./units/units";

/**
 * How a job of an app of several Workers spreads its requests over Worker
 * invocations on Workers Free.
 *
 * A job is one Workflow instance, and Workers Free allows 50 subrequests per
 * Worker invocation (developers.cloudflare.com/workflows/reference/limits:
 * "50/request"). The instance runs its steps back to back in one invocation
 * until it sleeps for a long time; the invocation that resumes it starts
 * with a fresh 50. Measured 2026-10-06 on a Workers Free account with a
 * Workflow that made `fetch` calls to a public URL in its steps:
 *
 *   - one step of 60 fetches: the 51st failed ("Too many subrequests by
 *     single Worker invocation"); two steps of 30 in a row: 30, then 20;
 *   - a `step.sleep` of 1 minute, 4 minutes or 4 minutes 30 seconds between
 *     steps of 40: the second got 10, so the sleep kept the invocation;
 *   - a `step.sleep` of 5 minutes: the second got all 40, in a new
 *     invocation; three steps of 45 with two 5-minute sleeps between them
 *     made 135 fetches in one instance, so the limit is per invocation, not
 *     per instance;
 *   - a step retried after a 1-minute or a 5-minute delay: the retry ran in
 *     the same invocation and got none;
 *   - `step.waitForEvent` timing out after 10 seconds or 1 minute, an event
 *     the instance sent itself before waiting, and one sent 65 seconds into
 *     a wait: all in the same invocation;
 *   - 60 D1 queries, 60 D1 batches or 60 KV reads in one step, then 50
 *     fetches: all succeeded, so D1 and KV binding calls do not count; a
 *     Workflow binding's `get()` counts one each;
 *   - module state survived into the next invocation (same isolate), so the
 *     count lives with each run of the job, never in module scope;
 *   - a step that failed for good gave the same error, not a new run of its
 *     body, when the instance came back to it in a later invocation.
 *
 * So the one way to a fresh budget is a sleep of 5 minutes. A job that may
 * make more requests than one invocation allows counts what its invocation
 * has made ({@link InvocationBudget}: fetches, with a followed redirect
 * counting two, and calls to job units, one each) and, before a step that
 * might not fit, sleeps 5 minutes first. Steps record their results, so the
 * invocation that resumes the job replays everything before the sleep
 * without making a request and goes on from there with the full 50.
 *
 * Only jobs of apps of several Workers on an account not known to be on
 * Workers Paid do this (Workers Paid allows 10,000 per invocation); a job of
 * one Worker fits one invocation as it always has (./units/client.ts).
 */

/** A sleep that resumes the job in a fresh invocation (measured above: 4 min 30 s does not). */
export const FRESH_INVOCATION_SLEEP = "5 minutes";

/**
 * The most subrequests one step of a job is planned to make: a Cloudflare
 * API call or two, a unit call, or a health probe sent again with an Access
 * service token after the account's zone list was read for it (3). A step
 * starts in a fresh invocation unless this much is left.
 */
export const STEP_SUBREQUESTS = 8;

/**
 * Subrequests kept for work that runs outside steps: the notification at
 * the job's end (a unit call) and the settings change an install may start
 * afterwards (a Workflow binding call).
 */
export const OUTSIDE_STEPS_SUBREQUESTS = 4;

/**
 * Kept for renewing the manager's OAuth access token, which any Cloudflare
 * call of any step may do when the token is about to run out: one request to
 * the token endpoint (../cloudflare/connection.server.ts). A token lasts an
 * hour, so one invocation renews it once at most. Kept on every job, since
 * a job does not know which connection it will meet when it plans.
 */
export const RENEWAL_SUBREQUESTS = 1;

/** What one invocation may have spent before a step and still run it: 37. */
export const SPEND_BEFORE_STEP =
  FREE_PLAN_SUBREQUESTS - OUTSIDE_STEPS_SUBREQUESTS - RENEWAL_SUBREQUESTS - STEP_SUBREQUESTS;

/** The most one block of steps may reserve to run in one invocation: 45. */
export const MAX_RESERVE = FREE_PLAN_SUBREQUESTS - OUTSIDE_STEPS_SUBREQUESTS - RENEWAL_SUBREQUESTS;

/**
 * The subrequests this invocation of a job has made, and whether the job
 * spreads its steps over invocations. One per run of the job: a resumed job
 * runs from the top in a new invocation and starts at zero.
 */
export class InvocationBudget {
  #spent = 0;
  #spreading = false;
  #holding = false;

  /** Subrequests made so far in this invocation. */
  get spent(): number {
    return this.#spent;
  }

  /** Whether the job sleeps for a fresh invocation when its steps need one. */
  get spreading(): boolean {
    return this.#spreading;
  }

  /** Counts subrequests this invocation made. */
  add(count = 1): void {
    this.#spent += count;
  }

  /** From now on, the job's steps start in a fresh invocation when this one may not fit them. */
  spread(): void {
    this.#spreading = true;
  }

  /** Whether a block of steps holds the invocation: its steps never wait between them. */
  get holding(): boolean {
    return this.#holding;
  }

  /** Whether the next step should wait for a fresh invocation. */
  needsFresh(): boolean {
    return this.#spreading && !this.#holding && this.#spent > SPEND_BEFORE_STEP;
  }

  /**
   * Whether a block of steps planned to make `need` requests should wait for
   * a fresh invocation before it starts: it would not fit what is left of
   * this one, and fits a fresh one. A block too big for any invocation runs
   * without holding it, a step at a time.
   */
  needsFreshFor(need: number): boolean {
    return (
      this.#spreading &&
      !this.#holding &&
      need <= MAX_RESERVE &&
      this.#spent > 0 &&
      this.#spent + need > MAX_RESERVE
    );
  }

  /** Whether a block of `need` requests can hold the invocation (it fits one). */
  canHold(need: number): boolean {
    return this.#spreading && !this.#holding && need <= MAX_RESERVE;
  }

  /** While true, the steps run back to back without waiting for a fresh invocation. */
  hold(on: boolean): void {
    this.#holding = on;
  }

  /**
   * Whether this invocation itself ran out: the runtime refuses the request
   * past the limit, which is counted too. A unit that ran out of its own
   * invocation's allowance leaves this one well under it.
   */
  exhausted(): boolean {
    return this.#spent > FREE_PLAN_SUBREQUESTS;
  }

  /** The job carries on in a fresh invocation. */
  fresh(): void {
    this.#spent = 0;
  }

  /** `inner`, counting each request (two for a followed redirect, one for a failure). */
  countingFetch(inner: FetchLike): FetchLike {
    return async (input, init) => {
      try {
        const response = await inner(input, init);
        this.add(response.redirected ? 2 : 1);
        return response;
      } catch (error) {
        this.add(1);
        throw error;
      }
    };
  }
}

/** Every job unit by name, so {@link countedUnits} cannot miss one added later. */
const UNIT_NAMES: Record<JobUnitName, true> = {
  uploadAssetPart: true,
  uploadWorker: true,
  applyD1Migrations: true,
  applyD1Schema: true,
  applyD1Baseline: true,
  seedD1: true,
  emptyR2Page: true,
  inspectEmailRouting: true,
  countCronTriggers: true,
  settleSandbox: true,
  attachDomain: true,
  waitForExternalDomain: true,
  waitForCustomDomain: true,
  waitForSandboxContainers: true,
  setSandboxBinding: true,
  protectInstall: true,
  syncInstallAccess: true,
  unprotectInstall: true,
  releaseAppAccess: true,
};

/**
 * The job units over `SELF`, each call counted as the one subrequest it
 * costs the job (the unit's own requests are its invocation's).
 */
export function countedUnits(api: JobUnitsApi, onCall: () => void): JobUnitsApi {
  const methods = api as unknown as Record<JobUnitName, (input: unknown) => unknown>;
  const counted: Partial<Record<JobUnitName, unknown>> = {};
  for (const name of Object.keys(UNIT_NAMES) as JobUnitName[]) {
    counted[name] = (input: unknown) => {
      onCall();
      // Called as a method of the binding (never through `.call`, which an
      // RPC stub would read as a remote property).
      return methods[name](input);
    };
  }
  return counted as JobUnitsApi;
}

/**
 * A binding the job calls directly (the sandbox Worker's `SANDBOX`, the job
 * Workflow `JOBS`), each call counted before it is made as the one
 * subrequest it costs the job, failed ones too. A Workflow binding's `get()`
 * measured at one; a service binding call or `fetch` is one, like a unit
 * call. Only the binding's own methods are counted: what they return (a
 * Workflow instance) is not wrapped, and the jobs only start Workflows.
 */
export function countedBinding<T extends object>(binding: T, budget: InvocationBudget): T {
  return new Proxy(binding, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof prop === "symbol" || prop === "then" || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        budget.add(1);
        const method = (target as Record<string, ((...a: unknown[]) => unknown) | undefined>)[prop];
        if (method === undefined) throw new TypeError(`${prop} is not a function`);
        // Called on the binding, as RPC stubs need, and never through
        // `.apply`, which a stub would read as a remote property.
        return Reflect.apply(method, target, args);
      };
    },
  });
}

/**
 * The job's env with the bindings it calls directly counted against `budget`
 * ({@link countedBinding}). `SELF` stays as it is: the step runner counts
 * its unit calls itself.
 */
export function countedEnv<E extends { SANDBOX?: unknown; JOBS?: unknown }>(
  env: E,
  budget: InvocationBudget,
): E {
  const wrap = (binding: unknown) =>
    typeof binding === "object" && binding !== null ? countedBinding(binding, budget) : binding;
  return {
    ...env,
    ...(env.SANDBOX === undefined ? {} : { SANDBOX: wrap(env.SANDBOX) }),
    ...(env.JOBS === undefined ? {} : { JOBS: wrap(env.JOBS) }),
  };
}
