import { swipeAction } from "./gallery-navigation.ts";

/**
 * Zooming in the screenshot lightbox, apart from the component so tests can
 * check the arithmetic. A screenshot opens fitted to the lightbox; a tap or
 * a click on it (or Zoom in) shows it larger, in a box that scrolls, with the
 * point tapped kept under the finger; another tap fits it again.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The least and the most a zoom enlarges a fitted screenshot by. */
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 4;

/** How far a pointer may move, in CSS pixels, and still be a tap. */
export const TAP_SLOP_PX = 10;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The size an image of `natural` size is drawn at to fit in `box`, as `object-fit: contain` draws it. */
export function fittedSize(natural: Size, box: Size): Size {
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  return { width: natural.width * scale, height: natural.height * scale };
}

/**
 * The size of a zoomed screenshot: its own pixels at one CSS pixel each,
 * but at least {@link MIN_ZOOM} and at most {@link MAX_ZOOM} times its
 * fitted size. A phone's screenshot of a wide desktop page would otherwise
 * zoom to seven times the screen, and a small one hardly at all.
 */
export function zoomedSize(natural: Size, box: Size): Size {
  const fitted = fittedSize(natural, box);
  const factor = clamp(natural.width / fitted.width, MIN_ZOOM, MAX_ZOOM);
  return { width: fitted.width * factor, height: fitted.height * factor };
}

/**
 * Where to scroll the zoomed screenshot so that the point at `at` (in the
 * box, where the fitted one was tapped) is still under the pointer. A zoomed
 * screenshot smaller than the box on a side sits in its middle there.
 */
export function zoomScroll(natural: Size, box: Size, at: Point): { left: number; top: number } {
  const fitted = fittedSize(natural, box);
  const zoomed = zoomedSize(natural, box);
  const along = (offset: number, fit: number, zoom: number, view: number) => {
    const share = clamp((offset - (view - fit) / 2) / fit, 0, 1);
    return clamp(share * zoom - offset, 0, Math.max(zoom - view, 0));
  };
  return {
    left: along(at.x, fitted.width, zoomed.width, box.width),
    top: along(at.y, fitted.height, zoomed.height, box.height),
  };
}

/**
 * What a press on the screenshot that moved by `dx`, `dy` does: a tap zooms
 * in or out; on a touch screen, a sideways swipe on the fitted screenshot
 * pages, as the arrows do. Zoomed, a drag moves the screenshot instead (the
 * browser scrolls it), so it pages nothing.
 */
export function pressAction(
  dx: number,
  dy: number,
  { touch, zoomed }: { touch: boolean; zoomed: boolean },
): "zoom" | "next" | "previous" | null {
  if (Math.hypot(dx, dy) <= TAP_SLOP_PX) return "zoom";
  return touch && !zoomed ? swipeAction(dx, dy) : null;
}

/** How far an arrow key moves a zoomed screenshot, in CSS pixels. */
export const PAN_STEP_PX = 80;

/** The scroll an arrow key asks of a zoomed screenshot, or null for any other key. */
export function panStep(key: string): Point | null {
  switch (key) {
    case "ArrowLeft":
      return { x: -PAN_STEP_PX, y: 0 };
    case "ArrowRight":
      return { x: PAN_STEP_PX, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -PAN_STEP_PX };
    case "ArrowDown":
      return { x: 0, y: PAN_STEP_PX };
    default:
      return null;
  }
}
