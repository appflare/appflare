import { useKumoToastManager } from "@cloudflare/kumo";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { DISMISS_NOT_SAVED, dismissOptimistically } from "./optimistic-dismiss";

export interface OptimisticDismiss {
  /** Whether the element is dismissed; render nothing while true. */
  hidden: boolean;
  /** The close button's handler: hides at once and saves in the background. */
  dismiss(): void;
}

/**
 * Every dismissible card, banner and item in the manager: `dismiss` hides it
 * at once and runs `persist` in the background. Once the save succeeds the
 * router's data is refreshed, so a cached page never brings the element
 * back; when it fails the element shows again, with a toast.
 */
export function useOptimisticDismiss(persist: () => Promise<unknown>): OptimisticDismiss {
  const [hidden, setHidden] = useState(false);
  const router = useRouter();
  const toasts = useKumoToastManager();

  function dismiss() {
    void dismissOptimistically({
      hide: () => setHidden(true),
      persist,
      restore: () => {
        setHidden(false);
        toasts.add({ title: DISMISS_NOT_SAVED, variant: "error" });
      },
    }).then((outcome) => {
      if (outcome === "saved") {
        router.invalidate().catch(() => {
          // Saved already: the next page load reads it.
        });
      }
    });
  }

  return { hidden, dismiss };
}
