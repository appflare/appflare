import { MorphMark } from "@appflare/brand/loader";
import { CLOUD_ORANGE, CLOUD_PATH, INK_PATHS, VIEW_BOX } from "@appflare/brand/logo-paths";
import { cn } from "@cloudflare/kumo";
import { type PointerEvent, useState } from "react";

/** Black on light surfaces, white on dark ones, following Kumo's colour scheme. */
const INK = "light-dark(#000, #fff)";

/** The mark's four quadrants are the first paths of the full logo; the letters follow. */
const MARK_PATHS = INK_PATHS.slice(0, 4);
const LETTER_PATHS = INK_PATHS.slice(4);

/**
 * One pass of the loading indicator's motion when a mouse or pen enters
 * the logo. A pass is never restarted before it ends, so the next one
 * starts on the next entry after that. Touch is left alone (a tap follows
 * the link at once), and so is anyone who asks for reduced motion.
 */
function useMorphOnce(enabled: boolean) {
  const [playing, setPlaying] = useState(false);
  const onPointerEnter = (event: PointerEvent) => {
    if (playing || event.pointerType === "touch") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setPlaying(true);
  };
  return {
    playing,
    onPassEnd: () => setPlaying(false),
    handlers: enabled ? { onPointerEnter } : {},
  };
}

/**
 * The full Appflare logo (mark and word) as inline SVG. The mark and letters
 * are black in light mode and white in dark mode, through `light-dark()`,
 * which follows Kumo's colour scheme the way its own tokens do; the cloud
 * stays orange. `height` is in pixels; the width follows the logo's aspect
 * ratio. The logo is labelled "Appflare" for assistive technology.
 *
 * With `morphOnHover`, the mark plays the loading indicator's motion once
 * when the pointer enters the logo, then rests as the plain mark.
 */
export function Logo({
  height = 20,
  className,
  morphOnHover = false,
}: {
  height?: number;
  className?: string;
  morphOnHover?: boolean;
}) {
  const morph = useMorphOnce(morphOnHover);
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
      {...morph.handlers}
    >
      {morphOnHover ? (
        <>
          {/* The square mark scaled into the logo's mark box, same place and size. */}
          <svg viewBox="0 0 44 44" width={VIEW_BOX.height} height={VIEW_BOX.height} aria-hidden>
            <MorphMark
              ink={INK}
              motion={morph.playing ? "pass" : "rest"}
              onPassEnd={morph.onPassEnd}
            />
          </svg>
          <g style={{ fill: INK }}>
            {LETTER_PATHS.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
        </>
      ) : (
        <>
          <g style={{ fill: INK }}>
            {INK_PATHS.map((d) => (
              <path key={d} d={d} />
            ))}
          </g>
          <path fill={CLOUD_ORANGE} d={CLOUD_PATH} />
        </>
      )}
    </svg>
  );
}

/**
 * The mark alone (no word), square, for the folded sidebar. Same colours as
 * {@link Logo}. Decorative: whatever holds it carries the name.
 */
export function LogoMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${VIEW_BOX.height} ${VIEW_BOX.height}`}
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      aria-hidden
    >
      <g style={{ fill: INK }}>
        {MARK_PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <path fill={CLOUD_ORANGE} d={CLOUD_PATH} />
    </svg>
  );
}
