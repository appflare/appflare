import type { HttpApi } from "../http";
import type { TokenVerifyResult } from "../types";

/**
 * API token verification. Both endpoints verify API tokens only: an OAuth
 * access token (a Cloudflare sign-in) gets 401, code 1000, "Invalid API
 * Token", from each (seen live, 2026-10-06), however valid it is. Confirm a
 * sign-in by a read it is allowed to make instead.
 */
export function createTokens(http: HttpApi) {
  return {
    /** `GET /accounts/{id}/tokens/verify` — for account-owned tokens. */
    verify(): Promise<TokenVerifyResult> {
      return http.result("GET", http.acct("/tokens/verify"));
    },
    /** `GET /user/tokens/verify` — for user-owned tokens. */
    verifyUserToken(): Promise<TokenVerifyResult> {
      return http.result("GET", "/user/tokens/verify");
    },
  };
}
