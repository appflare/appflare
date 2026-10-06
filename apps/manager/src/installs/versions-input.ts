import { MAX_CONNECTION_STRING_LENGTH } from "@appflare/schema";
import { z } from "zod";

/** Client-safe input of the update, rollback, and database restore server functions. */

const id = z.string().min(1).max(200);

export const installIdInput = z.object({ installId: z.string().min(1).max(64) });

/** Values are bounded so a pasted blob cannot bloat the Workflow payload. */
const MAX_SECRET_LENGTH = 4096;

export const startUpdateInput = installIdInput.extend({
  /** Values of the secrets the new version introduces. Never logged; names only in the job record. */
  secrets: z.record(z.string().max(200), z.string().max(MAX_SECRET_LENGTH)).optional(),
  /**
   * Connection strings by Hyperdrive binding, for databases the new version
   * adds. Credentials: never logged; binding names only in the job record.
   */
  hyperdrive: z
    .record(z.string().max(200), z.string().max(MAX_CONNECTION_STRING_LENGTH))
    .optional(),
  /** The admin pressed Update: optional choices are offered too. */
  offerChoices: z.boolean().optional(),
  /** The admin confirmed that this update cannot check the new version on a preview first. */
  confirmNoPreview: z.boolean().optional(),
  /** For a sandbox tier app: the admin confirmed the cost of building the new version. */
  buildConfirmed: z.boolean().optional(),
  /**
   * For a self-deploying app: a replacement for its own Cloudflare token,
   * stored on the sandbox Worker before the installer runs. Never logged.
   */
  appToken: z.string().max(1024).optional(),
  /** The admin said the account is on Workers Paid (asked when the new version adds cron triggers). */
  paidConfirmed: z.boolean().optional(),
  /** With `paidConfirmed`: also record Workers Paid as the account's plan in Settings. */
  rememberPaidPlan: z.boolean().optional(),
  /** The version whose change to the app's Email Routing the admin saw. */
  confirmEmailRouting: z.string().min(1).max(200).optional(),
});
export type StartUpdateInput = z.infer<typeof startUpdateInput>;

export const startRollbackInput = installIdInput.extend({ snapshotId: id });

export const restoreDatabaseInput = installIdInput.extend({
  snapshotId: id,
  /** The `resources` row of the D1 database to restore. */
  databaseResourceId: id,
});
export type RestoreDatabaseInput = z.infer<typeof restoreDatabaseInput>;
