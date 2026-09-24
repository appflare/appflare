import { isUpdateAvailable } from "../catalog/versions";

/**
 * Pending updates, for the home page and the sidebar: installs the catalog
 * lists a newer version of, and a newer Appflare release. Only an installed
 * app counts (one that is updating, failed, or uninstalled does not), and
 * every install counts on its own, so two installs of one app are two
 * updates. Client-safe (no bindings).
 */

export interface PendingAppUpdate {
  installId: string;
  /** The install's label (`instance_name`), the Worker name when unset. */
  instanceName: string;
  version: string;
  latestVersion: string;
}

export interface PendingUpdates {
  apps: PendingAppUpdate[];
  /** A newer Appflare release than the running version; null when there is none. */
  manager: { current: string; latest: string } | null;
  /** Every pending update: the apps, plus one for Appflare itself. */
  total: number;
}

export interface PendingInstallRow {
  id: string;
  status: string;
  appSlug: string;
  instanceName: string | null;
  workerName: string;
  catalogVersion: string;
}

export function pendingUpdates(
  installs: readonly PendingInstallRow[],
  /** The catalog's version of each app, by slug. */
  catalogVersions: ReadonlyMap<string, string>,
  manager: { current: string; latest: string | null; updateAvailable: boolean },
): PendingUpdates {
  const apps: PendingAppUpdate[] = [];
  for (const row of installs) {
    if (row.status !== "installed") continue;
    const latest = catalogVersions.get(row.appSlug);
    if (latest === undefined || !isUpdateAvailable(row.catalogVersion, latest)) continue;
    apps.push({
      installId: row.id,
      instanceName: row.instanceName ?? row.workerName,
      version: row.catalogVersion,
      latestVersion: latest,
    });
  }
  const managerUpdate =
    manager.updateAvailable && manager.latest !== null
      ? { current: manager.current, latest: manager.latest }
      : null;
  return { apps, manager: managerUpdate, total: apps.length + (managerUpdate === null ? 0 : 1) };
}

/** "3 updates available", "1 update available". */
export function pendingUpdatesTitle(total: number): string {
  return `${total} update${total === 1 ? "" : "s"} available`;
}

/** Settings, Appflare updates: where the self-update starts. */
export const MANAGER_UPDATES_HREF = "/settings#appflare-updates";
