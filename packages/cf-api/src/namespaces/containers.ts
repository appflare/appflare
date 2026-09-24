import type { HttpApi } from "../http";
import type {
  ContainerApplication,
  ContainerRollout,
  CreateContainerApplicationArgs,
  CreateContainerRolloutArgs,
  ModifyContainerApplicationArgs,
} from "../types";

const enc = encodeURIComponent;

/**
 * Cloudflare Containers: the container applications that back a Worker's
 * container-enabled Durable Object classes, and their rollouts. Paths and
 * bodies follow wrangler 4.136.2's Containers client
 * (`packages/containers-shared/src/client/services/ApplicationsService.ts`
 * and `RolloutsService.ts` in cloudflare/workers-sdk), whose base URL is
 * `/accounts/{account}/containers`. Every call needs the token's "Workers
 * Containers" permission (Write for anything but reads) and an account on
 * Workers Paid.
 */
export function createContainers(http: HttpApi) {
  const apps = (suffix = "") => http.acct(`/containers/applications${suffix}`);
  return {
    /**
     * `GET /containers/applications[?name=]`: the account's container
     * applications, filtered by name on the server. On an account without
     * Workers Paid Cloudflare answers 401 (code 1000, "…requires the Workers
     * Paid plan…"); a token without a Containers permission gets 403 (code
     * 10000) first, whatever the plan.
     */
    async listApplications(opts: { name?: string } = {}): Promise<ContainerApplication[]> {
      const result = await http.result<unknown>("GET", apps(), {
        query: { name: opts.name },
      });
      return Array.isArray(result) ? (result as ContainerApplication[]) : [];
    },

    /** `GET /containers/applications/{id}`: one application, with its `health`. */
    getApplication(id: string): Promise<ContainerApplication> {
      return http.result("GET", apps(`/${enc(id)}`));
    },

    /**
     * `POST /containers/applications`. Instances start at once, up to
     * `max_instances`, and a new application has no rollout.
     */
    createApplication(args: CreateContainerApplicationArgs): Promise<ContainerApplication> {
      return http.result("POST", apps(), { json: args });
    },

    /**
     * `PATCH /containers/applications/{id}`. Changing `configuration` here
     * does not move running instances to it (a new image is only used after
     * a rollout; see {@link createRollout}).
     */
    modifyApplication(
      id: string,
      args: ModifyContainerApplicationArgs,
    ): Promise<ContainerApplication> {
      return http.result("PATCH", apps(`/${enc(id)}`), { json: args });
    },

    /**
     * `DELETE /containers/applications/{id}`. Deleting the Worker whose
     * Durable Objects an application backs leaves the application behind,
     * so it is deleted on its own.
     */
    deleteApplication(id: string): Promise<unknown> {
      return http.result("DELETE", apps(`/${enc(id)}`));
    },

    /**
     * `POST /containers/applications/{id}/rollouts`: moves the application's
     * instances to `target_configuration`, in steps.
     */
    createRollout(id: string, args: CreateContainerRolloutArgs): Promise<ContainerRollout> {
      return http.result("POST", apps(`/${enc(id)}/rollouts`), { json: args });
    },

    /** `GET /containers/applications/{id}/rollouts/{rolloutId}`: its `status` and progress. */
    getRollout(id: string, rolloutId: string): Promise<ContainerRollout> {
      return http.result("GET", apps(`/${enc(id)}/rollouts/${enc(rolloutId)}`));
    },
  };
}
