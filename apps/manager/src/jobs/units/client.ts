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
 *   - 1 per unit call: each asset part, the Worker upload, each call that
 *     applies D1 migrations (one per database for up to about 30 small
 *     files; the call itself makes 2 + 2 + 1 per file), each R2 page, the
 *     Email Routing check, the cron trigger count (for an app with cron
 *     triggers, unless the account is known to be on Workers Paid);
 *   - 1 per Cloudflare API step: token check, script list, each resource's
 *     check and create (2 or more), each Workflow name check, the R2 check,
 *     the assets session, each secret, the cron triggers, each queue
 *     consumer, the subdomain lookup and route, snapshot reads and
 *     bookmarks and the promotion (updates); for an app that receives email,
 *     turning Email Routing on, each routing rule and the catch-all (1 each,
 *     2 on a retried step), and on uninstall each route (1 to 4);
 *   - 1 per health or canary probe (up to 12 probes for the live check, 6 for
 *     an app's canary, 10 for Appflare's own);
 *   - for an install that asked for a domain: the attach and the wait for
 *     it (1 each as unit calls), and turning workers.dev off once the app
 *     answers through it (1);
 *   - for a build or installer run in the sandbox Worker (paid tiers): the
 *     wait for the sandbox Worker to settle, 1 per attempt of the unit
 *     `settleSandbox` (at most 2), which reads the deployment and asks the
 *     sandbox Worker up to 30 times in its own invocation; without `SELF` it
 *     runs here, once, at 1 read plus up to 10 `info()` calls (11); plus the
 *     `info()` call of each "check sandbox Worker" step, and the run itself;
 *   - 1 for the "notify channels" call at the end of an install, update or
 *     uninstall, when a notification channel exists (none without `SELF`);
 *   - the manifest and signature (4 with the release redirects) and KV reads;
 *   - D1: each step's log write (one batch per step, however many lines a
 *     unit brought back) and job updates; each step that stores or deletes
 *     a self-deploying app's secret on the sandbox Worker also reads the job
 *     log once (whether this job already did it). D1 binding calls did not
 *     count toward the limit when this was measured, but plan as if they do.
 *
 * Worked example, FlareMo: a D1 database with 30 migrations, an R2 bucket,
 * 2 queues with a consumer each, 2 Vectorize indexes, a rate limit, 3 asset
 * parts, 2 secrets and a cron. Manifest 4 + token 1 + script list 1 + R2
 * check 1 + cron count 1 + resources 6 x 2 + assets session 1 + parts 3 +
 * upload 1 + migrations 1 + secrets 2 + cron 1 + consumers 2 + subdomain 2 =
 * 33, plus health 1 to 12: 34 to 45 fetches, 5 to 16 under 50. With one call per
 * migration file it was 30 calls plus the table and list steps, 64 to 75,
 * which is how it failed at the 24th file. What still grows with an app is
 * its resources (2 each) and its secrets (1 each); an app with many more of
 * them can still pass 50 and fail with "Too many subrequests". Splitting a
 * job further means a unit that calls further units itself (the callee has
 * `SELF` too), or a sleep of 5 minutes or more, which does start a fresh
 * invocation.
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
  deps: { fetch?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
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
