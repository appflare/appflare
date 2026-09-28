/**
 * Arriving at a link to a part of a page (`/settings/building#github-access`):
 * once the element with that id is on the page, scroll it into view (its
 * `scroll-mt-*` keeps it clear of the top) and ring it for a moment, so the
 * eye lands on the right section. Pure over a small window interface, so the
 * rules are tested without a browser; `use-hash-target.ts` wires it to the
 * router.
 */

/** How long the ring stays around the target. */
export const HIGHLIGHT_MS = 1500;

/** How long to keep looking for the target while the page is still loading. */
export const FIND_TIMEOUT_MS = 3000;

/**
 * The ring. Kumo tokens only; listed here in full so Tailwind generates
 * them even though they are only ever added from script.
 */
export const HIGHLIGHT_CLASSES = [
  "rounded-lg",
  "ring-2",
  "ring-kumo-brand",
  "ring-offset-8",
  // The page's own background, so the gap between ring and target does not show.
  "ring-offset-kumo-canvas",
] as const;

/**
 * For a target that runs to the edge of the page's column (the parts of an
 * app's page): the ring sits on the target's edge instead of 8 px outside it.
 */
export const FLUSH_RING_CLASS = "[&.ring-2]:ring-offset-0";

export interface HashTargetElement {
  scrollIntoView(options: ScrollIntoViewOptions): void;
  classList: { add(...tokens: string[]): void; remove(...tokens: string[]): void };
}

export interface HashTargetWindow {
  getElementById(id: string): HashTargetElement | null;
  prefersReducedMotion(): boolean;
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  now(): number;
}

/** The element id a location hash names, or null for no hash (`#` alone included). */
export function hashTargetId(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * From the next animation frame, looks for the element `hash` names on each frame until it
 * appears (or {@link FIND_TIMEOUT_MS} passes), then scrolls to it and rings
 * it for {@link HIGHLIGHT_MS}. Returns a cleanup that stops looking and
 * removes the ring at once.
 */
export function arriveAtHash(win: HashTargetWindow, hash: string): () => void {
  const id = hashTargetId(hash);
  if (id === null) return () => {};
  const deadline = win.now() + FIND_TIMEOUT_MS;
  let frame: number | null = null;
  let timer: number | null = null;
  let ringed: HashTargetElement | null = null;

  function unring() {
    ringed?.classList.remove(...HIGHLIGHT_CLASSES);
    ringed = null;
  }

  function look() {
    frame = null;
    const target = win.getElementById(id as string);
    if (target === null) {
      if (win.now() < deadline) frame = win.requestAnimationFrame(look);
      return;
    }
    target.scrollIntoView({
      block: "start",
      behavior: win.prefersReducedMotion() ? "auto" : "smooth",
    });
    target.classList.add(...HIGHLIGHT_CLASSES);
    ringed = target;
    timer = win.setTimeout(() => {
      timer = null;
      unring();
    }, HIGHLIGHT_MS);
  }

  // From the next frame: the router's own scroll handling runs right after a
  // navigation resolves, and would otherwise undo this scroll.
  frame = win.requestAnimationFrame(look);
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    if (timer !== null) win.clearTimeout(timer);
    unring();
  };
}
