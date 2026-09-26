import type { CapabilitiesView } from "../capabilities/capabilities";
import { readCapabilitiesView } from "../capabilities/capabilities.server";
import { readEnabledCatalogs } from "../catalog/merged.server";
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
  const [view, row, reads, sandboxJobs] = await Promise.all([
    readCapabilitiesView(db),
    readSettings(db, [SETTING.accountId]),
    readEnabledCatalogs(env, { refreshOnMiss: false }),
    readSandboxJobState(env.DB),
  ]);
  // What the enabled catalogs' apps need, from their cached indexes.
  const cached = reads.filter((r) => r.ok);
  const apps = cached.flatMap((r) => (r.ok ? r.index.apps : []));
  return {
    view,
    sandbox: sandboxBinding(env) === undefined ? "off" : "enabled",
    needs: cached.length === 0 ? null : catalogNeeds(apps),
    accountId: row.account_id || null,
    sandboxJobs,
  };
}
