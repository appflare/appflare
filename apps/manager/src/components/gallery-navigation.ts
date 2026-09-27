/**
 * Keyboard and lightbox state for the screenshot gallery, apart from the
 * React component so tests can drive it without a DOM.
 *
 * The strip is one tab stop (a roving tabindex): Left and Right arrows move
 * between screenshots and stop at the ends, Home and End jump to them, Enter
 * or Space opens the one in focus. In the lightbox, Left and Right go to the
 * previous and next screenshot and wrap around, so browsing never dead-ends;
 * Escape closes it.
 */

/** The screenshot to focus after `key` in the strip, or null when the key does not move. */
export function stripKeyTarget(index: number, key: string, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowRight":
      return Math.min(index + 1, count - 1);
    case "ArrowLeft":
      return Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export interface LightboxState {
  open: boolean;
  /** The screenshot shown, or last shown; also the strip's focus after closing. */
  index: number;
}

export type LightboxAction =
  | { type: "open"; index: number }
  | { type: "close" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "key"; key: string };

export const LIGHTBOX_CLOSED: LightboxState = { open: false, index: 0 };

/** The lightbox after `action`, for a gallery of `count` screenshots. */
export function lightbox(
  state: LightboxState,
  action: LightboxAction,
  count: number,
): LightboxState {
  if (count === 0) return LIGHTBOX_CLOSED;
  const wrap = (i: number) => (i + count) % count;
  switch (action.type) {
    case "open":
      return { open: true, index: Math.min(Math.max(action.index, 0), count - 1) };
    case "close":
      return { ...state, open: false };
    case "next":
      return state.open ? { ...state, index: wrap(state.index + 1) } : state;
    case "previous":
      return state.open ? { ...state, index: wrap(state.index - 1) } : state;
    case "key":
      if (!state.open) return state;
      switch (action.key) {
        case "ArrowRight":
          return { ...state, index: wrap(state.index + 1) };
        case "ArrowLeft":
          return { ...state, index: wrap(state.index - 1) };
        case "Home":
          return { ...state, index: 0 };
        case "End":
          return { ...state, index: count - 1 };
        case "Escape":
          return { ...state, open: false };
        default:
          return state;
      }
  }
}

/** "2 of 5", for the caption and each screenshot's accessible name. */
export function positionLabel(index: number, count: number): string {
  return `${index + 1} of ${count}`;
}

/**
 * The screenshot whose left edge is nearest the strip's scroll position, for
 * the "N of M" caption while the strip scrolls; the last one once the strip
 * is scrolled to its end, where the last ones can never reach the left edge.
 */
export function visibleIndex(
  scrollLeft: number,
  offsets: readonly number[],
  maxScrollLeft: number,
): number {
  if (offsets.length === 0) return 0;
  if (maxScrollLeft > 0 && scrollLeft >= maxScrollLeft - 1) return offsets.length - 1;
  let best = 0;
  offsets.forEach((offset, i) => {
    if (Math.abs(offset - scrollLeft) < Math.abs((offsets[best] ?? 0) - scrollLeft)) best = i;
  });
  return best;
}

/**
 * The strip's two positions, kept apart: `focus` is the one screenshot that
 * takes Tab (moved by keys, clicks and focus only), `visible` is the one the
 * "N of M" caption names (moved by scrolling only). Scrolling never moves the
 * tab stop, so there is only ever one, and the caption always names what the
 * strip shows.
 */
export interface StripState {
  focus: number;
  visible: number;
}

export type StripAction =
  | { type: "key"; key: string }
  | { type: "focus"; index: number }
  | { type: "scroll"; scrollLeft: number; offsets: readonly number[]; maxScrollLeft: number };

export const STRIP_START: StripState = { focus: 0, visible: 0 };

/** The strip after `action`, for `count` screenshots. */
export function strip(state: StripState, action: StripAction, count: number): StripState {
  if (count === 0) return STRIP_START;
  switch (action.type) {
    case "key": {
      const target = stripKeyTarget(state.focus, action.key, count);
      return target === null ? state : { ...state, focus: target };
    }
    case "focus":
      return { ...state, focus: Math.min(Math.max(action.index, 0), count - 1) };
    case "scroll":
      return {
        ...state,
        visible:
          action.maxScrollLeft <= 1
            ? 0
            : visibleIndex(action.scrollLeft, action.offsets, action.maxScrollLeft),
      };
  }
}

export interface StripEdges {
  /** The strip is wider than its box, so the arrows are useful. */
  overflows: boolean;
  /** Scrolled to the start: nothing further left. */
  atStart: boolean;
  /** Scrolled to the end: nothing further right. */
  atEnd: boolean;
}

/**
 * Where the strip is scrolled, from its box. The gallery measures again
 * whenever a screenshot loads, since the strip only overflows once its
 * images have widths; a pixel of slack absorbs sub-pixel scroll positions.
 */
export function stripEdges(box: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): StripEdges {
  const max = box.scrollWidth - box.clientWidth;
  if (max <= 1) return { overflows: false, atStart: true, atEnd: true };
  return { overflows: true, atStart: box.scrollLeft <= 1, atEnd: box.scrollLeft >= max - 1 };
}

/** How far an arrow scrolls the strip: one box width, left or right; snapping settles it. */
export function pageOffset(direction: "previous" | "next", clientWidth: number): number {
  return direction === "next" ? clientWidth : -clientWidth;
}
