import type { CapabilitiesView } from "../capabilities/capabilities";
import { readCapabilitiesView } from "../capabilities/capabilities.server";
import { readCachedCatalogIndex } from "../catalog/index.server";
import type { Database } from "../db/client";
import { readSettings, SETTING } from "../db/settings";
import { sandboxBinding } from "../sandbox/binding";
import { type CatalogNeeds, catalogNeeds, type SandboxBuildsState } from "./checklist";

/** What the checklist is built from; the rows themselves are built where they are shown. */
export interface ChecklistData {
  view: CapabilitiesView;
  sandbox: SandboxBuildsState;
  needs: CatalogNeeds | null;
  accountId: string | null;
}

/**
 * Reads the stored capabilities, the account id, whether sandbox builds are
 * connected (the running Worker has the `SANDBOX` binding) and the cached
 * catalog. No Cloudflare API call; "Re-check" refreshes the capabilities first.
 */
export async function readChecklistData(
  env: { KV: KVNamespace; SANDBOX?: unknown },
  db: Database,
): Promise<ChecklistData> {
  const [view, row, index] = await Promise.all([
    readCapabilitiesView(db),
    readSettings(db, [SETTING.accountId]),
    readCachedCatalogIndex(env.KV),
  ]);
  return {
    view,
    sandbox: sandboxBinding(env) === undefined ? "off" : "enabled",
    needs: index === null ? null : catalogNeeds(index.apps),
    accountId: row.account_id || null,
  };
}
