import type { DeployCopyCleanup } from "../deploy-button/deploy-copy";
import type { InstallRow } from "../installs/installs.functions";
import type { ManagerStatus } from "../installs/pending-updates";
import type { AccountAttentionRow, Downgrade, FailedJob } from "./attention";

/**
 * What the signed-in layout loads on every page, in one call (`getLayoutData`):
 * the installs and what needs attention, for Home, the sidebar's apps and
 * Home's count; Appflare's own version, for the sidebar's Appflare card; and
 * how many removed apps there are (Settings lists Removed apps only then).
 * Client-safe (types only).
 */

/** An install as Home and the sidebar show it. */
export interface HomeApp extends InstallRow {
  /** Why its update waits for an admin's input; null when Update can start it (see `AttentionApp`). */
  updateNeeds: string | null;
  /** Its catalog entry now requires Cloudflare Access and Appflare does not protect it (see `AttentionApp`). */
  accessRequired?: boolean;
}

export interface LayoutData {
  manager: ManagerStatus;
  removedApps: number;
  /** Every install that is not uninstalled, newest first. */
  apps: HomeApp[];
  failedJobs: FailedJob[];
  /** For admins; empty for members, who cannot change the account. */
  accountRows: AccountAttentionRow[];
  /** For admins of a manager the Deploy to Cloudflare button deployed, until one dismisses it. */
  deployCopy: DeployCopyCleanup | null;
  downgrade: Downgrade | null;
}
