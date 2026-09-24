/**
 * Light or dark, through Kumo's `data-mode` on the root element, which
 * switches Kumo's tokens and `color-scheme` (so the logo, drawn with
 * `light-dark()`, turns white in dark mode). A `color-scheme` alone is not
 * enough: the production build resolves Kumo's `light-dark()` tokens once,
 * on the root element.
 *
 * The choice is made in the account menu and remembered per browser:
 * `light` (the default, also for anything unreadable), `dark`, or `system`,
 * which follows the browser's preference. Client-safe.
 */

export const COLOR_MODE_KEY = "appflare:color-mode";

export type ColorModeChoice = "light" | "dark" | "system";
export type ColorMode = "light" | "dark";

export const COLOR_MODE_CHOICES: readonly ColorModeChoice[] = ["light", "dark", "system"];

export const DEFAULT_COLOR_MODE_CHOICE: ColorModeChoice = "light";

/** A stored value as a choice; anything else is the default, light. */
export function parseColorModeChoice(value: string | null | undefined): ColorModeChoice {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : DEFAULT_COLOR_MODE_CHOICE;
}

/** The mode to show: the choice itself, or the browser's preference for `system`. */
export function resolveColorMode(choice: ColorModeChoice, prefersDark: boolean): ColorMode {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

/** Kumo's `bg-kumo-base` in light mode (white) and dark mode (neutral-925, oklch(17% 0 0)). */
export const THEME_COLOR: Readonly<Record<ColorMode, string>> = {
  light: "#ffffff",
  dark: "#0f0f0f",
};

/**
 * Sets `data-mode` before the first paint, from the stored choice, with the
 * same rule as {@link resolveColorMode}, and the browser's `theme-color` meta
 * to match (creating it; the page does not render one); then again when the browser's preference changes (it only matters
 * for `system`) and when another tab changes the choice. Inlined in the
 * document head of every page, including the static ones, so it cannot
 * import anything.
 */
export const COLOR_MODE_SCRIPT = `(()=>{const k=${JSON.stringify(COLOR_MODE_KEY)};const t=${JSON.stringify(THEME_COLOR)};const q=matchMedia("(prefers-color-scheme: dark)");const set=()=>{let c=null;try{c=localStorage.getItem(k)}catch(e){}const m=c==="dark"||(c==="system"&&q.matches)?"dark":"light";document.documentElement.dataset.mode=m;let meta=document.querySelector("meta[name=theme-color]");if(!meta){meta=document.createElement("meta");meta.name="theme-color";document.head.appendChild(meta)}meta.content=t[m]};set();q.addEventListener("change",set);addEventListener("storage",e=>{if(e.key===k)set()})})()`;

/**
 * The script's SHA-256 (base64), for a Content-Security-Policy that allows
 * this one inline script and nothing else. `color-mode.test.ts` recomputes
 * it, so an edit to the script that forgets this fails the tests.
 */
export const COLOR_MODE_SCRIPT_SHA256 = "gzQndEJaxfo71NJ0IvU1s7QFypTBaIkoZXUFvuCS54E=";
