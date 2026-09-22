import type { HttpApi } from "../http";
import type { TokenVerifyResult } from "../types";

/** Token verification. */
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
