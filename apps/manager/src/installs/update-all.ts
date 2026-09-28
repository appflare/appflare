import { z } from "zod";

/**
 * "Update all" on the home page: starts every listed app update that needs
 * nothing from the admin, and says which ones do. Client-safe.
 */

export const updateAllInput = z.object({
  /** The installs the home page listed as having an update, in its order. */
  installIds: z.array(z.string().min(1).max(64)).min(1).max(100),
});
export type UpdateAllInput = z.infer<typeof updateAllInput>;

export interface UpdateAllItem {
  installId: string;
  /** What Home calls the install (`installLabel`). */
  label: string;
  /** The version the update moves to. */
  version: string;
}

export interface UpdateAllOutcome {
  started: (UpdateAllItem & { jobId: string })[];
  /**
   * Updates that need a secret, a confirmation or an approval; each starts
   * from its app's page. `reason` is a sentence ("It needs a value for
   * API_KEY.").
   */
  needsInput: (UpdateAllItem & { reason: string })[];
  /** Updates that could not start now; `reason` is a full sentence. */
  notStarted: (UpdateAllItem & { reason: string })[];
}

/** The toast after "Update all": what started, and what is left. */
export function updateAllSummary(outcome: UpdateAllOutcome): string {
  const started = outcome.started.length;
  const left = outcome.needsInput.length + outcome.notStarted.length;
  const startedText =
    started === 0 ? "No update started" : `${started} update${started === 1 ? "" : "s"} started`;
  return left === 0 ? startedText : `${startedText}, ${left} left for you`;
}
