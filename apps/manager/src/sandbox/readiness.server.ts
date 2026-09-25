import { readCapabilitiesView } from "../capabilities/capabilities.server";
import type { Database } from "../db/client";
import { sandboxBinding } from "./binding";
import { activeSandboxWorkerJob, lastSandboxJobFailure } from "./jobs.server";
import {
  type SandboxJobState,
  type SandboxReadiness,
  sandboxReadinessOf,
  withSandboxJobs,
} from "./readiness";

/** The enable job running now and the last failed sandbox job, from D1. */
export async function readSandboxJobState(d1: D1Database): Promise<SandboxJobState> {
  const [active, lastFailure] = await Promise.all([
    activeSandboxWorkerJob(d1),
    lastSandboxJobFailure(d1),
  ]);
  return {
    activeEnable: active?.kind === "sandbox_enable" ? { id: active.id } : null,
    lastFailure,
  };
}

/**
 * The sandbox builds row's state for the account checklist and the pages
 * that start builds: from the stored capability probes, whether the
 * running Worker has its `SANDBOX` binding, and the sandbox jobs (an enable
 * in progress, the last one that failed). No Cloudflare API call.
 */
export async function readSandboxReadiness(
  env: { SANDBOX?: unknown; DB: D1Database },
  db: Database,
): Promise<SandboxReadiness> {
  const [view, jobs] = await Promise.all([readCapabilitiesView(db), readSandboxJobState(env.DB)]);
  return withSandboxJobs(sandboxReadinessOf(view, sandboxBinding(env) !== undefined), jobs);
}
