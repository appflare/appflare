import {
  type CapabilityId,
  type CapabilityRowsInput,
  type CatalogNeeds,
  capabilityAnchor,
  capabilityRows,
  rowsNeedingAction,
} from "../capabilities/capability-rows";
import { settingsLink } from "../components/settings-links";
import type { AccountAttentionRow } from "./attention";

/**
 * The account rows of "Needs attention": the rows of "What this account can
 * run" that need action, which they do only when an app in the account
 * relies on what is missing (or, for Appflare's own permissions, the
 * workers.dev address and the Workers plan, always). Rows that are merely
 * not set up, or need a paid plan, stay on Your account. Client-safe.
 */

/**
 * What each row counts of the apps' needs; null for a row every app needs
 * whatever it is (Appflare's own permissions), which "Not needed" never hides.
 */
const NEED_OF: Record<CapabilityId, keyof CatalogNeeds | null> = {
  "workers-dev": "total",
  "workers-plan": "workersPaid",
  r2: "r2",
  zone: "zone",
  "email-routing": "emailRouting",
  "analytics-engine": "analyticsEngine",
  "zero-trust": "access",
  sandbox: "sandbox",
  "token-permissions": null,
};

/** An install and what it needs (`installedNeeds` of it alone). */
export interface InstallNeeds {
  id: string;
  needs: CatalogNeeds;
}

export function accountAttentionRows(
  data: CapabilityRowsInput,
  installs: readonly InstallNeeds[],
): AccountAttentionRow[] {
  return rowsNeedingAction(capabilityRows(data)).map((row) => {
    const need = NEED_OF[row.id];
    return {
      id: row.id,
      name: row.name,
      found: row.details.found,
      why: row.why,
      dismissible: need !== null,
      ...(row.action?.kind === "reconnect" ? { reconnect: true } : {}),
      neededBy:
        need === null
          ? []
          : installs
              .filter((i) => i.needs[need] > 0)
              .map((i) => i.id)
              .sort(),
    };
  });
}

/** Where a row is set up: its own row on Your account. */
export function accountRowLink(row: Pick<AccountAttentionRow, "id">): string {
  return settingsLink("account", capabilityAnchor(row.id));
}
