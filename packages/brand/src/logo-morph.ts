import { SQUARE_CLOUD_PATH, SQUARE_INK_PATHS, SQUARE_VIEW_BOX } from "./logo-paths.ts";

/**
 * The loading indicator's motion, as plain geometry (no DOM, so it runs in
 * tests and on the server). The square mark's five shapes (four quadrants,
 * then the cloud) each have a ring form: a clean arc of the thin ring that
 * spins while work is under way. The morph reshapes every arc into its shape,
 * so the ring closes on the logo's own X, and back again.
 *
 * One loop is {@link LOOP_SECONDS}: the ring spins and settles upright, the
 * arcs grow into the mark, the mark holds for a moment, then the arcs thin
 * out again as the ring starts to turn.
 */

export const LOOP_SECONDS = 2;

/** The moment in the loop where the hold ends; a single pass starts and ends here. */
export const PASS_START_SECONDS = 1.2;

const CENTRE = SQUARE_VIEW_BOX / 2;
/** The thin ring: a band from 14.2 to 17.8 of the 44-unit box. */
const RING_INNER = 14.2;
const RING_OUTER = 17.8;
/** Half the gap between two arcs of the ring, in degrees. */
const HALF_GAP = 1.6;
/** Distance between outline points, in box units. */
const STEP = 0.2;
/** Width of the smoothing that softens the in-between frames, in points. */
const SMOOTHING = 5;
const DEG = Math.PI / 180;

type Point = [number, number];
/** A point in polar form around the centre: angle in radians, then radius. */
type Polar = [number, number];

/**
 * Each shape's arc: angles in degrees (0 is right, clockwise on screen) and
 * the band it fills. The top-right quadrant's arc is all cloud; its ink
 * starts as a line on the arc's outer edge and grows out over the cloud.
 */
const ARCS: { angles: [number, number]; radii: [number, number] }[] = [
  { angles: [-180 + HALF_GAP, -90 - HALF_GAP], radii: [RING_INNER, RING_OUTER] },
  { angles: [-90 + HALF_GAP, -HALF_GAP], radii: [RING_OUTER, RING_OUTER] },
  { angles: [HALF_GAP, 90 - HALF_GAP], radii: [RING_INNER, RING_OUTER] },
  { angles: [90 + HALF_GAP, 180 - HALF_GAP], radii: [RING_INNER, RING_OUTER] },
  { angles: [-90 + HALF_GAP, -HALF_GAP], radii: [RING_INNER, RING_OUTER] },
];

/** The five shapes as drawn at rest: the quadrants clockwise from top left, then the cloud. */
export const MARK_SHAPES: readonly string[] = [...SQUARE_INK_PATHS, SQUARE_CLOUD_PATH];

/** Index of the cloud in {@link MARK_SHAPES}, and of the ink quadrant that holds it. */
export const CLOUD_INDEX = 4;
export const CLOUD_QUADRANT_INDEX = 1;

// --- Outline sampling -------------------------------------------------------

/**
 * The outline of a closed path that uses only M, L, H, V, C, S and Z
 * (relative or absolute), flattened into a polyline.
 */
function flatten(d: string): Point[] {
  const tokens = d.match(/[MLHVCSZmlhvcsz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const points: Point[] = [];
  let x = 0;
  let y = 0;
  let control: Point | null = null;
  let command = "";
  let i = 0;
  const number = () => Number(tokens[i++]);
  const curve = (c1: Point, c2: Point, end: Point) => {
    const from: Point = [x, y];
    for (let k = 1; k <= 24; k++) {
      const t = k / 24;
      const u = 1 - t;
      points.push([
        u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
        u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
      ]);
    }
    control = c2;
    [x, y] = end;
  };
  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i] ?? "")) command = tokens[i++] ?? "";
    const relative = command === command.toLowerCase();
    const dx = relative ? x : 0;
    const dy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case "M":
        x = dx + number();
        y = dy + number();
        points.push([x, y]);
        control = null;
        // Further pairs after a move are lines.
        command = relative ? "l" : "L";
        break;
      case "L":
        x = dx + number();
        y = dy + number();
        points.push([x, y]);
        control = null;
        break;
      case "H":
        x = dx + number();
        points.push([x, y]);
        control = null;
        break;
      case "V":
        y = dy + number();
        points.push([x, y]);
        control = null;
        break;
      case "C": {
        const c1: Point = [dx + number(), dy + number()];
        const c2: Point = [dx + number(), dy + number()];
        curve(c1, c2, [dx + number(), dy + number()]);
        break;
      }
      case "S": {
        const previous: Point | null = control;
        const c1: Point = previous ? [2 * x - previous[0], 2 * y - previous[1]] : [x, y];
        const c2: Point = [dx + number(), dy + number()];
        curve(c1, c2, [dx + number(), dy + number()]);
        break;
      }
      case "Z":
        control = null;
        break;
      default:
        throw new Error(`Unsupported path command ${command}`);
    }
  }
  return points;
}

