import { useKumoToastManager } from "@cloudflare/kumo";
import { useCallback, useRef } from "react";
import { useJobStarted } from "./job-started";

/** What a domain or workers.dev action did to the app's settings. */
export interface SettingsRefreshResult {
  /** The settings change it started; null or absent when none did. */
  settingsJobId?: string | null;
  /** Why the settings could not be deployed again; null or absent when nothing needs saying. */
  settingsNote?: string | null;
}

/**
 * After an action that changed a value the app's settings are filled in
 * with (a wildcard domain added or removed, the app's address moved between
 * workers.dev and a domain): the settings change that fills it in again,
 * when one started, is followed on its job page (with `follow: false`, as
 * after a check the page ran by itself, a toast only says it started); one
 * that could not start is explained in a toast. The function is stable
 * across renders, so effects may depend on it.
 */
export function useSettingsRefresh() {
  const jobStarted = useJobStarted();
  const toasts = useKumoToastManager();
  const latest = useRef({ jobStarted, toasts });
  latest.current = { jobStarted, toasts };
  return useCallback(
    async (
      result: SettingsRefreshResult,
      title: string,
      { follow = true }: { follow?: boolean } = {},
    ) => {
      const { jobStarted: started, toasts: toast } = latest.current;
      if (result.settingsJobId != null) {
        if (follow) {
          await started(result.settingsJobId, title);
        } else {
          toast.add({
            title,
            description: "The app's page shows the job while it runs.",
            variant: "info",
          });
        }
      } else if (result.settingsNote != null) {
        toast.add({
          title: "Settings not deployed again",
          description: result.settingsNote,
          variant: "warning",
        });
      }
    },
    [],
  );
}

/** The toast title when the app's settings follow its new address. */
export const NEW_ADDRESS_SETTINGS = "Settings are being deployed with the app's new address";
