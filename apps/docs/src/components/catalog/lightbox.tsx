import { Dialog } from "@cloudflare/kumo/primitives/dialog";
import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import {
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  isLightboxKey,
  LIGHTBOX_CLOSED,
  type LightboxAction,
  type LightboxState,
  lightbox,
  opensLightbox,
  positionLabel,
} from "./gallery-navigation.ts";
import {
  type Point,
  panStep,
  pressAction,
  type Size,
  zoomedSize,
  zoomScroll,
} from "./lightbox-zoom.ts";

export interface GalleryImage {
  url: string;
  alt: string;
}

const NAV_BUTTON = buttonVariants({ variant: "secondary", className: "gap-1.5 px-4 py-2" });

/** The lightbox's state for `count` screenshots, closed at first. */
export function useLightbox(count: number): [LightboxState, Dispatch<LightboxAction>] {
  return useReducer(
    (state: LightboxState, action: LightboxAction) => lightbox(state, action, count),
    LIGHTBOX_CLOSED,
  );
}

/**
 * What a link to a screenshot needs to open it in the lightbox instead:
 * a plain click, or Enter (which follows the link) or Space (as on a button).
 * A click with a modifier keeps the browser's own meaning (a new tab, a
 * download). `aria-haspopup="dialog"` also keeps the site's click counting
 * from taking the click for a visit to the image.
 */
export function lightboxOpener(open: () => void) {
  return {
    "aria-haspopup": "dialog" as const,
    onClick(event: MouseEvent<HTMLAnchorElement>) {
      if (!opensLightbox(event)) return;
      event.preventDefault();
      open();
    },
    onKeyDown(event: KeyboardEvent<HTMLAnchorElement>) {
      if (event.key !== " ") return;
      event.preventDefault();
      open();
    },
  };
}

/** A zoomed screenshot: at what size, and where its box is scrolled to first. */
interface Zoom {
  size: Size;
  scroll: { left: number; top: number };
}

/**
 * Screenshots shown large on the page itself (Base UI's dialog, through
 * Kumo), with previous and next, a counter and a close button when there
 * are several. Escape or a click outside it closes it, and focus goes back
 * to `returnFocus()`, the link last opened.
 *
 * A tap or a click on the screenshot, or Zoom in, shows it larger (see
 * `lightbox-zoom.ts`) in a box that scrolls with a finger or the arrow keys,
 * and drags with a mouse; another tap, Zoom out or Escape fits it again. A
 * sideways swipe on the fitted screenshot pages.
 */
