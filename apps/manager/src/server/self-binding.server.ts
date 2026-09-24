import type { CloudflareClient } from "@appflare/cf-api";
import { JOB_UNITS_ENTRYPOINT, SELF_BINDING } from "../jobs/units/units";

/**
 * Gives a manager without the `SELF` service binding (one deployed from the
 * "Deploy to Cloudflare" button, whose config cannot name the Worker it will
 * be called) its binding to its own job units, right after setup stores the
 * API token: a merge-patch of the latest version adds `SELF` (`service`: the
 * Worker's own name, entrypoint `JobUnits`), the same way sandbox builds add
 * `SANDBOX`, and the new version is deployed. Every job then runs its
 * subrequest-heavy units in their own invocations from the first install.
 *
 * Best effort: without `SELF` the units run in place (slower budgets, same
 * results), and the next self-update adds the binding anyway, so a failure
 * is logged and never fails setup.
 */

export const SELF_BINDING_MESSAGE = "Appflare: add the service binding to its own job units";

export type SelfBindingOutcome =
  | { added: true; versionId: string }
  | { added: false; reason: "present" | "failed" };

export async function ensureSelfBinding(deps: {
  api: Pick<CloudflareClient, "versions">;
  workerName: string;
  /** The running version has `SELF` (the manager's `env.SELF`). */
  bound: boolean;
}): Promise<SelfBindingOutcome> {
  if (deps.bound) return { added: false, reason: "present" };
  try {
    const created = await deps.api.versions.patchLatestVersion(deps.workerName, {
      env: {
        [SELF_BINDING]: {
          type: "service",
          service: deps.workerName,
          entrypoint: JOB_UNITS_ENTRYPOINT,
        },
      },
      annotations: { "workers/message": SELF_BINDING_MESSAGE },
    });
    await deps.api.versions.createDeployment(deps.workerName, {
      versions: [{ version_id: created.id, percentage: 100 }],
      annotations: { "workers/message": SELF_BINDING_MESSAGE },
    });
    return { added: true, versionId: created.id };
  } catch (error) {
    console.error("setup: could not add the SELF service binding", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { added: false, reason: "failed" };
  }
}
