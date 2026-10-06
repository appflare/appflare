import { formatDateTime } from "../components/format";

/**
 * The words a rollback uses in its dialog and its job log. A snapshot taken
 * by a settings change of the version still installed puts back only the
 * settings and secrets: the code is the same, so it is worded as undoing
 * that change and says nothing about databases. A rollback to other code
 * warns that the databases stay as they are.
 */

/** Whether a snapshot holds the code the install runs now (same version, same artifact). */
export function snapshotHasSameCode(
  snapshot: { catalogVersion: string | null; artifactDigest: string | null },
  install: { catalogVersion: string | null; artifactDigest: string | null },
): boolean {
  return (
    snapshot.catalogVersion !== null &&
    snapshot.catalogVersion === install.catalogVersion &&
    snapshot.artifactDigest !== null &&
    snapshot.artifactDigest === install.artifactDigest
  );
}

export interface RollbackDialogCopy {
  /** The button in the Versions row. */
  button: string;
  title: string;
  /** The confirm button. */
  action: string;
  /** What happens, as one sentence (the Worker version is shown after it). */
  lead: string;
  /** Whether to warn that databases are not changed. */
  warnData: boolean;
}

export function rollbackDialogCopy(
  snapshot: {
    jobKind: string | null;
    takenAt: string;
    sameCode: boolean;
    fromCatalogVersion: string | null;
    fromVersionId: string;
  },
  /** What the UI calls the install (`installLabel`). */
  label: string,
): RollbackDialogCopy {
  const when = formatDateTime(snapshot.takenAt);
  const settingsChange = snapshot.jobKind === "reconfigure";
  if (snapshot.sameCode && settingsChange) {
    return {
      button: "Undo",
      title: `Undo the settings change of ${when}`,
      action: "Undo the settings change",
      lead: `Puts back the settings and secrets ${label} had before the settings change of ${when}, by deploying the Worker version that served then. The code stays the same.`,
      warnData: false,
    };
  }
  const change = settingsChange ? "settings change" : "update";
  if (snapshot.sameCode) {
    return {
      button: "Roll back",
      title: `Roll back ${label} to before the ${change} of ${when}`,
      action: "Roll back",
      lead: `Deploys the Worker version that served before the ${change} of ${when} again to all traffic, with the settings and secrets it had then. It runs the code installed now, so the data needs nothing.`,
      warnData: false,
    };
  }
  const target = snapshot.fromCatalogVersion ?? snapshot.fromVersionId.slice(0, 8);
  return {
    button: "Roll back",
    title: `Roll back ${label} to ${target}`,
    action: "Roll back",
    lead: `Deploys the Worker version that served before the ${change} of ${when} again to all traffic, with the settings and secrets it had then.`,
    warnData: true,
  };
}

/** The rollback job's first log line. */
export function rollbackStartMessage(opts: {
  workerName: string;
  fromVersion: string;
  toVersion: string | null;
  versionId: string;
  sameCode: boolean;
}): string {
  if (opts.sameCode) {
    return `Putting back the settings and secrets of Worker "${opts.workerName}" from before the change (version ${opts.versionId}). The code stays at ${opts.fromVersion}.`;
  }
  return `Rolling back Worker "${opts.workerName}" from ${opts.fromVersion} to ${opts.toVersion ?? "the snapshot's version"} (version ${opts.versionId}). D1 databases are not changed.`;
}

/** The rollback job's last log line. */
export function rollbackFinishMessage(opts: {
  fromVersion: string;
  toVersion: string | null;
  versionId: string;
  sameCode: boolean;
  /** The app's address (its root, not the health path the check probed). */
  url: string;
  /** `healthLabel` of the live check. */
  health: string;
}): string {
  if (opts.sameCode) {
    return `Put back the earlier settings and secrets at ${opts.url} (health: ${opts.health}).`;
  }
  return `Rolled back from ${opts.fromVersion} to ${opts.toVersion ?? opts.versionId} at ${opts.url} (health: ${opts.health}).`;
}
