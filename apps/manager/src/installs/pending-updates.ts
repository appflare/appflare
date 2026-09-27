import { isUpdateAvailable } from "../catalog/versions";
import { settingsLink } from "../components/settings-links";
import { installLabel } from "./display-name";

/**
 * Pending updates, for notifications: installs the catalog lists a newer
 * version of. Only an installed app counts (one that is updating, failed, or
 * uninstalled does not), and every install counts on its own, so two
 * installs of one app are two updates. Appflare's own version travels along
 * (the sidebar's Appflare card shows it too); it is never counted with the
 * apps. Client-safe (no bindings).
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
  apps: PendingAppUpdate[];
  manager: ManagerStatus;
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

/** Appflare's own version on the Updates settings page: the running version, the release feed, and automatic self-updates. */
export const MANAGER_UPDATES_HREF = settingsLink("updates", "appflare");
