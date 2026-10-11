import { useRef } from "react";
import { track } from "../../analytics/analytics.ts";
import { positionLabel } from "./gallery-navigation.ts";
import { type GalleryImage, Lightbox, lightboxOpener, useLightbox } from "./lightbox.tsx";

export type { GalleryImage } from "./lightbox.tsx";

/**
 * An app's screenshots in a row that scrolls sideways, each at a fixed size.
 * Choosing one opens it large in the {@link Lightbox}, and focus comes back to
 * the screenshot last shown. Each screenshot is still a link to the image, so
 * it opens without JavaScript, and in a new tab with a modifier key.
 */
export function ScreenshotGallery({
  images,
  appName,
  slug,
}: {
  images: readonly GalleryImage[];
  appName: string;
  /** The app's slug, for {@link SiteEvents.screenshot_opened}. */
  slug: string;
}) {
  const count = images.length;
  const [box, dispatch] = useLightbox(count);
  const thumbs = useRef<Array<HTMLAnchorElement | null>>([]);

  if (count === 0) return null;

  function open(index: number) {
    dispatch({ type: "open", index });
    track("screenshot_opened", { slug, index });
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
                {...lightboxOpener(() => open(i))}
                aria-label={`Screenshot${count > 1 ? ` ${positionLabel(i, count)}` : ""}: ${image.alt}. Opens it larger.`}
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

      <Lightbox
        title={count > 1 ? `${appName} screenshots` : `${appName} screenshot`}
        images={images}
        state={box}
        dispatch={dispatch}
        // Back in the row, the screenshot last shown is the one in focus.
        returnFocus={() => thumbs.current[box.index] ?? null}
      />
    </section>
  );
}
