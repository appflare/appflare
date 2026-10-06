import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { createBrowserFlow } from "../../deploy/browser.ts";
import type { DeployFlow, DeployView } from "../../deploy/flow.ts";

const LOADING: DeployView = { step: "loading" };

/**
 * The deploy page's flow, created once the page runs in the browser (it is
 * prerendered in its loading step) and stopped when the page goes away.
 */
export function useDeployFlow(): { view: DeployView; flow: DeployFlow | null } {
  const [flow, setFlow] = useState<DeployFlow | null>(null);
  useEffect(() => {
    const created = createBrowserFlow();
    setFlow(created);
    created.start();
    return () => created.dispose();
  }, []);
  const subscribe = useCallback(
    (listener: () => void) => flow?.subscribe(listener) ?? (() => {}),
    [flow],
  );
  const view = useSyncExternalStore(
    subscribe,
    () => flow?.state() ?? LOADING,
    () => LOADING,
  );
  return { view, flow };
}
