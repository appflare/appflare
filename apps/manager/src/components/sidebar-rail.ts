import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether the desktop sidebar is folded into its icon rail, remembered per
 * browser in localStorage. Other tabs follow through the `storage` event.
 * Storage that is blocked or full only means the choice is not remembered.
 */

export const SIDEBAR_RAIL_KEY = "appflare:sidebar";

/** Below this width (px) the sidebar is an off-canvas drawer; Kumo's default. */
export const MOBILE_BREAKPOINT = 768;

export type SidebarRail = "expanded" | "collapsed";

/** A stored value as a rail state: anything but "collapsed" is expanded. */
export function parseSidebarRail(value: string | null | undefined): SidebarRail {
  return value === "collapsed" ? "collapsed" : "expanded";
}

type RailStorage = Pick<Storage, "getItem" | "setItem">;

export function readSidebarRail(storage: RailStorage | undefined): SidebarRail {
  try {
    return parseSidebarRail(storage?.getItem(SIDEBAR_RAIL_KEY));
  } catch {
    return "expanded";
  }
}

export function writeSidebarRail(storage: RailStorage | undefined, rail: SidebarRail): void {
  try {
    storage?.setItem(SIDEBAR_RAIL_KEY, rail);
  } catch {
    // Not remembered; the sidebar still changes for this page.
  }
}

const listeners = new Set<() => void>();

function browserStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === SIDEBAR_RAIL_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Last value set in this page, for browsers whose storage refuses writes. */
let fallback: SidebarRail | null = null;

function snapshot(): SidebarRail {
  const storage = browserStorage();
  return fallback ?? readSidebarRail(storage);
}

/**
 * The remembered rail state and a setter. Before hydration (and on the
 * server) the sidebar is expanded.
 */
export function useSidebarRail(): [SidebarRail, (rail: SidebarRail) => void] {
  const rail = useSyncExternalStore(subscribe, snapshot, () => "expanded" as const);
  const setRail = useCallback((next: SidebarRail) => {
    const storage = browserStorage();
    writeSidebarRail(storage, next);
    fallback = readSidebarRail(storage) === next ? null : next;
    for (const listener of listeners) listener();
  }, []);
  return [rail, setRail];
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
