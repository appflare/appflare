import { cn } from "@cloudflare/kumo";
import { CLOUD_ORANGE, CLOUD_PATH, INK_PATHS, VIEW_BOX } from "./logo-paths";

/**
 * The full Appflare logo (mark and word) as inline SVG. The mark and letters
 * are black in light mode and white in dark mode, through `light-dark()`,
 * which follows Kumo's colour scheme the way its own tokens do; the cloud
 * stays orange. `height` is in pixels; the width follows the logo's aspect
 * ratio. The logo is labelled "Appflare" for assistive technology.
 */
export function Logo({ height = 20, className }: { height?: number; className?: string }) {
  const width = Math.round((height * VIEW_BOX.width * 100) / VIEW_BOX.height) / 100;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`}
      width={width}
      height={height}
      className={cn("shrink-0", className)}
      role="img"
      aria-label="Appflare"
    >
      <g style={{ fill: "light-dark(#000, #fff)" }}>
        {INK_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <path fill={CLOUD_ORANGE} d={CLOUD_PATH} />
    </svg>
  );
}
