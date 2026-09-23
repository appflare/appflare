import { z } from "zod";

/** Client-safe input of the uninstall server functions. */

export const installIdInput = z.object({ installId: z.string().min(1).max(64) });

export const startUninstallInput = installIdInput.extend({
  /**
   * Ids of the resources the admin ticked for deletion. Unticked data
   * resources stay in the account, marked retained; everything bound to the
   * Worker goes with it either way.
   */
  deleteResources: z.array(z.string().min(1).max(200)).max(500),
});
export type StartUninstallInput = z.infer<typeof startUninstallInput>;

/** A retry may keep more resources than the first attempt did. */
export const retryUninstallInput = installIdInput.extend({
  deleteResources: startUninstallInput.shape.deleteResources.optional(),
});
