import { WorkerEntrypoint } from "cloudflare:workers";
import type { UnitResult } from "./result";
import {
  type AssetPartResult,
  createJobUnits,
  type D1MigrationResult,
  type R2PageResult,
  type WorkerUploadResult,
} from "./units";

/**
 * The manager's job units over RPC. A job reaches this class through the
 * `SELF` service binding (`services: [{ binding: "SELF", service: <this
 * Worker's name>, entrypoint: "JobUnits" }]`); each call runs as a new
 * invocation with its own subrequest limit and costs the caller one
 * subrequest. Inputs arrive as plain values and are validated before use;
 * the API token and the GitHub token come from this Worker's own secrets.
 */
export class JobUnits extends WorkerEntrypoint<Env> {
  uploadAssetPart(input: unknown): Promise<UnitResult<AssetPartResult>> {
    return createJobUnits(this.env).uploadAssetPart(input);
  }

  uploadWorker(input: unknown): Promise<UnitResult<WorkerUploadResult>> {
    return createJobUnits(this.env).uploadWorker(input);
  }

  applyD1Migration(input: unknown): Promise<UnitResult<D1MigrationResult>> {
    return createJobUnits(this.env).applyD1Migration(input);
  }

  emptyR2Page(input: unknown): Promise<UnitResult<R2PageResult>> {
    return createJobUnits(this.env).emptyR2Page(input);
  }
}
