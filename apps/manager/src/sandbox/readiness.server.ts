import { readCapabilitiesView } from "../capabilities/capabilities.server";
import type { Database } from "../db/client";
import { sandboxBinding } from "./binding";
import { type SandboxReadiness, sandboxReadinessOf } from "./readiness";

/**
 * The sandbox builds row's state for the account checklist and the pages
 * that start builds: from the stored capability probes and whether the
 * running Worker has its `SANDBOX` binding. No Cloudflare API call.
 */
export async function readSandboxReadiness(
  env: { SANDBOX?: unknown },
  db: Database,
): Promise<SandboxReadiness> {
  return sandboxReadinessOf(await readCapabilitiesView(db), sandboxBinding(env) !== undefined);
}
