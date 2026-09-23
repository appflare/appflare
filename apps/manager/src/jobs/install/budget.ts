import { ARTIFACT_FETCH_SUBREQUESTS, FREE_PLAN_SUBREQUESTS } from "@appflare/schema";

/**
 * Subrequest accounting helpers. Workers Free allows 50 subrequests per
 * invocation, and every hop of a redirect chain counts
 * (developers.cloudflare.com/workers/platform/limits, "Subrequests"). Every
 * step of a Workflow instance runs in the same invocation until a sleep of
 * several minutes, so short sleeps and step boundaries never reset the count;
 * work that makes many subrequests runs in job units instead (./units), each
 * in an invocation of its own.
 */

/** Subrequests one `fetch` used: the request plus a hop when it was redirected. */
export function fetchCost(response: Pick<Response, "redirected">): number {
  return response.redirected ? 2 : 1;
}

/**
 * Worst-case cost of one artifact Range fetch (GitHub release assets redirect
 * once). Shared with the packer's module limit (`MAX_WORKER_MODULES`), which
 * the install, update, and self-update jobs check before any upload.
 */
export const ARTIFACT_FETCH_COST = ARTIFACT_FETCH_SUBREQUESTS;

/**
 * Whether `error` is the runtime refusing a subrequest because the invocation
 * used up its limit ("Too many subrequests by single Worker invocation").
 * Looks through `cause` too, since callers wrap fetch errors.
 */
export function isSubrequestLimitError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e != null && depth < 5; depth++) {
    const message = e instanceof Error ? e.message : String(e);
    if (/too many subrequests/i.test(message)) return true;
    e = e instanceof Error ? e.cause : undefined;
  }
  return false;
}

/**
 * The job's message for a subrequest-limit failure. A retry would make the
 * same requests (in the job's invocation, or in a unit's), so it would hit the
 * same limit; the step fails for good with this explanation instead.
 */
export function subrequestLimitMessage(message: string): string {
  return `${message.replace(/\s*To configure this limit.*$/s, "").trim()} Cloudflare allows ${FREE_PLAN_SUBREQUESTS} subrequests per Worker invocation on the free plan, and a retry would make the same requests and hit the same limit, so the job stopped instead of retrying.`;
}
