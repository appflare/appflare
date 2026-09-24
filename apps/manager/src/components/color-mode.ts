/**
 * Follows the browser's light or dark preference with Kumo's `data-mode` on
 * the root element, which switches Kumo's tokens and `color-scheme` (so the
 * logo, drawn with `light-dark()`, turns white in dark mode). Runs from the
 * document head before the first paint, and again whenever the preference
 * changes. A `color-scheme` alone is not enough: the production build
 * resolves Kumo's `light-dark()` tokens once, on the root element.
 */
export const COLOR_MODE_SCRIPT =
  '(()=>{const q=matchMedia("(prefers-color-scheme: dark)");const set=()=>{document.documentElement.dataset.mode=q.matches?"dark":"light"};set();q.addEventListener("change",set)})()';
