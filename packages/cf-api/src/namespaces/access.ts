import type { HttpApi } from "../http";
import type { AccessApp, AccessCerts, AccessPolicy } from "../types";

const enc = encodeURIComponent;

/**
 * Cloudflare Access (used only by the manager's
 * optional Access hardening toggle). Request bodies are passed
 * through so app/policy shapes stay flexible.
 */
export function createAccess(http: HttpApi) {
  return {
    /** `POST /access/apps`. */
    createApp(app: Record<string, unknown>): Promise<AccessApp> {
      return http.result("POST", http.acct("/access/apps"), { json: app });
    },

    /** `DELETE /access/apps/{id}`. */
    deleteApp(appId: string): Promise<unknown> {
      return http.result("DELETE", http.acct(`/access/apps/${enc(appId)}`));
    },

    /** `POST /access/apps/{id}/policies`. */
    createPolicy(appId: string, policy: Record<string, unknown>): Promise<AccessPolicy> {
      return http.result("POST", http.acct(`/access/apps/${enc(appId)}/policies`), {
        json: policy,
      });
    },

    /**
     * `GET /accounts/{id}/access/certs`. Note: the keys used to verify the
     * `Cf-Access-Jwt-Assertion` header are normally fetched from the team-domain
     * JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`); this
     * account-scoped path is the one this client exposes.
     */
    getCerts(): Promise<AccessCerts> {
      return http.result("GET", http.acct("/access/certs"));
    },
  };
}
