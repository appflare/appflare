import { isUpdateAvailable } from "../catalog/versions";

/**
 * A catalog entry that changed how it is installed: an app that deployed
 * itself with its own installer now ships a release Appflare deploys, or
 * the other way round (OpenSEO moved from its own installer to a release in
 * 0.1.10). An installer's Workers and resources are its own, and a release's
 * are Appflare's, so an update cannot carry an install across: it is
 * uninstalled and installed again. Every place that offers an update says
 * so instead, with no Update button; starting the update anyway is refused
 * with the same words. Client-safe.
 */

/** Whether an install built as `buildKind` cannot be updated to an entry of `latestTier`. */
export function tierChanged(buildKind: string, latestTier: string | null | undefined): boolean {
  if (latestTier === null || latestTier === undefined) return false;
  return (buildKind === "self-deploying") !== (latestTier === "self-deploying");
}

/**
 * How lists and pages offer the catalog's newer version of an install:
 * `updateAvailable` when Update can start it, `reinstallNeeded` (never both)
 * when the entry changed how it is installed.
 */
export function updateOffer(
  row: { status: string; build_kind: string; catalog_version: string },
  listed: { version: string; tier: string } | null | undefined,
): { updateAvailable: boolean; reinstallNeeded: boolean } {
  const behind =
    row.status === "installed" && isUpdateAvailable(row.catalog_version, listed?.version);
  const reinstall = behind && tierChanged(row.build_kind, listed?.tier);
  return { updateAvailable: behind && !reinstall, reinstallNeeded: reinstall };
}

/** What changed, in words: "it no longer ships its own installer". */
function change(buildKind: string): string {
  return buildKind === "self-deploying"
    ? "it no longer ships its own installer"
    : "it now ships its own installer";
}

/** Why the update of `appName` is refused, and what to do instead. */
export function reinstallRefusal(appName: string, buildKind: string): string {
  return `${appName} changed how it is installed (${change(buildKind)}). Uninstall it and install it again.`;
}

/** One sentence where an update is listed: why there is no Update button. */
export function reinstallSentence(buildKind: string): string {
  return `It changed how it is installed (${change(buildKind)}), so it cannot be updated in place: uninstall it and install it again to get this version.`;
}
