import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { browserStepCounter, deployStepOf } from "../../analytics/deploy-steps.ts";
import { createBrowserFlow } from "../../deploy/browser.ts";
import type { DeployFlow, DeployView } from "../../deploy/flow.ts";
import { browserDeployStorage } from "../../deploy/storage.ts";

const LOADING: DeployView = { step: "loading" };

/**
 * The deploy page's flow, created once the page runs in the browser (it is
 * prerendered in its loading step) and stopped when the page goes away.
 * Each step it reaches is counted (`analytics/deploy-steps.ts`).
 */
export function useDeployFlow(): { view: DeployView; flow: DeployFlow | null } {
  const [flow, setFlow] = useState<DeployFlow | null>(null);
  useEffect(() => {
    const created = createBrowserFlow();
    const count = browserStepCounter(browserDeployStorage().steps);
    const stopCounting = created.subscribe(() => count(deployStepOf(created.state())));
    setFlow(created);
    created.start();
    return () => {
      stopCounting();
      created.dispose();
    };
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
