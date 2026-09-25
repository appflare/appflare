import type { CapabilitiesView } from "../capabilities/capabilities";
import { readCapabilitiesView } from "../capabilities/capabilities.server";
import { readCachedCatalogIndex } from "../catalog/index.server";
import type { Database } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import { sandboxBinding } from "../sandbox/binding";
import type { SandboxJobState } from "../sandbox/readiness";
import { readSandboxJobState } from "../sandbox/readiness.server";
import { type CatalogNeeds, catalogNeeds, type SandboxBuildsState } from "./checklist";

/** What the checklist is built from; the rows themselves are built where they are shown. */
export interface ChecklistData {
  view: CapabilitiesView;
  sandbox: SandboxBuildsState;
  needs: CatalogNeeds | null;
  accountId: string | null;
  /** An enable in progress and the last failed sandbox job, for the sandbox row. */
  sandboxJobs: SandboxJobState;
}

/**
 * Reads the stored capabilities, the account id, whether sandbox builds are
 * connected (the running Worker has the `SANDBOX` binding) or being turned
 * on, and the cached catalog. No Cloudflare API call; "Re-check" refreshes the capabilities first.
 */
export async function readChecklistData(
  env: { KV: KVNamespace; SANDBOX?: unknown; DB: D1Database },
  db: Database,
): Promise<ChecklistData> {
  const [view, row, index, sandboxJobs] = await Promise.all([
    readCapabilitiesView(db),
    readSettings(db, [SETTING.accountId]),
    readCachedCatalogIndex(env.KV),
    readSandboxJobState(env.DB),
  ]);
  return {
    view,
    sandbox: sandboxBinding(env) === undefined ? "off" : "enabled",
    needs: index === null ? null : catalogNeeds(index.apps),
    accountId: row.account_id || null,
    sandboxJobs,
  };
}
