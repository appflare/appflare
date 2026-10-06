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
 *     files; the call itself makes 2 + 2 + 1 per file), each call that runs
 *     D1 schema files and each that applies post-deploy migrations (one
 *     each per database that has them), each R2 page, the
 *     Email Routing check, the cron trigger count (for an app with cron
 *     triggers, unless the account is known to be on Workers Paid);
 *   - 1 when a manager connected with OAuth renews its access token (at most
 *     once per invocation, since a token lasts an hour; up to 3 when
 *     Cloudflare's token endpoint answers with a temporary error, and 1 more
 *     when the API refused the token and the request is sent again), counted
 *     where it happens: with the job's own requests, or with a unit's
 *     (../../cloudflare/connection.server.ts). A job that spreads over
 *     invocations keeps room for one in each (`RENEWAL_SUBREQUESTS` in
 *     ../invocation-budget.ts); a job of one Worker has it in the margin of
 *     the worked example below;
 *   - 1 per Cloudflare API step: token check, script list, each resource's
 *     check and create (2 or more), each Workflow name check and the call
 *     that creates or updates each Workflow (install, update, rollback), the R2 check,
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
 *   - for an install protected with Cloudflare Access: the application
 *     before the first upload and its switch to the app's Workers after the
 *     last (1 each as unit calls; about 7 requests each in the unit's own
 *     invocation); and the first probe of a health check that gets Access's
 *     sign-in is sent once more with the app's service token (2 for that
 *     attempt), while later attempts of the same check, once the token was
 *     let through, send it straight away (1 each). The token is looked up
 *     once per check, from D1, plus the account's zone list for a custom
 *     domain;
 *   - for a build or installer run in the sandbox Worker (paid tiers): the
 *     wait for the sandbox Worker to settle, 1 per attempt of the unit
 *     `settleSandbox` (at most 2), which reads the deployment and asks the
 *     sandbox Worker up to 30 times in its own invocation; without `SELF` it
 *     runs here, once, at 1 read plus up to 10 `info()` calls (11); plus the
 *     `info()` call of each "check sandbox Worker" step, and the run itself;
 *   - for an install that replaces one that did not finish ("Install
 *     again"): the wait for that install's removal, 1 D1 query per poll plus
 *     1 log write for each poll that copies lines; polls 5, 10, 20 and 40
 *     seconds apart see a removal of a few resources at the first or second
 *     (2 to 4), at most 10 before the polls move 5 minutes apart, a sleep
 *     that resumes in a fresh invocation (../install/cleanup-wait.ts);
 *   - 1 for the "notify channels" call at the end of an install, update or
 *     uninstall, when a notification channel exists (none without `SELF`);
 *   - the manifest and signature (4 with the release redirects) and KV reads;
 *   - D1: each step's log write (one batch per step, however many lines a
 *     unit brought back) and job updates; each step that stores or deletes
 *     a self-deploying app's secret on the sandbox Worker also reads the job
 *     log once (whether this job already did it). D1 and KV binding calls
 *     do not count toward the limit (measured again 2026-10-06, see
 *     ../invocation-budget.ts), but are listed in case that changes.
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
 *
 * An app of several Workers (../entry-workers.ts) shares its resources, so
 * each Worker besides the primary one adds only its own calls: at install
 * its assets session and parts (2 for assets in one part), the upload unit
 * (1), its workers.dev route (1) and one per secret it gets (typically 2):
 * about 6. An update adds its deployment read (1), assets (2), the version
 * upload (1), previews (1), the canary (1 when the preview answers at once,
 * up to 6) and the promotion (1): 7 or more. A typical app (three resources,
 * two secrets, assets in one part, a D1 database) spends about 21 before its
 * live health check, which takes 1 to 12: 50 - 21 - 12 leaves 17, room for
 * two other Workers at an update's 7 each. A job of more Workers on Workers
 * Free therefore spreads its steps over several invocations: it counts what
 * its invocation has made, and before a step that might not fit it sleeps 5
 * minutes, which resumes it in a fresh invocation with a new 50
 * (../invocation-budget.ts). Workers Paid allows 10,000 subrequests per
 * invocation and 10,000 steps per Workflow instance by default; there the
 * plans total what the app's Workers add (../entry-budget.ts) and refuse a
 * job that would not fit, which no entry of up to `MAX_ENTRY_WORKERS`
 * Workers comes near.
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
  CF_GRANT_KEY?: string;
  CF_API_BASE_URL?: string;
  GITHUB_TOKEN?: string;
  /** The manager's D1 and auth secret, for units run in place that read them (Access). */
  DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
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
