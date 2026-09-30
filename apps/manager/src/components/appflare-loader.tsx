import { cn } from "@cloudflare/kumo";
import { useEffect, useId, useRef } from "react";
import {
  CLOUD_INDEX,
  CLOUD_QUADRANT_INDEX,
  LOOP_SECONDS,
  MARK_SHAPES,
  morphFrame,
  morphProgress,
  PASS_START_SECONDS,
  turnDegrees,
} from "./logo-morph";
import { CLOUD_ORANGE, SQUARE_VIEW_BOX } from "./logo-paths";

/** The sizes Kumo's own `Loader` takes: a preset name or pixels. */
export type AppflareLoaderSize = "sm" | "base" | "lg" | number;

const PRESET_PIXELS = { sm: 16, base: 24, lg: 32 } as const;

/** The loader's width and height in pixels, resolved the way Kumo's `Loader` resolves its size. */
export function loaderPixels(size: AppflareLoaderSize): number {
  return typeof size === "number" ? size : PRESET_PIXELS[size];
}

const CENTRE = SQUARE_VIEW_BOX / 2;

/** A frame callback; returning true takes it off the clock. */
type Frame = (now: number) => boolean | undefined;

const frames = new Set<Frame>();
let pending = 0;

function tick(now: number) {
  for (const frame of frames) if (frame(now)) frames.delete(frame);
  pending = frames.size ? requestAnimationFrame(tick) : 0;
}

/**
 * One animation-frame loop for every moving mark on the page. Loaders read
 * the loop's time from the same clock, so they all move together.
 */
function onEveryFrame(frame: Frame): () => void {
  frames.add(frame);
  if (!pending) pending = requestAnimationFrame(tick);
  return () => {
    frames.delete(frame);
    if (!frames.size && pending) {
      cancelAnimationFrame(pending);
      pending = 0;
    }
  };
}

/**
 * Draws the mark inside `turn` at `seconds` into the loop, or at rest (the
 * plain mark, upright) when `seconds` is null.
 */
function paint(turn: SVGGElement, seconds: number | null) {
  const progress = seconds === null ? 1 : morphProgress(seconds);
  const shapes = morphFrame(progress);
  turn.querySelectorAll("path[data-shape]").forEach((path, index) => {
    path.setAttribute("d", shapes[index] ?? "");
  });
  // Mid-morph, the cloud's outline is cut from the ink around it, so the
  // white gap between them holds in every frame. The finished mark has it.
  const between = progress > 0 && progress < 1;
  turn
    .querySelector("path[data-gap]")
    ?.setAttribute("d", between ? (shapes[CLOUD_INDEX] ?? "") : "");
  const degrees = seconds === null ? 0 : turnDegrees(seconds);
  if (degrees) turn.setAttribute("transform", `rotate(${degrees} ${CENTRE} ${CENTRE})`);
  else turn.removeAttribute("transform");
}

/**
 * How a {@link MorphMark} moves: `loop` for as long as it is shown (the
 * loading indicator), `pass` once through from the full mark back to it
 * (the logo's hover), or `rest` for the plain mark.
 */
export type MorphMotion = "loop" | "pass" | "rest";

/**
 * The Appflare mark in a 44-unit box, able to play the loading motion:
 * the four quadrants as arcs of a thin ring that spins, then each arc
 * reshapes into its quadrant so the ring closes on the logo's X, holds a
 * moment, and opens back into the ring (see `logo-morph.ts`). React draws
 * the plain mark; the motion rewrites the paths in place on each frame.
 * A looping mark stays still when the system asks for reduced motion.
 *
 * The quadrants take `ink` as their fill (any CSS colour, `currentColor`
 * or `light-dark()` included); the cloud stays orange. The gap mask's id
 * comes from `useId()`, so any number of marks can share a page.
 */
export function MorphMark({
  ink,
  motion,
  onPassEnd,
}: {
  ink: string;
  motion: MorphMotion;
  /** Called when a `pass` has played through. */
  onPassEnd?: () => void;
}) {
  // React's ids can hold characters that need escaping inside `url(#…)`.
  const gapId = `appflare-gap-${useId().replace(/[^\w-]/g, "")}`;
  const turnRef = useRef<SVGGElement>(null);
  const onPassEndRef = useRef(onPassEnd);
  onPassEndRef.current = onPassEnd;

  useEffect(() => {
    const turn = turnRef.current;
    if (!turn || motion === "rest") return;
    if (motion === "pass") {
      let start: number | undefined;
      const stop = onEveryFrame((now) => {
        start ??= now;
        const elapsed = (now - start) / 1000;
        if (elapsed < LOOP_SECONDS) {
          paint(turn, PASS_START_SECONDS + elapsed);
          return false;
        }
        paint(turn, null);
        onPassEndRef.current?.();
        return true;
      });
      return () => {
        stop();
        paint(turn, null);
      };
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stop: (() => void) | undefined;
    const follow = () => {
      stop?.();
      stop = undefined;
      if (reduce.matches) paint(turn, null);
      else
        stop = onEveryFrame((now) => {
          paint(turn, now / 1000);
          return false;
        });
    };
    follow();
    reduce.addEventListener?.("change", follow);
    return () => {
      reduce.removeEventListener?.("change", follow);
      stop?.();
    };
  }, [motion]);

  return (
    <g ref={turnRef} className="appflare-morph-turn">
      <mask id={gapId} maskUnits="userSpaceOnUse" x={-10} y={-10} width={64} height={64}>
        <rect x={-10} y={-10} width={64} height={64} fill="#fff" />
        <path data-gap="" fill="#000" stroke="#000" strokeWidth={1.5} strokeLinejoin="round" d="" />
      </mask>
      <g style={{ fill: ink }}>
        {MARK_SHAPES.slice(0, CLOUD_INDEX).map((d, index) => (
          <path
            key={d}
            data-shape=""
            d={d}
            mask={index === CLOUD_QUADRANT_INDEX ? `url(#${gapId})` : undefined}
          />
        ))}
      </g>
      <path data-shape="" fill={CLOUD_ORANGE} d={MARK_SHAPES[CLOUD_INDEX]} />
    </g>
  );
}

/**
 * Appflare's loading indicator: the mark as a thin ring that spins, whose
 * arcs grow into the quadrants and close on the logo's X, hold a moment,
 * and open back into the ring, every 2 s. Every loader on a page moves in
 * step. Same props as Kumo's `Loader` (`size` "sm" 16 px, "base" 24 px,
 * "lg" 32 px, or pixels); the quadrants take the text colour and the cloud
 * stays orange. When the system asks for reduced motion the still mark
 * pulses in opacity instead. With `aria-hidden` it is decoration only (no
 * status role or label), for when something else, such as a button's
 * `aria-busy`, already says that work is under way.
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
      <MorphMark ink="currentColor" motion="loop" />
    </svg>
  );
}
