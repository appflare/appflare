/**
 * Renaming an install: sets or clears its display name. Nothing is deployed
 * and nothing changes in the account; only the manager's record changes, so
 * it is allowed while a job runs and after an uninstall.
 */

export class RenameInstallError extends Error {}

export async function renameInstallCore(
  db: D1Database,
  installId: string,
  /** The new display name, already validated; null shows the Worker name again. */
  displayName: string | null,
): Promise<{ displayName: string | null }> {
  // `instance_name` follows, for a manager rolled back to a version that reads it.
  const result = await db
    .prepare(
      "UPDATE installs SET display_name = ?2, instance_name = coalesce(?2, worker_name) WHERE id = ?1",
    )
    .bind(installId, displayName)
    .run();
  if (result.meta.changes !== 1) throw new RenameInstallError("There is no such install.");
  return { displayName };
}
