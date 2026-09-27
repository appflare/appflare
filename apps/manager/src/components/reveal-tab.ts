/** Room left beside the selected tab, so the one next to it peeks in. */
const MARGIN = 16;

/**
 * Scrolls a tab strip that is wider than the screen sideways until its
 * selected tab shows, without moving the page (a phone arriving from a link
 * to a section on the fourth tab would otherwise not see which tab is open).
 * `root` holds the tabs; nothing happens when the strip fits.
 */
export function revealSelectedTab(root: HTMLElement | null): void {
  const selected = root?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (root == null || selected == null) return;
  let strip = selected.parentElement;
  while (strip !== null && strip.scrollWidth <= strip.clientWidth + 1) {
    if (strip === root) return;
    strip = strip.parentElement;
  }
  if (strip === null) return;
  const tab = selected.getBoundingClientRect();
  const box = strip.getBoundingClientRect();
  if (tab.left < box.left) strip.scrollLeft -= box.left - tab.left + MARGIN;
  else if (tab.right > box.right) strip.scrollLeft += tab.right - box.right + MARGIN;
}
