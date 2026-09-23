import { z } from "zod";

/** Client-safe input of the update, rollback, and database restore server functions. */

const id = z.string().min(1).max(200);

export const installIdInput = z.object({ installId: z.string().min(1).max(64) });

/** Values are bounded so a pasted blob cannot bloat the Workflow payload. */
const MAX_SECRET_LENGTH = 4096;

export const startUpdateInput = installIdInput.extend({
  /** Values of the secrets the new version introduces. Never logged; names only in the job record. */
  secrets: z.record(z.string().max(200), z.string().max(MAX_SECRET_LENGTH)).optional(),
  /** The admin confirmed that this update cannot check the new version on a preview first. */
  confirmNoPreview: z.boolean().optional(),
  /** For a sandbox tier app: the admin confirmed the cost of building the new version. */
  buildConfirmed: z.boolean().optional(),
});
export type StartUpdateInput = z.infer<typeof startUpdateInput>;

export const startRollbackInput = installIdInput.extend({ snapshotId: id });

export const restoreDatabaseInput = installIdInput.extend({
  snapshotId: id,
  /** The `resources` row of the D1 database to restore. */
  databaseResourceId: id,
});
export type RestoreDatabaseInput = z.infer<typeof restoreDatabaseInput>;
