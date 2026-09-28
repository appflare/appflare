import { cn } from "@cloudflare/kumo";
import { useId } from "react";
import { CLOUD_ORANGE, SQUARE_CLOUD_PATH, SQUARE_INK_PATHS, SQUARE_VIEW_BOX } from "./logo-paths";

/** The sizes Kumo's own `Loader` takes: a preset name or pixels. */
export type AppflareLoaderSize = "sm" | "base" | "lg" | number;

const PRESET_PIXELS = { sm: 16, base: 24, lg: 32 } as const;

/** The loader's width and height in pixels, resolved the way Kumo's `Loader` resolves its size. */
export function loaderPixels(size: AppflareLoaderSize): number {
  return typeof size === "number" ? size : PRESET_PIXELS[size];
}

/**
 * The Appflare mark behind a circular mask, drawn in a 44-unit box. Its
 * motion lives in `styles.css`: the mask is a ring whose `stroke-width`
 * swells from a thin band into a disc that uncovers the whole mark, while
 * the mark turns into place, holds, and turns on as the ring thins again.
 * At rest (no animation class on an ancestor) the whole mark shows.
 *
 * The quadrants take `ink` as their fill (any CSS colour, `currentColor`
 * or `light-dark()` included); the cloud stays orange. The mask id comes
 * from `useId()`, so any number of marks can share a page.
 */
export function MorphMark({ ink }: { ink: string }) {
  // React's ids can hold characters that need escaping inside `url(#…)`.
  const maskId = `appflare-morph-${useId().replace(/[^\w-]/g, "")}`;
  const centre = SQUARE_VIEW_BOX / 2;
  return (
    <>
      <mask id={maskId} maskUnits="userSpaceOnUse" x={-10} y={-10} width={64} height={64}>
        <circle className="appflare-morph-ring" cx={centre} cy={centre} r={16} />
      </mask>
      <g mask={`url(#${maskId})`}>
        <g className="appflare-morph-turn">
          <g style={{ fill: ink }}>
            {SQUARE_INK_PATHS.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          <path fill={CLOUD_ORANGE} d={SQUARE_CLOUD_PATH} />
        </g>
      </g>
    </>
  );
}

/**
 * Appflare's loading indicator: a thin ring cut from the mark spins,
 * thickens into the full mark, holds, and thins back, every 2 s. Same
 * props as Kumo's `Loader` (`size` "sm" 16 px, "base" 24 px, "lg" 32 px,
 * or pixels); the quadrants take the text colour and the cloud stays
 * orange. When the system asks for reduced motion the still mark pulses
 * in opacity instead. With `aria-hidden` it is decoration only (no status
 * role or label), for when something else, such as a button's `aria-busy`,
 * already says that work is under way.
 */
export function AppflareLoader({
  size = "base",
  className,
  "aria-label": ariaLabel = "Loading",
  "aria-hidden": ariaHidden = false,
}: {
  size?: AppflareLoaderSize;
  className?: string;
  "aria-label"?: string;
  "aria-hidden"?: boolean;
}) {
  const pixels = loaderPixels(size);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${SQUARE_VIEW_BOX} ${SQUARE_VIEW_BOX}`}
      width={pixels}
      height={pixels}
      className={cn("appflare-loader shrink-0", className)}
      role={ariaHidden ? undefined : "status"}
      aria-label={ariaHidden ? undefined : ariaLabel}
      aria-hidden={ariaHidden || undefined}
    >
      <MorphMark ink="currentColor" />
    </svg>
  );
}
