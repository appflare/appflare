import type { FetchLike } from "@appflare/cf-api";
import type { UnitEnv, UnitResult } from "../jobs/units/result";
import { createJobUnits, type JobUnitName, type JobUnitsApi } from "../jobs/units/units";

/**
 * Test-only stand-in for the `SELF` service binding: runs each job unit in
 * this process against the test's fake fetch, the way the `JobUnits`
 * entrypoint runs it in its own invocation. Inputs and results are
 * structured-cloned like RPC arguments and results, so a value that could not
 * cross an RPC call fails the test. Records every call and the subrequests
 * it made, counted independently of the unit's own count.
 *
 * The real binding is exercised in units/entrypoint.test.ts; job tests use
 * this fake because a real RPC call runs the unit with the global `fetch`,
 * which cannot reach the tests' fake Cloudflare API.
 */

export interface FakeSelfCall {
  unit: JobUnitName;
  /** Subrequests the call made (a followed redirect counts two). */
  subrequests: number;
  /** What the unit reported about itself. */
  reported: number;
  ok: boolean;
}

export interface FakeSelf extends JobUnitsApi {
  calls: FakeSelfCall[];
}

export function fakeSelf(
  env: UnitEnv,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): FakeSelf {
  const calls: FakeSelfCall[] = [];
  const inner: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));

  async function call<T>(unit: JobUnitName, input: unknown): Promise<UnitResult<T>> {
    let subrequests = 0;
    const counting: FetchLike = async (url, init) => {
      try {
        const response = await inner(url, init);
        subrequests += response.redirected ? 2 : 1;
        return response;
      } catch (error) {
        subrequests += 1;
        throw error;
      }
    };
    const units = createJobUnits(env, { ...deps, fetch: counting });
    const run = units[unit] as (input: unknown) => Promise<UnitResult<T>>;
    const result = await run(structuredClone(input));
    calls.push({ unit, subrequests, reported: result.subrequests, ok: result.ok });
    return structuredClone(result);
  }

  return {
    calls,
    uploadAssetPart: (input) => call("uploadAssetPart", input),
    uploadWorker: (input) => call("uploadWorker", input),
    applyD1Migration: (input) => call("applyD1Migration", input),
    emptyR2Page: (input) => call("emptyR2Page", input),
    inspectEmailRouting: (input) => call("inspectEmailRouting", input),
  };
}
