import { useCallback, useSyncExternalStore } from "react";
import {
  COLOR_MODE_KEY,
  type ColorModeChoice,
  DEFAULT_COLOR_MODE_CHOICE,
  parseColorModeChoice,
  resolveColorMode,
  THEME_COLOR,
} from "./color-mode";

/**
 * The account menu's Appearance choice. Reads and writes the choice the head
 * script (COLOR_MODE_SCRIPT) applies on every load, and applies a change at
 * once, so the page never waits for a reload to switch.
 */

const listeners = new Set<() => void>();
/** The choice made in this page when storage refuses writes. */
let unsaved: ColorModeChoice | null = null;

function readChoice(): ColorModeChoice {
  if (unsaved !== null) return unsaved;
  try {
    return parseColorModeChoice(window.localStorage.getItem(COLOR_MODE_KEY));
  } catch {
    return DEFAULT_COLOR_MODE_CHOICE;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === COLOR_MODE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function apply(choice: ColorModeChoice): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const mode = resolveColorMode(choice, prefersDark);
  document.documentElement.dataset.mode = mode;
  document.querySelector("meta[name=theme-color]")?.setAttribute("content", THEME_COLOR[mode]);
}

export function useColorMode(): [ColorModeChoice, (choice: ColorModeChoice) => void] {
  const choice = useSyncExternalStore(subscribe, readChoice, () => DEFAULT_COLOR_MODE_CHOICE);
  const setChoice = useCallback((next: ColorModeChoice) => {
    try {
      window.localStorage.setItem(COLOR_MODE_KEY, next);
      unsaved = null;
    } catch {
      // Not remembered: this page keeps the choice until it reloads.
      unsaved = next;
    }
    apply(next);
    for (const listener of listeners) listener();
  }, []);
  return [choice, setChoice];
}
