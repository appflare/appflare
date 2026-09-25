/**
 * Dismissals hide at once and save in the background: waiting on the server
 * before hiding made every close button feel slow. Only a failed save brings
 * the element back, with a short toast saying so. Framework-free; the hook in
 * ./use-optimistic-dismiss.ts wires it to React state, the router and toasts.
 */

/** The toast shown when a dismissal could not be saved and the element came back. */
export const DISMISS_NOT_SAVED = "Could not save; shown again";

export interface OptimisticDismissSteps {
  /** Hides the element. Runs before the save starts. */
  hide(): void;
  /** Saves the dismissal. */
  persist(): Promise<unknown>;
  /** Shows the element again after a failed save, and says so. */
  restore(error: unknown): void;
}

/**
 * Hides, then saves; restores only when the save fails. Never rejects: the
 * outcome says whether the dismissal was saved or the element came back.
 */
export async function dismissOptimistically(
  steps: OptimisticDismissSteps,
): Promise<"saved" | "restored"> {
  steps.hide();
  try {
    await steps.persist();
    return "saved";
  } catch (error) {
    steps.restore(error);
    return "restored";
  }
}
