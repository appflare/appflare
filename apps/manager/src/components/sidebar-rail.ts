import { useCallback, useSyncExternalStore } from "react";
import { type ChoiceStorage, localChoice } from "./local-choice";

/**
 * Whether the desktop sidebar is folded into its icon rail, remembered per
 * browser (`local-choice.ts`), and whether the screen is narrow enough for
 * the drawer instead.
 */

export const SIDEBAR_RAIL_KEY = "appflare:sidebar";

/** Below this width (px) the sidebar is an off-canvas drawer; Kumo's default. */
export const MOBILE_BREAKPOINT = 768;

export type SidebarRail = "expanded" | "collapsed";

/** A stored value as a rail state: anything but "collapsed" is expanded. */
export function parseSidebarRail(value: string | null | undefined): SidebarRail {
  return value === "collapsed" ? "collapsed" : "expanded";
}

const rail = localChoice(SIDEBAR_RAIL_KEY, parseSidebarRail);

export function readSidebarRail(storage: ChoiceStorage | undefined): SidebarRail {
  return rail.read(storage);
}

export function writeSidebarRail(storage: ChoiceStorage | undefined, value: SidebarRail): void {
  rail.write(storage, value);
}

/**
 * The remembered rail state and a setter. Before hydration (and on the
 * server) the sidebar is expanded.
 */
export function useSidebarRail(): [SidebarRail, (rail: SidebarRail) => void] {
  return rail.useChoice();
}

/** Whether the viewport is narrow enough for the off-canvas drawer, matching Kumo's own check. */
export function useIsNarrow(breakpoint = MOBILE_BREAKPOINT): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const subscribeMedia = useCallback(
    (listener: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", listener);
      return () => list.removeEventListener("change", listener);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribeMedia,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
