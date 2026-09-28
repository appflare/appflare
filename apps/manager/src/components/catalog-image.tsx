import { cn, SkeletonLine } from "@cloudflare/kumo";
import { type CSSProperties, type ReactNode, useCallback, useState } from "react";

/**
 * One catalog image in a box whose size never depends on the image. The
 * catalog index gives a url and a hash per image but no dimensions, so the
 * caller fixes the box (a size, or a width and an aspect ratio) from what that
 * kind of image is meant to be: icons square, covers 1200x630, screenshots
 * 16:10. The image is fitted into the box, so one of another shape still
 * leaves everything around it where it was.
 *
 * Until the image arrives the box shows Kumo's skeleton; the image then fades
 * in (at once for reduced motion). One the browser already has is shown on
 * the first paint, without the skeleton. When it fails the box stays, quiet
 * and empty (no broken-image icon, no alt text), or shows `fallback`.
 */

export type ImageStatus = "loading" | "loaded" | "failed";

interface ImageState {
  src: string;
  status: ImageStatus;
  /** Taller than wide, known once loaded. */
  portrait: boolean;
}

/**
 * Where an `<img>` is with `src`. The returned `ref` reads `complete` as the
 * element mounts, before the browser paints, so a cached image counts as
 * loaded at once; `onLoad` and `onError` cover the rest. A new `src` starts
 * over at "loading".
 */
export function useImageStatus(src: string): {
  status: ImageStatus;
  portrait: boolean;
  ref: (img: HTMLImageElement | null) => void;
  onLoad: (img: HTMLImageElement) => void;
  onError: () => void;
} {
  const [state, setState] = useState<ImageState>({ src, status: "loading", portrait: false });
  const onLoad = useCallback(
    (img: HTMLImageElement) =>
      setState({ src, status: "loaded", portrait: img.naturalHeight > img.naturalWidth }),
    [src],
  );
  const onError = useCallback(() => setState({ src, status: "failed", portrait: false }), [src]);
  const ref = useCallback(
    (img: HTMLImageElement | null) => {
      if (!img?.complete) return;
      // `complete` is also true for an image that failed. One with a width has
      // loaded; an SVG with only a `viewBox` has none even when it loaded, so
      // `decode()` settles which it is (it rejects for a broken image).
      if (img.naturalWidth > 0) onLoad(img);
      else img.decode().then(() => onLoad(img), onError);
    },
    [onLoad, onError],
  );
  const current = state.src === src;
  return {
    status: current ? state.status : "loading",
    portrait: current && state.portrait,
    ref,
    onLoad,
    onError,
  };
}

export function CatalogImage({
  src,
  alt,
  fit = "contain",
  eager = false,
  fallback,
  className,
  style,
}: {
  src: string;
  /** What a screen reader reads; empty for a decorative image. */
  alt: string;
  /**
   * How the image sits in the box: letterboxed (`contain`), filling it
   * (`cover`), or letterboxed unless it is portrait, which fills the box's
   * width from its top instead of shrinking to a thin strip (`contain-landscape`).
   */
  fit?: "contain" | "cover" | "contain-landscape";
  /** Loads at once and decodes with the page: for the first image a reader sees. */
  eager?: boolean;
  /** Shown in place of the empty box when the image fails. */
  fallback?: ReactNode;
  /** Sizes and shapes the box; it is `position: relative` and clips the image. */
  className?: string;
  /** Sizes the box where a class cannot: a pixel size, an aspect ratio. */
  style?: CSSProperties;
}) {
  const { status, portrait, ref, onLoad, onError } = useImageStatus(src);
  const boxClass = cn("relative block overflow-hidden bg-kumo-recessed", className);
  if (status === "failed") {
    if (fallback !== undefined) return fallback;
    // The image is gone; the empty box keeps its name for a screen reader.
    return alt === "" ? (
      <span data-image-status={status} style={style} className={boxClass} />
    ) : (
      <span
        data-image-status={status}
        role="img"
        aria-label={alt}
        style={style}
        className={boxClass}
      />
    );
  }
  const cover = fit === "cover" || (fit === "contain-landscape" && portrait);
  return (
    <span data-image-status={status} style={style} className={boxClass}>
      {status === "loading" && (
        // Fixed width and timing: Kumo picks random ones otherwise, which the
        // server and the browser would pick differently.
        <SkeletonLine
          minWidth={100}
          maxWidth={100}
          minDuration={1.5}
          maxDuration={1.5}
          minDelay={0}
          maxDelay={0}
          className="absolute inset-0 h-full rounded-none motion-reduce:after:animate-none"
        />
      )}
      <img
        ref={ref}
        src={src}
        alt={alt}
        loading={eager ? "eager" : "lazy"}
        decoding={eager ? "auto" : "async"}
        onLoad={(event) => onLoad(event.currentTarget)}
        onError={onError}
        className={cn(
          "absolute inset-0 size-full transition-opacity duration-200 motion-reduce:transition-none",
          cover ? "object-cover" : "object-contain",
          fit === "contain-landscape" && portrait && "object-top",
          status === "loaded" ? "opacity-100" : "opacity-0",
        )}
      />
    </span>
  );
}
