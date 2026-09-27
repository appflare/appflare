import { ne } from "drizzle-orm";
import { type CatalogIndexRead, listedApps, readEnabledCatalogs } from "../catalog/merged.server";
import { appKey } from "../catalog/sources";
import type { Database } from "../db/client";
import { installs } from "../db/schema";
import { sandboxBinding } from "../sandbox/binding";
import type { SandboxJobState } from "../sandbox/readiness";
import { readSandboxJobState } from "../sandbox/readiness.server";
import type { CapabilitiesView } from "./capabilities";
import { readCapabilitiesView } from "./capabilities.server";
import {
  type CatalogNeeds,
  catalogNeeds,
  type InstallOfApp,
  installedNeeds,
  type SandboxBuildsState,
} from "./capability-rows";

/**
 * What "What this account can run" is built from; the rows themselves
 * (`capabilityRows`) are built where they are shown, in the last setup step
 * and on Your account.
 */
export interface CapabilityRowsData {
  /** The stored probes, the Workers plan in force and the account id. */
  view: CapabilitiesView;
  sandbox: SandboxBuildsState;
  /** What the catalog's apps need; null when no catalog index is cached yet. */
  needs: CatalogNeeds | null;
  /** What the apps in the account need (every install that is not uninstalled). */
  inUse: CatalogNeeds;
  /** An enable in progress and the last failed sandbox job, for the sandbox builds row. */
  sandboxJobs: SandboxJobState;
}

/**
 * Reads the stored capabilities, whether sandbox builds are connected (the
 * running Worker has the `SANDBOX` binding) or being turned on, the cached
 * catalog, and the account's installs with the catalog entries they came
 * from. No Cloudflare API call; "Check again" refreshes the capabilities
 * first. A caller that already read the enabled catalogs or the installs
 * passes them in `known`, which saves reading them again.
 */
export async function readCapabilityRowsData(
  env: { KV: KVNamespace; SANDBOX?: unknown; DB: D1Database },
  db: Database,
  known: {
    reads?: readonly CatalogIndexRead[];
    installs?: readonly InstallOfApp[];
  } = {},
): Promise<CapabilityRowsData> {
  const [view, reads, sandboxJobs, present] = await Promise.all([
    readCapabilitiesView(db),
    known.reads ?? readEnabledCatalogs(env, { refreshOnMiss: false }),
    readSandboxJobState(env.DB),
    known.installs ??
      db
        .select({
          appSlug: installs.app_slug,
          catalogId: installs.catalog_id,
          origin: installs.origin,
        })
        .from(installs)
        .where(ne(installs.status, "uninstalled")),
  ]);
  // What the enabled catalogs' apps need, from their cached indexes.
  const cached = reads.filter((r) => r.ok);
  const apps = cached.flatMap((r) => (r.ok ? r.index.apps : []));
  const byKey = new Map(listedApps(reads).map((l) => [l.key, l.app]));
  return {
    view,
    sandbox: sandboxBinding(env) === undefined ? "off" : "enabled",
    needs: cached.length === 0 ? null : catalogNeeds(apps),
    inUse: installedNeeds(present, (i) => byKey.get(appKey(i.catalogId, i.appSlug))),
    sandboxJobs,
  };
}
