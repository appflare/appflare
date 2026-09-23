import { ARTIFACT_FETCH_SUBREQUESTS, FREE_PLAN_SUBREQUESTS } from "@appflare/schema";

/**
 * Subrequest budgeting for Workflow invocations.
 *
 * Workers Free allows 50 subrequests per invocation, and every hop of a redirect
 * chain counts (developers.cloudflare.com/workers/platform/limits, "Subrequests").
 * Workflow steps that succeed run back-to-back in ONE invocation; only a
 * `step.sleep` (or a retry) starts a fresh one. So before a phase that would take
 * the running count past {@link SUBREQUEST_BUDGET}, the job sleeps for a second.
 *
 * The count lives in a local variable of the job's `run`, fed from each step's
 * return value (`subrequests`), never in module state: on replay, completed
 * steps return their recorded counts, so the same sleeps happen at the same
 * places, and the estimate can only err on the high side.
 */

/** Stay well under the free plan's 50 so estimates that run short still fit. */
export const SUBREQUEST_BUDGET = 40;

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
 * The job's message for a subrequest-limit failure. Workflows retries a step
 * inside the same invocation, so a retry would hit the same limit at once;
 * the step fails for good with this explanation instead.
 */
export function subrequestLimitMessage(message: string): string {
  return `${message.replace(/\s*To configure this limit.*$/s, "").trim()} Cloudflare allows ${FREE_PLAN_SUBREQUESTS} subrequests per Worker invocation on the free plan, and a retry would run in the same invocation and hit the same limit, so the job stopped instead of retrying.`;
}

export class SubrequestBudget {
  #used = 0;
  #boundaries = 0;

  constructor(private readonly limit: number = SUBREQUEST_BUDGET) {}

  get used(): number {
    return this.#used;
  }

  /**
   * Whether a phase estimated at `cost` subrequests must start in a fresh
   * invocation. A phase that alone exceeds the limit still gets a fresh one.
   */
  needsBoundary(cost: number): boolean {
    return this.#used > 0 && this.#used + cost > this.limit;
  }

  /** Records a boundary (after the caller slept) and returns its 1-based ordinal. */
  boundary(): number {
    this.#used = 0;
    this.#boundaries += 1;
    return this.#boundaries;
  }

  /** Any other `step.sleep` (health-check waits) also starts a fresh invocation. */
  reset(): void {
    this.#used = 0;
  }

  /** Adds what a finished step reported. */
  add(subrequests: number): void {
    this.#used += subrequests;
  }
}
