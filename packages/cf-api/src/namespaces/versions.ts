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

/** A binding as `env` of a version patch carries it: the binding without its name. */
export type EnvBinding = { type: string } & Record<string, unknown>;

export interface LatestVersionPatch {
  /** Bindings to add or replace, by name; `null` removes one. */
  env?: Record<string, EnvBinding | null>;
  annotations?: Record<string, string>;
}

/** The version a patch created. */
export interface PatchedVersion {
  id: string;
  number?: number;
  /** URLs that always reach this version (its preview URL, when it has one). */
  urls?: string[];
  [key: string]: unknown;
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

    /**
     * `PATCH /workers/workers/{name}/versions/latest` — creates a new version
     * from the latest one by applying a JSON Merge Patch (RFC 7396); omitted
     * fields are inherited. `env` adds or replaces single bindings by name,
     * the shape wrangler 4 sends for `versions secret put`
     * (`patchLatestWorkerVersionWithSecrets`). Without `deploy` the new
     * version serves no traffic until a deployment promotes it.
     */
    patchLatestVersion(name: string, patch: LatestVersionPatch): Promise<PatchedVersion> {
      return http.result("PATCH", http.acct(`/workers/workers/${enc(name)}/versions/latest`), {
        raw: { body: JSON.stringify(patch), contentType: "application/merge-patch+json" },
      });
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
