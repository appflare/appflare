import type { HttpApi } from "../http";
import type { AccountSubscription } from "../types";

/** Cloudflare refuses a larger `per_page` on the subscriptions list (code 1196). */
export const SUBSCRIPTIONS_MAX_PER_PAGE = 50;

export interface SubscriptionsPage {
  items: AccountSubscription[];
  /** From `result_info`; 1 when the answer carries none. */
  totalPages: number;
}

/**
 * The account's billing subscriptions. Needs the "Billing: Read" permission;
 * without it Cloudflare answers 403 with code 10000 ("Authentication error").
 */
export function createBilling(http: HttpApi) {
  return {
    /**
     * `GET /accounts/{id}/subscriptions?page=&per_page=`: ONE page. The list
     * holds one entry per product plan (Workers Paid is `rate_plan.id`
     * `workers_paid`) and one per zone plan (`rate_plan.scope` `zone`).
     */
    async listSubscriptionsPage(
      opts: { page?: number; perPage?: number } = {},
    ): Promise<SubscriptionsPage> {
      const envelope = await http.send("GET", http.acct("/subscriptions"), {
        query: { page: opts.page, per_page: opts.perPage ?? SUBSCRIPTIONS_MAX_PER_PAGE },
      });
      // An answer without the list must not read as "no subscriptions".
      if (!Array.isArray(envelope.result)) {
        throw Object.assign(new Error("the subscriptions answer holds no list"), {
          name: "UnreadableSubscriptions",
        });
      }
      return {
        items: envelope.result as AccountSubscription[],
        totalPages: envelope.result_info?.total_pages ?? 1,
      };
    },
  };
}
