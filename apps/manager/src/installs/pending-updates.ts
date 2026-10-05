import { isUpdateAvailable } from "../catalog/versions";
import { settingsLink } from "../components/settings-links";
import { tierChanged } from "./tier-change";

/**
 * Pending updates, for notifications: installs the catalog lists a newer
 * version of. Only an installed app counts (one that is updating, failed, or
 * uninstalled does not), and every install counts on its own, so two
 * installs of one app are two updates; one whose catalog entry changed how
 * it is installed is marked as taking a reinstall (tier-change.ts). Appflare's own version travels along
 * (the sidebar's Appflare card shows it too); it is never counted with the
 * apps. Client-safe (no bindings).
 */

export interface PendingAppUpdate {
  installId: string;
  version: string;
  latestVersion: string;
  /** No update can move it there: the entry changed how it is installed. */
  reinstall?: true;
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
  catalogVersion: string;
  /** How it was built (`installs.build_kind`); artifact when absent. */
  buildKind?: string;
}

export function pendingUpdates(
  installs: readonly PendingInstallRow[],
  /** Each catalog's version (and tier) of its apps, by app key (the rows' `appSlug` is theirs). */
  catalogApps: ReadonlyMap<string, { version: string; tier?: string }>,
  manager: ManagerStatus,
): PendingUpdates {
  const apps: PendingAppUpdate[] = [];
  for (const row of installs) {
    if (row.status !== "installed") continue;
    const latest = catalogApps.get(row.appSlug);
    if (latest === undefined || !isUpdateAvailable(row.catalogVersion, latest.version)) continue;
    apps.push({
      installId: row.id,
      version: row.catalogVersion,
      latestVersion: latest.version,
      ...(tierChanged(row.buildKind ?? "artifact", latest.tier)
        ? { reinstall: true as const }
        : {}),
    });
  }
  return { apps, manager };
}

/** Appflare's own version on the Updates settings page: the running version, the release feed, and automatic self-updates. */
export const MANAGER_UPDATES_HREF = settingsLink("updates", "appflare");
