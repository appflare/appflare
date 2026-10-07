/**
 * The screenshot lightbox's state, apart from the React component so tests
 * can drive it without a DOM.
 *
 * The lightbox and its keys are the same as on an app's page in Appflare
 * (`apps/manager/src/components/gallery-navigation.ts`), copied rather than
 * shared because nothing else of the manager's gallery fits this site: its
 * strip is a row of buttons with one tab stop, while here every screenshot
 * is a link to the image, so the page still works without JavaScript. Keep
 * the two in step.
 *
 * Left and Right go to the previous and next screenshot and wrap around, so
 * browsing never dead-ends; Home and End jump to the first and last; Escape
 * closes. On a touch screen a sideways swipe does what the arrows do.
 */

export interface LightboxState {
  open: boolean;
  /** The screenshot shown, or last shown; also the one focused again after closing. */
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

/** The keys the open lightbox answers, so it can keep them from scrolling the page. */
export function isLightboxKey(key: string): boolean {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
}

/** "2 of 5", for the counter and each screenshot's accessible name. */
export function positionLabel(index: number, count: number): string {
  return `${index + 1} of ${count}`;
}

/** How far a finger must travel sideways, in CSS pixels, before it counts as a swipe. */
export const SWIPE_MIN_PX = 48;

/**
 * What a touch that moved by `dx`, `dy` does: a swipe to the left shows the
 * next screenshot, to the right the previous one. A short or mostly vertical
 * movement is a tap or a scroll, and does nothing.
 */
export function swipeAction(dx: number, dy: number): "next" | "previous" | null {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return null;
  return dx < 0 ? "next" : "previous";
}

/**
 * Whether a click on a screenshot's link should open the lightbox. A click
 * with a modifier, or with another button, keeps the browser's own meaning
 * (a new tab, a new window, a download), as any link does.
 */
export function opensLightbox(click: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return click.button === 0 && !click.metaKey && !click.ctrlKey && !click.shiftKey && !click.altKey;
}
