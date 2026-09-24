import type { HttpApi } from "../http";
import type { AccountDetails } from "../types";

/** The account the client is bound to. */
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
  };
}