export function Lightbox({
  title,
  images,
  state,
  dispatch,
  returnFocus,
}: {
  title: string;
  images: readonly GalleryImage[];
  state: LightboxState;
  dispatch: Dispatch<LightboxAction>;
  returnFocus: () => HTMLElement | null;
}) {
  const count = images.length;
  const shown = images[state.index] ?? images[0];
  const view = useRef<HTMLDivElement | null>(null);
  const image = useRef<HTMLImageElement | null>(null);
  const press = useRef<{ id: number; touch: boolean; x: number; y: number } | null>(null);
  const drag = useRef<Point | null>(null);
  const [zoomed, setZoom] = useState<Zoom | null>(null);
  // A zoom, and a drag, belong to one screenshot while it is open: paging (by
  // button, key or swipe) or closing fits it again, so it never comes back zoomed.
  const [zoomedOn, setZoomedOn] = useState({ open: state.open, index: state.index });
  if (zoomedOn.open !== state.open || zoomedOn.index !== state.index) {
    setZoomedOn({ open: state.open, index: state.index });
    setZoom(null);
    press.current = null;
    drag.current = null;
  }
  const zoomedNow = useRef(false);
  zoomedNow.current = zoomed !== null;
  const [claimRef] = useState(() => claimOneFingerDrag(zoomedNow));

  // The neighbours load while one screenshot is looked at, so paging is instant.
  useEffect(() => {
    if (!state.open || count < 2) return;
    for (const i of [state.index + 1, state.index - 1 + count]) {
      const next = images[i % count];
      if (next !== undefined) new Image().src = next.url;
    }
  }, [state.open, state.index, images, count]);

  // Once the zoomed screenshot is laid out, the point tapped goes back under the finger.
  useLayoutEffect(() => {
    if (zoomed !== null) view.current?.scrollTo(zoomed.scroll);
  }, [zoomed]);

  if (count === 0 || shown === undefined) return null;
  const several = count > 1;

  /** Zooms in on `at`, a point in the box, or on its middle. */
  function zoomIn(at?: Point) {
    const box = view.current;
    const img = image.current;
    if (box === null || img === null || img.naturalWidth === 0) return;
    const natural = { width: img.naturalWidth, height: img.naturalHeight };
    const size = { width: box.clientWidth, height: box.clientHeight };
    const point = at ?? { x: size.width / 2, y: size.height / 2 };
    setZoom({
      size: zoomedSize(natural, size),
      scroll: zoomScroll(natural, size, point),
    });
  }

  function onPopupKey(event: KeyboardEvent<HTMLDivElement>) {
    if (zoomed !== null) {
      const step = panStep(event.key);
      if (step === null) return;
      event.preventDefault();
      view.current?.scrollBy({ left: step.x, top: step.y });
      return;
    }
    if (!isLightboxKey(event.key)) return;
    event.preventDefault();
    dispatch({ type: "key", key: event.key });
  }

  function onPointerDown(event: PointerEvent<HTMLImageElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const touch = event.pointerType !== "mouse";
    press.current = { id: event.pointerId, touch, x: event.clientX, y: event.clientY };
    if (!touch && zoomed !== null) {
      drag.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function onPointerMove(event: PointerEvent<HTMLImageElement>) {
    const last = drag.current;
    if (last === null || press.current?.id !== event.pointerId) return;
    view.current?.scrollBy(last.x - event.clientX, last.y - event.clientY);
    drag.current = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent<HTMLImageElement>) {
    const start = press.current;
    press.current = null;
    drag.current = null;
    if (start === null || start.id !== event.pointerId) return;
    const action = pressAction(event.clientX - start.x, event.clientY - start.y, {
      touch: start.touch,
      zoomed: zoomed !== null,
    });
    if (action === "zoom") {
      if (zoomed !== null) {
        setZoom(null);
        return;
      }
      const box = view.current?.getBoundingClientRect();
      zoomIn(
        box === undefined ? undefined : { x: event.clientX - box.left, y: event.clientY - box.top },
      );
    } else if (action !== null) {
      dispatch({ type: action });
    }
  }

  return (
    <Dialog.Root
      open={state.open}
      onOpenChange={(open, details) => {
        if (open) return;
        // Escape fits a zoomed screenshot first; the next one closes.
        if (zoomed !== null && details.reason === "escape-key") {
          setZoom(null);
          return;
        }
        dispatch({ type: "close" });
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/75 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <Dialog.Popup
          // Base UI hides the rest of the page from assistive technology
          // without saying so on the dialog itself.
          aria-modal="true"
          finalFocus={() => returnFocus() ?? true}
          onKeyDown={onPopupKey}
          // A phone gets the whole screen: the screenshot's box takes what the rest leaves.
          className="fixed top-1/2 left-1/2 z-50 grid max-h-dvh w-full -translate-x-1/2 -translate-y-1/2 gap-3 border-fd-border max-sm:h-dvh max-sm:grid-rows-[auto_minmax(0,1fr)_auto] bg-fd-background p-3 text-fd-foreground shadow-2xl outline-none transition-[opacity,scale] duration-150 data-[ending-style]:scale-[0.98] data-[starting-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none sm:w-[min(calc(100vw-4rem),80rem)] sm:rounded-xl sm:border sm:p-4"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0">
              <Dialog.Title className="truncate font-semibold text-base">{title}</Dialog.Title>
              {several && (
                <span className="text-fd-muted-foreground text-sm tabular-nums">
                  <span aria-live="polite">{positionLabel(state.index, count)}</span>
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                aria-label={zoomed === null ? "Zoom in" : "Zoom out"}
                onClick={() => (zoomed === null ? zoomIn() : setZoom(null))}
                className={buttonVariants({ variant: "ghost", size: "icon" })}
              >
                {zoomed === null ? (
                  <MagnifyingGlassPlusIcon aria-hidden="true" />
                ) : (
                  <MagnifyingGlassMinusIcon aria-hidden="true" />
                )}
              </button>
              <Dialog.Close
                aria-label="Close"
                className={buttonVariants({ variant: "ghost", size: "icon" })}
              >
                <XIcon aria-hidden="true" />
              </Dialog.Close>
            </div>
          </div>
          <figure
            ref={claimRef}
            className="m-0 grid min-h-0 grid-rows-[minmax(0,1fr)_auto] justify-items-center gap-2"
          >
            {/*
              The box the screenshot fits in: all the height left on a phone,
              so a tall screenshot is not shrunk to a strip and a zoomed one
              has room to move; 16:10 on a wider screen. Zoomed, it
              scrolls.
            */}
            <div
              ref={view}
              className={`flex h-full w-full touch-manipulation overscroll-contain rounded-md bg-fd-secondary sm:aspect-[16/10] sm:h-auto sm:max-h-[calc(100dvh-13rem)] ${
                zoomed === null ? "overflow-hidden" : "overflow-auto"
              }`}
            >
              <img
                key={shown.url}
                ref={image}
                src={shown.url}
                alt={shown.alt}
                decoding="async"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                  press.current = null;
                  drag.current = null;
                }}
                draggable={false}
                style={
                  zoomed === null
                    ? undefined
                    : { width: zoomed.size.width, height: zoomed.size.height }
                }
                className={
                  zoomed === null
                    ? "h-full min-h-0 w-full min-w-0 cursor-zoom-in select-none object-contain"
                    : "m-auto max-w-none shrink-0 cursor-zoom-out select-none"
                }
              />
            </div>
            {/* The image's alt already names it for screen readers. */}
            <figcaption
              aria-hidden="true"
              className="line-clamp-2 text-center text-fd-muted-foreground text-sm"
            >
              {shown.alt}
            </figcaption>
          </figure>
          {several && (
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => dispatch({ type: "previous" })}
                className={NAV_BUTTON}
              >
                <CaretLeftIcon aria-hidden="true" />
                Previous
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: "next" })}
                className={NAV_BUTTON}
              >
                Next
                <CaretRightIcon aria-hidden="true" />
              </button>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Keeps a one-finger drag on the fitted screenshot from becoming a browser
 * gesture, so the swipe is the lightbox's alone: otherwise Chrome treats the
 * swipe as a pan that goes nowhere and swallows the next tap, on Next or on
 * Close. Two fingers still zoom the page, and a zoomed screenshot's box
 * scrolls as any box does. React's touch handlers are passive and cannot do
 * this, hence the listener of its own.
 */
function claimOneFingerDrag(zoomed: { current: boolean }) {
  return (el: HTMLElement | null) => {
    if (el === null) return;
    const claim = (event: TouchEvent) => {
      if (!zoomed.current && event.touches.length === 1 && event.cancelable) event.preventDefault();
    };
    el.addEventListener("touchmove", claim, { passive: false });
    return () => el.removeEventListener("touchmove", claim);
  };
}
