import type { HttpApi } from "../http";
import type { ContainerApplication } from "../types";

/** Cloudflare Containers. */
export function createContainers(http: HttpApi) {
  return {
    /**
     * `GET /containers/applications[?name=]`: the account's container
     * applications, filtered by name on the server. On an account without
     * Workers Paid Cloudflare answers 401 (code 1000, "…requires the Workers
     * Paid plan…"); a token without a Containers permission gets 403 (code
     * 10000) first, whatever the plan.
     */
    async listApplications(opts: { name?: string } = {}): Promise<ContainerApplication[]> {
      const result = await http.result<unknown>("GET", http.acct("/containers/applications"), {
        query: { name: opts.name },
      });
      return Array.isArray(result) ? (result as ContainerApplication[]) : [];
    },
  };
}
