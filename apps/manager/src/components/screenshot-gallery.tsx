import { Button, Dialog, Text } from "@cloudflare/kumo";
import { CaretLeftIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { type KeyboardEvent, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { CatalogImage } from "./catalog-image";
import {
  LIGHTBOX_CLOSED,
  type LightboxAction,
  type LightboxState,
  lightbox,
  pageOffset,
  positionLabel,
  STRIP_START,
  type StripAction,
  type StripEdges,
  type StripState,
  strip,
  stripEdges,
} from "./gallery-navigation";

export interface GalleryImage {
  src: string;
  alt: string;
}

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * Every screenshot's box: 16:10, the shape most app screenshots are. The
 * catalog index gives no dimensions, so the box is fixed before any image
 * arrives and each screenshot is letterboxed into it; the strip, its arrows
 * and the counter under it never move as screenshots load. In the strip a
 * portrait screenshot (a phone's) shows its top across the box's width
 * rather than a thin strip between bars; the large view shows all of it.
 */
const SCREENSHOT_BOX = { aspectRatio: "16 / 10" } as const;

/**
 * An app's screenshots as one strip: every screenshot in a box of the same
 * size, snapping as it scrolls, with no scrollbar; arrows on wider
 * screens when the strip overflows, and "N of M" under it. Selecting a
 * screenshot opens it large in a Kumo dialog with previous and next. Kumo has
 * no carousel, so the strip is a list of buttons with a roving tab stop
 * (`gallery-navigation.ts` has the keys). Renders nothing without images.
 */
export function ScreenshotGallery({
  images,
  appName,
}: {
  images: readonly GalleryImage[];
  appName: string;
}) {
  const count = images.length;
  const [position, move] = useReducer(
    (state: StripState, action: StripAction) => strip(state, action, count),
    STRIP_START,
  );
  const [box, dispatch] = useReducer(
    (state: LightboxState, action: LightboxAction) => lightbox(state, action, count),
    LIGHTBOX_CLOSED,
  );
  const list = useRef<HTMLUListElement>(null);
  const items = useRef<Array<HTMLLIElement | null>>([]);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [edges, setEdges] = useState<StripEdges>({ overflows: false, atStart: true, atEnd: true });

  /** Where the strip is: whether the arrows can move, and the caption's screenshot. */
  const measure = useCallback(() => {
    const el = list.current;
    if (el === null) return;
    setEdges(stripEdges(el));
    move({
      type: "scroll",
      scrollLeft: el.scrollLeft,
      offsets: items.current.map((item) => item?.offsetLeft ?? 0),
      maxScrollLeft: el.scrollWidth - el.clientWidth,
    });
  }, []);

  // The strip's own size changes with the window; the screenshots' never do.
  useEffect(() => {
    const el = list.current;
    if (el === null) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // Left and Right page through the lightbox while it is open; the dialog handles Escape.
  useEffect(() => {
    if (!box.open) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        dispatch({ type: "key", key: event.key });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [box.open]);

  /** Moves the tab stop to `index`, focuses it, and scrolls it into view; the scroll sets the caption. */
  function focusScreenshot(index: number) {
    move({ type: "focus", index });
    items.current[index]?.scrollIntoView({
      behavior: scrollBehavior(),
      block: "nearest",
      inline: "nearest",
    });
    buttons.current[index]?.focus({ preventScroll: true });
  }

  function onStripKey(event: KeyboardEvent<HTMLButtonElement>) {
    const next = strip(position, { type: "key", key: event.key }, count);
    if (next === position) return;
    event.preventDefault();
    focusScreenshot(next.focus);
  }

  function page(direction: "previous" | "next") {
    const el = list.current;
    if (el === null) return;
    el.scrollBy({ left: pageOffset(direction, el.clientWidth), behavior: scrollBehavior() });
  }

  if (count === 0) return null;
  const shown = images[box.index] ?? images[0];
  return (
    // One column no wider than the page's: the strip scrolls inside it, and
    // its screenshots never widen the page (a grid item's minimum width is
    // otherwise its content's).
    <section
      aria-label={`${appName} screenshots`}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"
    >
      <div className="relative min-w-0">
        {/* Scroll padding as wide as the padding (room for the focus ring), so the
            first snap point is the very start and "Previous" is hidden there. */}
        <ul
          ref={list}
          onScroll={measure}
          className="relative m-0 flex list-none snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-0.5 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {images.map((image, i) => (
            <li
              key={image.src}
              ref={(el) => {
                items.current[i] = el;
              }}
              className="shrink-0 snap-start"
            >
              <button
                ref={(el) => {
                  buttons.current[i] = el;
                }}
                type="button"
                tabIndex={i === position.focus ? 0 : -1}
                aria-label={`Screenshot ${positionLabel(i, count)}: ${image.alt}. Opens it larger.`}
                onClick={() => dispatch({ type: "open", index: i })}
                onFocus={() => move({ type: "focus", index: i })}
                onKeyDown={onStripKey}
                className="block cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-kumo-brand focus-visible:outline-offset-2"
              >
                <CatalogImage
                  src={image.src}
                  alt=""
                  fit="contain-landscape"
                  eager={i === 0}
                  style={SCREENSHOT_BOX}
                  className="h-52 rounded-lg ring ring-kumo-hairline md:h-72"
                />
              </button>
            </li>
          ))}
        </ul>
        {edges.overflows && (
          <>
            <Button
              variant="secondary"
              shape="circle"
              size="sm"
              icon={CaretLeftIcon}
              aria-label="Previous screenshots"
              disabled={edges.atStart}
              onClick={() => page("previous")}
              className="absolute top-1/2 left-2 hidden -translate-y-1/2 shadow-md disabled:opacity-0 md:inline-flex"
            />
            <Button
              variant="secondary"
              shape="circle"
              size="sm"
              icon={CaretRightIcon}
              aria-label="Next screenshots"
              disabled={edges.atEnd}
              onClick={() => page("next")}
              className="absolute top-1/2 right-2 hidden -translate-y-1/2 shadow-md disabled:opacity-0 md:inline-flex"
            />
          </>
        )}
      </div>
      {count > 1 && (
        <Text as="p" variant="secondary" size="sm">
          {positionLabel(position.visible, count)}
        </Text>
      )}
      <Dialog.Root
        open={box.open}
        onOpenChange={(open: boolean) => {
          if (!open) dispatch({ type: "close" });
        }}
        // Back on the strip, the screenshot last shown is the one in focus.
        onOpenChangeComplete={(open: boolean) => {
          if (!open) focusScreenshot(box.index);
        }}
      >
        <Dialog size="xl" className="grid gap-3 p-4 sm:w-[min(calc(100vw-4rem),80rem)]">
          <div className="flex items-center justify-between gap-3">
            <div className="grid min-w-0">
              <Dialog.Title className="truncate font-semibold text-base">
                {appName} screenshots
              </Dialog.Title>
              <Text as="span" variant="secondary" size="sm">
                <span aria-live="polite">{positionLabel(box.index, count)}</span>
              </Text>
            </div>
            <Dialog.Close
              render={(props) => (
                <Button {...props} variant="ghost" shape="square" icon={XIcon} aria-label="Close" />
              )}
            />
          </div>
          {shown !== undefined && (
            <figure className="m-0 grid justify-items-center gap-2">
              {/* Full width and as tall as the window allows, whatever the image turns out to be. */}
              <CatalogImage
                key={shown.src}
                src={shown.src}
                alt={shown.alt}
                eager
                style={SCREENSHOT_BOX}
                className="max-h-[calc(100dvh-16rem)] w-full rounded-md"
              />
              {/* The image's alt already names it for screen readers. */}
              <figcaption aria-hidden className="text-center text-kumo-subtle text-sm">
                {shown.alt}
              </figcaption>
            </figure>
          )}
          {count > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="secondary"
                icon={CaretLeftIcon}
                onClick={() => dispatch({ type: "previous" })}
              >
                Previous
              </Button>
              <Button variant="secondary" onClick={() => dispatch({ type: "next" })}>
                Next
                <CaretRightIcon aria-hidden />
              </Button>
            </div>
          )}
        </Dialog>
      </Dialog.Root>
    </section>
  );
}
