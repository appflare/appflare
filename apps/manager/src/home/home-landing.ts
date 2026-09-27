/**
 * With no app installed there is nothing for Home to show, so arriving at
 * `/` (opening Appflare, signing in, a bookmark) goes on to the catalog. A
 * deliberate click on Home in the sidebar (or on the logo) stays on Home,
 * which then says there are no apps and offers the catalog: sending that
 * click elsewhere would make Home impossible to reach. The click marks its
 * history entry with {@link HOME_CLICK_STATE}; everything else arrives
 * without it. Client-safe.
 */

/** The history state a Home click navigates with. */
export const HOME_CLICK_STATE = { homeClick: true } as const;

/** Whether the history entry was made by a click on Home. */
export function isHomeClick(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { homeClick?: unknown }).homeClick === true
  );
}

export type HomeLanding = "home" | "catalog";

/** Where `/` leads: Home, or on to the catalog while nothing is installed. */
export function homeLanding(installCount: number, state: unknown): HomeLanding {
  return installCount === 0 && !isHomeClick(state) ? "catalog" : "home";
}
