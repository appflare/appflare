import type { FetchLike } from "@appflare/cf-api";
import { createJobUnits, type JobUnitsApi } from "./units";

/*
 * What still runs in the job's own invocation.
 *
 * Every step of a Workflow instance runs in one Worker invocation until a
 * sleep of several minutes, so a whole job shares one subrequest limit (50 on
 * Workers Free): step boundaries, retries, and the short sleeps between health
 * probes do not reset it. Units move the heavy work out, but each unit call
 * still costs the job one subrequest, and so does everything a job does
 * itself. Per job, in the job's invocation:
 *
 *   - 1 per unit call: each asset part, the Worker upload, each D1 migration
 *     file, each R2 page;
 *   - 1 per Cloudflare API step: token check, script list, each resource's
 *     check and create (2 or more), each Workflow name check, the assets
 *     session, d1_migrations create and list per database, each secret, the
 *     cron triggers, the subdomain lookup and route, snapshot reads and
 *     bookmarks and the promotion (updates);
 *   - 1 per health or canary probe (up to 12 probes for the live check, 6 for
 *     an app's canary, 10 for Appflare's own);
 *   - the manifest and signature (4 with the release redirects) and KV reads;
 *   - D1: each step's log write and job updates. D1 binding calls did not
 *     count toward the limit when this was measured, but plan as if they do.
 *
 * Worked example, an install with a KV namespace, a D1 database with 3
 * migrations, 2 asset parts, 2 secrets and a cron: manifest 4 + token 1 +
 * script list 1 + resources 2 x 2 + assets session 1 + parts 2 + upload 1 +
 * D1 table and list 2 + migrations 3 + secrets 2 + cron 1 + subdomain 2 +
 * health 1 to 12 = 26 to 37 fetches, plus about 25 D1 calls. That fits; an
 * app with a dozen resources, many migrations, and a slow first health check
 * can still pass 50 and fail with "Too many subrequests". Splitting a job
 * further means a unit that calls further units itself (the callee has `SELF`
 * too), or a sleep of 5 minutes or more, which does start a fresh invocation.
 */

/**
 * Which way a job reaches its units. With the `SELF` service binding every
 * unit call is an RPC call into a fresh invocation of this Worker, with its
 * own subrequest limit, and costs the job one subrequest. A manager deployed
 * before the binding existed has no `SELF`: it runs the same units in the
 * job's own invocation, which is what lets it update itself to a version
 * that adds the binding.
 */
export interface JobUnitsAccess {
  api: JobUnitsApi;
  /** True when units run in their own invocations (over `SELF`). */
  remote: boolean;
}

export interface UnitsEnv {
  SELF?: JobUnitsApi;
  CF_API_TOKEN?: string;
  CF_API_BASE_URL?: string;
  GITHUB_TOKEN?: string;
}

export function jobUnits(
  env: UnitsEnv,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): JobUnitsAccess {
  if (env.SELF !== undefined) return { api: env.SELF, remote: true };
  return { api: createJobUnits(env, deps), remote: false };
}

/**
 * The `SELF` binding of the Worker's env as the jobs use it, or undefined
 * when this deployment has none. The generated binding type wraps every RPC
 * result in stub types; the entrypoint returns plain data (strings, numbers,
 * booleans, arrays and objects of them), which arrives as the same plain data.
 */
export function selfUnits(env: { SELF?: unknown }): JobUnitsApi | undefined {
  const self: unknown = env.SELF;
  return self === undefined || self === null ? undefined : (self as JobUnitsApi);
}
