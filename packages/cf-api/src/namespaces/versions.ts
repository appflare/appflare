import type { HttpApi } from "../http";
import { buildUploadFormData, type WorkerModule } from "../modules";
import type {
  DeploymentVersion,
  VersionMetadata,
  VersionUploadResult,
  WorkerDeployment,
  WorkerVersion,
} from "../types";

const enc = encodeURIComponent;

export interface UploadVersionArgs {
  metadata: VersionMetadata;
  modules: WorkerModule[];
}

export interface CreateDeploymentArgs {
  versions: DeploymentVersion[];
  annotations?: Record<string, string>;
  /** Overwrite a deployment made outside the manager. */
  force?: boolean;
}

/** Worker versions & gradual deployments. */
export function createVersions(http: HttpApi) {
  return {
    /** `POST /workers/scripts/{name}/versions` — multipart, same builder as uploadScript. */
    uploadVersion(name: string, args: UploadVersionArgs): Promise<VersionUploadResult> {
      const form = buildUploadFormData(args.metadata, args.modules);
      return http.result("POST", http.acct(`/workers/scripts/${enc(name)}/versions`), { form });
    },

    /** `GET /workers/scripts/{name}/versions` — returns `result.items`. */
    async listVersions(
      name: string,
      opts: { deployable?: boolean } = {},
    ): Promise<WorkerVersion[]> {
      const result = await http.result<{ items?: WorkerVersion[] }>(
        "GET",
        http.acct(`/workers/scripts/${enc(name)}/versions`),
        { query: opts.deployable ? { deployable: true } : undefined },
      );
      return result.items ?? [];
    },

    /** `GET /workers/scripts/{name}/versions/{id}`. */
    getVersion(name: string, versionId: string): Promise<WorkerVersion> {
      return http.result(
        "GET",
        http.acct(`/workers/scripts/${enc(name)}/versions/${enc(versionId)}`),
      );
    },

    /** `GET /workers/scripts/{name}/deployments` — returns `result.deployments`. */
    async listDeployments(name: string): Promise<WorkerDeployment[]> {
      const result = await http.result<{ deployments?: WorkerDeployment[] }>(
        "GET",
        http.acct(`/workers/scripts/${enc(name)}/deployments`),
      );
      return result.deployments ?? [];
    },

    /**
     * `POST /workers/scripts/{name}/deployments` — promotes versions with a
     * `{ strategy: "percentage", versions: [...] }` body.
     */
    createDeployment(name: string, args: CreateDeploymentArgs): Promise<WorkerDeployment> {
      const body: Record<string, unknown> = {
        strategy: "percentage",
        versions: args.versions,
      };
      if (args.annotations) {
        body.annotations = args.annotations;
      }
      return http.result("POST", http.acct(`/workers/scripts/${enc(name)}/deployments`), {
        json: body,
        query: args.force ? { force: true } : undefined,
      });
    },
  };
}
