import type { FetchLike } from "@appflare/cf-api";

/**
 * Every request the installer answers stays within 40 subrequests, so it fits
 * the 50 a Worker invocation may make on Workers Free with room to spare.
 * Each outgoing fetch (Cloudflare API, GitHub, the new manager) goes through
 * one budgeted fetch per request; a redirect is followed by hand, so every
 * hop is counted. Steps are sized to stay well below the limit; the budget
 * is the guard that makes a mistake fail loudly instead of hitting the
 * platform's limit half way through a change.
 */

export const REQUEST_SUBREQUESTS = 40;

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
}

export class Budget {
  used = 0;
  constructor(readonly limit: number = REQUEST_SUBREQUESTS) {}

  get remaining(): number {
    return this.limit - this.used;
  }

  take(): void {
    if (this.used >= this.limit) {
      throw new BudgetExceededError(`more than ${this.limit} subrequests in one request`);
    }
    this.used += 1;
  }
}

export function budgetedFetch(inner: FetchLike, budget: Budget): FetchLike {
  return async (input, init) => {
    budget.take();
    return inner(input, init);
  };
}