/** Points spaced {@link STEP} apart along the closed outline of `d`. */
export function sampleOutline(d: string): Point[] {
  const line = flatten(d);
  const first = line[0];
  if (first) line.push(first);
  const lengths = [0];
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1] as Point;
    const [bx, by] = line[k] as Point;
    lengths.push((lengths[k - 1] as number) + Math.hypot(bx - ax, by - ay));
  }
  const total = lengths[lengths.length - 1] as number;
  const count = Math.ceil(total / STEP);
  const samples: Point[] = [];
  let segment = 1;
  for (let n = 0; n < count; n++) {
    const at = (n * total) / count;
    while ((lengths[segment] as number) < at) segment++;
    const [ax, ay] = line[segment - 1] as Point;
    const [bx, by] = line[segment] as Point;
    const from = lengths[segment - 1] as number;
    const span = (lengths[segment] as number) - from || 1;
    const f = (at - from) / span;
    samples.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
  }
  return samples;
}

// --- Ring forms -------------------------------------------------------------

const radius = ([x, y]: Point) => Math.hypot(x - CENTRE, y - CENTRE);

/** Cumulative lengths along the points of `chain` (indices into `points`). */
function chainLengths(points: Point[], chain: number[]): number[] {
  const lengths = [0];
  for (let k = 1; k < chain.length; k++) {
    const [ax, ay] = points[chain[k - 1] as number] as Point;
    const [bx, by] = points[chain[k] as number] as Point;
    lengths.push((lengths[k - 1] as number) + Math.hypot(bx - ax, by - ay));
  }
  return lengths;
}

/**
 * Each outline point's place on the shape's arc, in polar form. The outline
 * splits at its two angular extremes into an outer edge and an inner edge.
 * The outer edge spreads evenly along the arc's outer side. Along the inner
 * edge, the stretches outside the ring's inner radius are the gap edges and
 * become the arc's straight end cuts; the stretch inside becomes the arc's
 * inner side. So in between, the gap edges only grow inward, and the inside
 * closes on the logo's X.
 */
function ringForm(
  points: Point[],
  [a0, a1]: [number, number],
  [r0, r1]: [number, number],
): Polar[] {
  const n = points.length;
  const middle = ((a0 + a1) / 2) * DEG;
  const relative = points.map(([x, y]) => {
    let t = Math.atan2(y - CENTRE, x - CENTRE) - middle;
    while (t > Math.PI) t -= 2 * Math.PI;
    while (t < -Math.PI) t += 2 * Math.PI;
    return t;
  });
  let lowest = 0;
  let highest = 0;
  relative.forEach((t, k) => {
    if (t < (relative[lowest] as number)) lowest = k;
    if (t > (relative[highest] as number)) highest = k;
  });
  const chain = (from: number, to: number) => {
    const indices: number[] = [];
    for (let k = from; ; k = (k + 1) % n) {
      indices.push(k);
      if (k === to) break;
    }
    return indices;
  };
  const first = chain(lowest, highest);
  const second = chain(highest, lowest);
  const meanRadius = (c: number[]) =>
    c.reduce((sum, k) => sum + radius(points[k] as Point), 0) / c.length;
  const firstIsOuter = meanRadius(first) > meanRadius(second);
  const outer = firstIsOuter ? first : second;
  const inner = firstIsOuter ? second : first;
  const [outerFrom, outerTo] = firstIsOuter ? [a0, a1] : [a1, a0];

  const form: Polar[] = new Array(n);
  const alongArc = (c: number[], from: number, to: number, r: number) => {
    const lengths = chainLengths(points, c);
    const total = lengths[lengths.length - 1] || 1;
    c.forEach((k, j) => {
      form[k] = [(from + ((to - from) * (lengths[j] as number)) / total) * DEG, r];
    });
  };
  const alongCut = (c: number[], angle: number, from: number, to: number) => {
    const lengths = chainLengths(points, c);
    const total = lengths[lengths.length - 1] || 1;
    c.forEach((k, j) => {
      form[k] = [angle * DEG, from + ((to - from) * (lengths[j] as number)) / total];
    });
  };

  alongArc(outer, outerFrom, outerTo, r1);
  let enters = inner.findIndex((k) => radius(points[k] as Point) < r0);
  let leaves =
    inner.length - 1 - [...inner].reverse().findIndex((k) => radius(points[k] as Point) < r0);
  if (enters < 0) {
    enters = inner.length >> 1;
    leaves = enters;
  }
  alongCut(inner.slice(0, enters + 1), outerTo, r1, r0);
  alongArc(inner.slice(enters, leaves + 1), outerTo, outerFrom, r0);
  alongCut(inner.slice(leaves), outerFrom, r0, r1);
  return form;
}

