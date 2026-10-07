import type { HttpApi } from "../http";
import type { AccountDetails } from "../types";

/** `GET /accounts` pages at most 50 accounts per page. */
const ACCOUNTS_PER_PAGE = 50;

/** The account the client is bound to, and the accounts its credential reaches. */
export function createAccounts(http: HttpApi) {
  return {
    /**
     * `GET /accounts/{id}`: the account's details, its name among them.
     * Cloudflare accepts any one of many account permissions for it, Workers
     * Scripts Read included.
     */
    get(): Promise<AccountDetails> {
      return http.result("GET", http.acct(""));
    },

    /**
     * `GET /accounts`: every account the credential can reach, whatever
     * account the client is bound to (a client made only for this call may be
     * bound to none). At most `maxPages` pages of 50 are read.
     */
    async list(opts: { maxPages?: number } = {}): Promise<AccountDetails[]> {
      const maxPages = opts.maxPages ?? 20;
      const out: AccountDetails[] = [];
      for (let page = 1; page <= maxPages; page++) {
        const envelope = await http.send("GET", "/accounts", {
          query: { page, per_page: ACCOUNTS_PER_PAGE },
        });
        const rows = Array.isArray(envelope.result) ? (envelope.result as AccountDetails[]) : [];
        out.push(...rows);
        const total = envelope.result_info?.total_pages;
        if (rows.length === 0 || total === undefined || page >= total) break;
      }
      return out;
    },
  };
}
