import { isUpdateAvailable } from "../catalog/versions";
import { settingsLink } from "../components/settings-links";
import { installLabel } from "./display-name";

/**
 * Pending updates, for the home page and the sidebar: installs the catalog
 * lists a newer version of. Only an installed app counts (one that is
 * updating, failed, or uninstalled does not), and every install counts on
 * its own, so two installs of one app are two updates. Appflare's own
 * version travels along for the sidebar's Appflare card, which offers its
 * update; it is never counted with the apps. Client-safe (no bindings).
 */

export interface PendingAppUpdate {
  installId: string;
  /** What the UI calls the install (`installLabel`). */
  label: string;
  version: string;
  latestVersion: string;
}

/** Appflare itself, as the sidebar's Appflare card shows it. */
export interface ManagerStatus {
  /** The running version. */
  current: string;
  /** The newest release the release feed reported; null until a check found one. */
  latest: string | null;
  /** Whether `latest` is newer than the running version. */
  updateAvailable: boolean;
  /** The self-update queued or running, if any. */
  activeJobId: string | null;
}

export interface PendingUpdates {
  /** The apps to update: Home's count in the sidebar and the home page's list. */
  apps: PendingAppUpdate[];
  manager: ManagerStatus;
}

/**
 * What the signed-in layout loads on every page, in one call: the pending
 * updates, and how many uninstalled apps still keep data (Settings lists
 * Removed apps only while there are any).
 */
export interface LayoutData extends PendingUpdates {
  removedApps: number;
}

export interface PendingInstallRow {
  id: string;
  status: string;
  appSlug: string;
  displayName: string | null;
  workerName: string;
  catalogVersion: string;
}

export function pendingUpdates(
  installs: readonly PendingInstallRow[],
  /** Each catalog's version of its apps, by app key (the rows' `appSlug` is theirs). */
  catalogVersions: ReadonlyMap<string, string>,
  manager: ManagerStatus,
): PendingUpdates {
  const apps: PendingAppUpdate[] = [];
  for (const row of installs) {
    if (row.status !== "installed") continue;
    const latest = catalogVersions.get(row.appSlug);
    if (latest === undefined || !isUpdateAvailable(row.catalogVersion, latest)) continue;
    apps.push({
      installId: row.id,
      label: installLabel(row),
      version: row.catalogVersion,
      latestVersion: latest,
    });
  }
  return { apps, manager };
}

/** "3 updates available", "1 update available". */
export function pendingUpdatesTitle(total: number): string {
  return `${total} update${total === 1 ? "" : "s"} available`;
}

/**
 * The count on a sidebar item: the app updates on Home, where each one
 * starts. Nothing else carries one; Appflare's own update is offered by the
 * Appflare card at the bottom of the sidebar instead.
 */
export function sidebarUpdateBadge(
  href: string,
  pending: PendingUpdates,
): { count: number; label: string } {
  if (href !== "/") return { count: 0, label: "" };
  return { count: pending.apps.length, label: pendingUpdatesTitle(pending.apps.length) };
}

/** Appflare's own version on the Updates settings page: the running version, the release feed, and automatic self-updates. */
export const MANAGER_UPDATES_HREF = settingsLink("updates", "appflare");