interface MorphShape {
  ring: Polar[];
  mark: Polar[];
}

let shapes: MorphShape[] | undefined;

/** Both forms of every shape, worked out on first use. */
function morphShapes(): MorphShape[] {
  shapes ??= MARK_SHAPES.map((d, index) => {
    const points = sampleOutline(d);
    const arc = ARCS[index] as (typeof ARCS)[number];
    const ring = ringForm(points, arc.angles, arc.radii);
    const mark = points.map((point, k): Polar => {
      let angle = Math.atan2(point[1] - CENTRE, point[0] - CENTRE);
      const start = (ring[k] as Polar)[0];
      // Turn the short way round.
      while (angle - start > Math.PI) angle -= 2 * Math.PI;
      while (angle - start < -Math.PI) angle += 2 * Math.PI;
      return [angle, radius(point)];
    });
    return { ring, mark };
  });
  return shapes;
}

// --- Frames -----------------------------------------------------------------

function shapeAt({ ring, mark }: MorphShape, progress: number): string {
  const n = ring.length;
  let points: Point[] = ring.map(([ra, rr], k) => {
    const [ma, mr] = mark[k] as Polar;
    const angle = ra + (ma - ra) * progress;
    const r = rr + (mr - rr) * progress;
    return [CENTRE + Math.cos(angle) * r, CENTRE + Math.sin(angle) * r];
  });
  // Soften the in-between frames only; the ring and the mark stay exact.
  const weight = Math.sin(Math.PI * progress);
  if (weight > 0.001) {
    const reach = SMOOTHING * 2;
    const kernel = Array.from({ length: 2 * reach + 1 }, (_, j) =>
      Math.exp(-((j - reach) ** 2) / (2 * SMOOTHING * SMOOTHING)),
    );
    const kernelSum = kernel.reduce((a, b) => a + b, 0);
    points = points.map((point, k) => {
      let sx = 0;
      let sy = 0;
      for (let j = -reach; j <= reach; j++) {
        const [px, py] = points[(k + j + n) % n] as Point;
        const g = kernel[j + reach] as number;
        sx += g * px;
        sy += g * py;
      }
      return [
        point[0] + weight * (sx / kernelSum - point[0]),
        point[1] + weight * (sy / kernelSum - point[1]),
      ];
    });
  }
  return `M${points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join("L")}Z`;
}

let lastProgress = Number.NaN;
let lastFrame: string[] = [];

/**
 * The five shapes' path data at `progress` (0 the ring, 1 the mark). At 1
 * these are the logo's own paths. Every loader on a page asks for the same
 * frame, so the last one is kept.
 */
export function morphFrame(progress: number): string[] {
  if (progress >= 1) return [...MARK_SHAPES];
  if (progress !== lastProgress) {
    lastFrame = morphShapes().map((shape) => shapeAt(shape, Math.max(0, progress)));
    lastProgress = progress;
  }
  return lastFrame;
}

// --- Timeline ---------------------------------------------------------------

/** CSS's `cubic-bezier()` as a function of time. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, u: number) =>
    3 * (1 - u) * (1 - u) * u * a + 3 * (1 - u) * u * u * b + u * u * u;
  return (t: number) => {
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 24; k++) {
      const u = (lo + hi) / 2;
      if (at(x1, x2, u) < t) lo = u;
      else hi = u;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const settle = cubicBezier(0.2, 0.6, 0.35, 1);
const launch = cubicBezier(0.65, 0, 0.8, 0.4);

const wrap = (seconds: number) => ((seconds % LOOP_SECONDS) + LOOP_SECONDS) % LOOP_SECONDS;

/** How far the arcs have grown into the mark, `seconds` into the loop. */
export function morphProgress(seconds: number): number {
  const t = wrap(seconds);
  if (t < 0.45) return 0;
  if (t < 1) return easeInOut((t - 0.45) / 0.55);
  if (t < 1.2) return 1;
  if (t < 1.7) return 1 - easeInOut((t - 1.2) / 0.5);
  return 0;
}

/** The mark's rotation in degrees, `seconds` into the loop: it spins in, settles upright, then spins out. */
export function turnDegrees(seconds: number): number {
  const t = wrap(seconds);
  if (t < 0.6) return -180 + 180 * settle(t / 0.6);
  if (t < 1.4) return 0;
  return 180 * launch((t - 1.4) / 0.6);
}
