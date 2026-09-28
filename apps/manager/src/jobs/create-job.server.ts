import { invalidateScriptsCache } from "../cloudflare/scripts-cache.server";
import type { JobParams } from "./run-job";

/** The part of the `JOBS` Workflow binding a job start uses. */
export interface JobWorkflows {
  create(options: { id: string; params: JobParams }): Promise<{ id: string }>;
}

/**
 * Starts a job's Workflow instance: what every job start passes as its
 * `createJob`. A job may add, remove or rename Workers, so the account's
 * Worker names kept in this isolate are dropped as it starts (and again
 * when it ends, see `runJob`).
 */
export function jobCreator(
  workflows: JobWorkflows,
): <P extends JobParams>(id: string, params: P) => Promise<{ id: string }> {
  return (id, params) => {
    invalidateScriptsCache();
    return workflows.create({ id, params });
  };
}
