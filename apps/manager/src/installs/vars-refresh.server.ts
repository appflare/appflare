import type { VarsRefreshReason } from "./install-vars";

/**
 * Deploying an app's settings again after a value they are filled in with
 * changed outside a settings change: the wildcard domain behind
 * `{{wildcardHostname}}`, or the address behind `{{appUrl}}` (a domain took
 * over from workers.dev, or workers.dev from a domain). The domain and
 * workers.dev actions start it once their own change is recorded, so the
 * settings job reads the new state.
 */

/**
 * Starts the settings refresh (`startVarsRefreshCore`) for `changed`: the
 * job's id, or null when no setting uses any of them, so nothing needs
 * deploying. Throws when it is refused (another job of the app runs).
 */
export type RefreshVars = (
  installId: string,
  changed: readonly VarsRefreshReason[],
) => Promise<{ jobId: string } | null>;

/** What a domain or workers.dev change did to the app's settings. */
export interface VarsRefresh {
  /** The settings change that fills the new value in; null when none started. */
  settingsJobId: string | null;
  /** Why the settings could not be deployed again now; null when they were, or need not be. */
  settingsNote: string | null;
}

/** Nothing started, nothing to say. */
export const NO_VARS_REFRESH: VarsRefresh = { settingsJobId: null, settingsNote: null };

/** How each value reads in a note. */
const VALUE_WORDS: Readonly<Record<VarsRefreshReason, string>> = {
  wildcardHostname: "{{wildcardHostname}}",
  appUrl: "the app's address ({{appUrl}})",
};

/**
 * Starts the settings refresh, reporting a refusal (another job runs) as a
 * note instead of failing the change that led to it. Without `refresh`, or
 * with nothing `changed`, nothing is started.
 */
export async function refreshSettings(
  refresh: RefreshVars | undefined,
  installId: string,
  changed: readonly VarsRefreshReason[],
): Promise<VarsRefresh> {
  if (refresh === undefined || changed.length === 0) return NO_VARS_REFRESH;
  try {
    const started = await refresh(installId, changed);
    return { settingsJobId: started?.jobId ?? null, settingsNote: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const what = changed.map((c) => VALUE_WORDS[c]).join(" or ");
    return {
      settingsJobId: null,
      settingsNote: `The app's settings may use ${what} and were not deployed again (${reason}). Save the app's settings once that is done to fill in the new value.`,
    };
  }
}
