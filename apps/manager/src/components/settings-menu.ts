import { createContext, useCallback, useContext, useState } from "react";
import { type ChoiceStorage, localChoice } from "./local-choice";
import { isSettingsPath, type SettingsPage } from "./navigation";

/**
 * Whether the sidebar's Settings entry shows its list of pages. A click on
 * Settings opens or closes the list in place, and that choice is remembered
 * per browser. Coming into Settings from another page opens the list by
 * itself, so the page you are on is in view; that opening is not remembered,
 * and moving between settings pages leaves the list as it is, so a list you
 * closed stays closed.
 */

export const SETTINGS_MENU_KEY = "appflare:settings-menu";

export type SettingsMenuState = "open" | "closed";

/** A stored value as the list's state: closed unless "open" was stored. */
export function parseSettingsMenu(value: string | null | undefined): SettingsMenuState {
  return value === "open" ? "open" : "closed";
}

const menu = localChoice(SETTINGS_MENU_KEY, parseSettingsMenu);

export function readSettingsMenu(storage: ChoiceStorage | undefined): SettingsMenuState {
  return menu.read(storage);
}

export function writeSettingsMenu(storage: ChoiceStorage | undefined, state: SettingsMenuState) {
  menu.write(storage, state);
}

/**
 * Whether showing `pathname` opens the list by itself: it is a settings
 * page, reached from a page outside Settings (`previous`, the page shown
 * before; null on the first page load).
 */
export function opensSettingsMenu(pathname: string, previous: string | null): boolean {
  return isSettingsPath(pathname) && (previous === null || !isSettingsPath(previous));
}

/**
 * The list's open state on `pathname`, and a setter for a click, which is
 * remembered. The list is open while the remembered choice is open, or
 * while it was opened by itself on the way into Settings and not closed
 * since; that lasts until you leave Settings.
 */
export function useSettingsMenu(pathname: string): [boolean, (open: boolean) => void] {
  const [stored, setStored] = menu.useChoice();
  const [shown, setShown] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  // Worked out while rendering the new page, so the list does not slide
  // open after the page appears.
  if (shown !== pathname) {
    setShown(pathname);
    setOpened(opensSettingsMenu(pathname, shown) || (opened && isSettingsPath(pathname)));
  }
  const setOpen = useCallback(
    (open: boolean) => {
      setOpened(false);
      setStored(open ? "open" : "closed");
    },
    [setStored],
  );
  return [opened || stored === "open", setOpen];
}

/**
 * The settings pages the app shell lists, and how it opens one, for the
 * page list shown on the settings pages themselves on narrow screens. Null
 * outside the shell (a page rendered on its own shows no list).
 */
export interface SettingsNavigation {
  pages: readonly SettingsPage[];
  navigate(href: string): void;
}

export const SettingsNavigationContext = createContext<SettingsNavigation | null>(null);

export function useSettingsNavigation(): SettingsNavigation | null {
  return useContext(SettingsNavigationContext);
}
