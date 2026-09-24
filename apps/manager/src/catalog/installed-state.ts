/**
 * How a catalog card says an app is installed in this account: one dot
 * badge, the same for one install or several. Client-safe.
 */

/** The dot colours the badge uses (Kumo's dot badge has no info dot). */
export type InstalledTone = "success" | "neutral" | "warning" | "error";

export interface InstalledState {
  label: string;
  tone: InstalledTone;
  /** One line per install, `<name>: <status>`, for the tooltip. */
  details: string[];
}

const STATUS: Record<string, { label: string; tone: InstalledTone; rank: number }> = {
  installed: { label: "Installed", tone: "success", rank: 0 },
  installing: { label: "Installing", tone: "neutral", rank: 1 },
  updating: { label: "Updating", tone: "neutral", rank: 1 },
  uninstalling: { label: "Uninstalling", tone: "warning", rank: 2 },
  failed: { label: "Failed", tone: "error", rank: 3 },
};

function statusOf(status: string) {
  return STATUS[status] ?? { label: status, tone: "neutral" as const, rank: 1 };
}

/**
 * Null when the app is not installed. One install shows its own status
 * ("Installed", "Updating", "Failed"); several read "Installed ×N" with the
 * dot of the worst one (failed, then uninstalling, then in progress).
 */
export function installedState(
  instances: ReadonlyArray<{ status: string; instanceName: string }>,
): InstalledState | null {
  const [only] = instances;
  if (only === undefined) return null;
  const details = instances.map((i) => `${i.instanceName}: ${statusOf(i.status).label}`);
  if (instances.length === 1) {
    const { label, tone } = statusOf(only.status);
    return { label, tone, details };
  }
  const worst = instances
    .map((i) => statusOf(i.status))
    .reduce((a, b) => (b.rank > a.rank ? b : a));
  return { label: `Installed ×${instances.length}`, tone: worst.tone, details };
}
