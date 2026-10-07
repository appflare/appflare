import { Dialog } from "@cloudflare/kumo/primitives/dialog";
import { buttonVariants } from "@fumadocs/base-ui/components/ui/button";
import { CaretLeftIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useReducer,
  useRef,
} from "react";
import {
  isLightboxKey,
  LIGHTBOX_CLOSED,
  type LightboxAction,
  type LightboxState,
  lightbox,
  opensLightbox,
  positionLabel,
  swipeAction,
} from "./gallery-navigation.ts";

export interface GalleryImage {
  url: string;
  alt: string;
}

const NAV_BUTTON = buttonVariants({ variant: "secondary", className: "gap-1.5 px-4 py-2" });

/**
 * Keeps a one-finger drag on the large screenshot from becoming a browser
 * gesture, so the swipe is the gallery's alone: otherwise Chrome treats the
 * swipe as a pan that goes nowhere and swallows the next tap, on Next or on
 * Close. Two fingers still zoom. React's touch handlers are passive and
 * cannot do this, hence the listener of its own.
 */
function claimOneFingerDrag(el: HTMLElement | null) {
  if (el === null) return;
  const claim = (event: TouchEvent) => {
    if (event.touches.length === 1 && event.cancelable) event.preventDefault();
  };
  el.addEventListener("touchmove", claim, { passive: false });
  return () => el.removeEventListener("touchmove", claim);
}

/**
 * An app's screenshots in a row that scrolls sideways, each at a fixed size.
 * Choosing one opens it large in a lightbox on the page itself (Base UI's
 * dialog, through Kumo), with previous and next, a counter, and a close
 * button; Escape or a click outside it closes it, and focus goes back to the
 * screenshot last shown. Each screenshot is still a link to the image, so it
 * opens without JavaScript, and in a new tab with a modifier key.
 */
export function ScreenshotGallery({
  images,
  appName,
}: {
  images: readonly GalleryImage[];
  appName: string;
}) {
  const count = images.length;
  const [box, dispatch] = useReducer(
    (state: LightboxState, action: LightboxAction) => lightbox(state, action, count),
    LIGHTBOX_CLOSED,
  );
  const thumbs = useRef<Array<HTMLAnchorElement | null>>([]);
  const touch = useRef<{ id: number; x: number; y: number } | null>(null);

  // The neighbours load while one screenshot is looked at, so paging is instant.
  useEffect(() => {
    if (!box.open || count < 2) return;
    for (const i of [box.index + 1, box.index - 1 + count]) {
      const image = images[i % count];
      if (image !== undefined) new Image().src = image.url;
    }
  }, [box.open, box.index, images, count]);

  if (count === 0) return null;
  const shown = images[box.index] ?? images[0];

  function onThumbClick(event: MouseEvent<HTMLAnchorElement>, index: number) {
    if (!opensLightbox(event)) return;
    event.preventDefault();
    dispatch({ type: "open", index });
  }

  // Enter follows the link, and so opens the lightbox; Space does too, as on a button.
  function onThumbKey(event: KeyboardEvent<HTMLAnchorElement>, index: number) {
    if (event.key !== " ") return;
    event.preventDefault();
    dispatch({ type: "open", index });
  }

  function onPopupKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!isLightboxKey(event.key)) return;
    event.preventDefault();
    dispatch({ type: "key", key: event.key });
  }

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") return;
    touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent<HTMLElement>) {
    const start = touch.current;
    touch.current = null;
    if (start === null || start.id !== event.pointerId) return;
    const action = swipeAction(event.clientX - start.x, event.clientY - start.y);
    if (action !== null) dispatch({ type: action });
  }

  return (
    <section aria-label={`Screenshots of ${appName}`}>
      <ul className="m-0 flex list-none snap-x snap-mandatory gap-3 overflow-x-auto p-0.5 pb-2">
        {images.map((image, i) => (
          <li key={image.url} className="shrink-0 snap-start">
            <figure className="m-0 grid gap-1.5">
              <a
                ref={(el) => {
                  thumbs.current[i] = el;
                }}
                href={image.url}
                rel="noopener noreferrer"
                aria-haspopup="dialog"
                aria-label={`Screenshot ${positionLabel(i, count)}: ${image.alt}. Opens it larger.`}
                onClick={(event) => onThumbClick(event, i)}
                onKeyDown={(event) => onThumbKey(event, i)}
                className="block cursor-zoom-in rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background"
              >
                <img
                  src={image.url}
                  alt=""
                  width={480}
                  height={300}
                  loading="lazy"
                  decoding="async"
                  className="aspect-[8/5] h-auto w-[min(480px,80vw)] rounded-lg border border-fd-border bg-fd-secondary object-cover object-top"
                />
              </a>
              {/* The link's name already carries the description. */}
              <figcaption
                aria-hidden="true"
                className="line-clamp-1 w-[min(480px,80vw)] text-fd-muted-foreground text-xs"
              >
                {image.alt}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>

      <Dialog.Root
        open={box.open}
        onOpenChange={(open) => {
          if (!open) dispatch({ type: "close" });
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/75 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
          <Dialog.Popup
            // Base UI hides the rest of the page from assistive technology
            // without saying so on the dialog itself.
            aria-modal="true"
            // Back in the row, the screenshot last shown is the one in focus.
            finalFocus={() => thumbs.current[box.index] ?? true}
            onKeyDown={onPopupKey}
            className="fixed top-1/2 left-1/2 z-50 grid max-h-dvh w-full -translate-x-1/2 -translate-y-1/2 gap-3 border-fd-border bg-fd-background p-3 text-fd-foreground shadow-2xl outline-none transition-[opacity,scale] duration-150 data-[ending-style]:scale-[0.98] data-[starting-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none sm:w-[min(calc(100vw-4rem),80rem)] sm:rounded-xl sm:border sm:p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="grid min-w-0">
                <Dialog.Title className="truncate font-semibold text-base">
                  {appName} screenshots
                </Dialog.Title>
                <span className="text-fd-muted-foreground text-sm tabular-nums">
                  <span aria-live="polite">{positionLabel(box.index, count)}</span>
                </span>
              </div>
              <Dialog.Close
                aria-label="Close"
                className={buttonVariants({ variant: "ghost", size: "icon" })}
              >
                <XIcon aria-hidden="true" />
              </Dialog.Close>
            </div>
            {shown !== undefined && (
              <figure
                ref={claimOneFingerDrag}
                className="m-0 grid min-h-0 justify-items-center gap-2"
              >
                {/* Full width and as tall as the window allows; a sideways swipe pages. */}
                <img
                  key={shown.url}
                  src={shown.url}
                  alt={shown.alt}
                  decoding="async"
                  onPointerDown={onPointerDown}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => {
                    touch.current = null;
                  }}
                  draggable={false}
                  className="aspect-[16/10] max-h-[calc(100dvh-11rem)] w-full select-none rounded-md bg-fd-secondary object-contain sm:max-h-[calc(100dvh-13rem)]"
                />
                {/* The image's alt already names it for screen readers. */}
                <figcaption
                  aria-hidden="true"
                  className="line-clamp-2 text-center text-fd-muted-foreground text-sm"
                >
                  {shown.alt}
                </figcaption>
              </figure>
            )}
            {count > 1 && (
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
    </section>
  );
}
