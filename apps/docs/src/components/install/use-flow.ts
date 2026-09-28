import { useCallback, useEffect, useRef, useState } from "react";
import { track } from "../../analytics/analytics.ts";
import { installLinkEvent, registeredEvent } from "../../analytics/flow-events.ts";
import {
  type FlowAction,
  type FlowPage,
  type FlowState,
  FORWARD_DELAY_MS,
  loadingState,
  reduce,
} from "../../install/flow.ts";
import { blockedMemory, browserMemory, type Memory } from "../../install/memory.ts";

/**
 * Runs the install steps in the browser. The page is prerendered in its
 * loading step; once it runs, `start` reads this browser's memory and the
 * address bar and picks the first real step. On the "opening" step the
 * visitor is sent on after {@link FORWARD_DELAY_MS}, long enough to read
 * where they are going and select Change, which stops it.
 *
 * A visitor who comes back to the page with the Back button is not sent on
 * again, or Back would never get them past it: they get the link to open
 * instead (`forwarding` is false).
 */
export function useFlow(
  context: FlowPage,
  start: (memory: Memory) => FlowState,
): { state: FlowState; dispatch: (action: FlowAction) => void; forwarding: boolean } {
  const [state, setState] = useState(() => loadingState(context));
  const [forwarding, setForwarding] = useState(true);
  const current = useRef(state);
  const memory = useRef<Memory>(blockedMemory);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, on arrival
  useEffect(() => {
    if (cameBack()) setForwarding(false);
    memory.current = browserMemory();
    const hadManager = memory.current.manager() !== null;
    const first = start(memory.current);
    current.current = first;
    setState(first);
    const arrival = installLinkEvent(first, hadManager);
    if (arrival !== null) track("install_link_clicked", arrival);
    // A page restored from the back/forward cache does not run again.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) setForwarding(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  // The state module writes to storage, so each click runs it exactly once,
  // outside React's state updater (which may run twice).
  const dispatch = useCallback((action: FlowAction) => {
    const next = reduce(current.current, action, memory.current, new Date());
    if (next === current.current) return;
    const registered = registeredEvent(action, next);
    if (registered !== null) track("manager_registered", registered);
    current.current = next;
    setState(next);
    // A click is a fresh choice: whatever it leads to may send the visitor on.
    setForwarding(true);
  }, []);

  const target = state.view.step === "opening" && forwarding ? state.view.target : null;
  useEffect(() => {
    if (target === null) return;
    const timer = window.setTimeout(() => window.location.assign(target), FORWARD_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [target]);

  return { state, dispatch, forwarding };
}

/** Whether this page was reached with the Back or Forward button. */
function cameBack(): boolean {
  const [entry] = performance.getEntriesByType("navigation");
  return entry !== undefined && (entry as PerformanceNavigationTiming).type === "back_forward";
}
