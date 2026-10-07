import { describe, expect, it } from "vitest";
import {
  CLOUD_QUADRANT_INDEX,
  LOOP_SECONDS,
  MARK_SHAPES,
  morphFrame,
  morphProgress,
  PASS_START_SECONDS,
  sampleOutline,
  turnDegrees,
} from "./logo-morph.ts";

/** The points of a frame's `M…L…Z` path, in polar form around the box's centre. */
function polar(d: string): { angle: number; radius: number }[] {
  return d
    .slice(1, -1)
    .split("L")
    .map((pair) => {
      const [x, y] = pair.split(",").map(Number) as [number, number];
      return {
        angle: (Math.atan2(y - 22, x - 22) * 180) / Math.PI,
        radius: Math.hypot(x - 22, y - 22),
      };
    });
}

describe("sampleOutline", () => {
  it("walks the whole outline, repeated curve commands included, in even steps", () => {
    const points = sampleOutline(MARK_SHAPES[0] as string);
    // The top-left quadrant is about 70 units round.
    expect(points.length).toBeGreaterThan(300);
    expect(points[0]?.[0]).toBeCloseTo(2.01, 2);
    expect(points[0]?.[1]).toBeCloseTo(8.17, 2);
    const steps = points.slice(1).map(([x, y], k) => {
      const [px, py] = points[k] as [number, number];
      return Math.hypot(x - px, y - py);
    });
    expect(Math.max(...steps)).toBeLessThan(0.21);
  });
});

describe("morphFrame", () => {
  it("is the logo's own paths once the morph is done", () => {
    expect(morphFrame(1)).toEqual(MARK_SHAPES);
  });

  it("starts as a clean ring: every arc in the band, in its own quadrant, clear of the gaps", () => {
    const ring = morphFrame(0);
    // Quadrants clockwise from top left, then the cloud, which fills the top-right arc.
    const quadrant = [-180, -90, 0, 90, -90];
    ring.forEach((d, index) => {
      for (const { angle, radius } of polar(d)) {
        if (index === CLOUD_QUADRANT_INDEX) {
          // The cloud's ink starts as a line on the arc's outer edge.
          expect(radius).toBeCloseTo(17.8, 1);
        } else {
          expect(radius).toBeGreaterThan(14.19);
          expect(radius).toBeLessThan(17.81);
        }
        const from = quadrant[index] as number;
        const into = angle < from - 1 ? angle + 360 : angle;
        expect(into).toBeGreaterThan(from + 1.55);
        expect(into).toBeLessThan(from + 90 - 1.55);
      }
    });
  });

  it("keeps every shape's point count, so each frame is the same outline moved", () => {
    const counts = (frame: string[]) => frame.map((d) => d.split("L").length);
    expect(counts(morphFrame(0.5))).toEqual(counts(morphFrame(0)));
    expect(counts(morphFrame(0.9))).toEqual(counts(morphFrame(0)));
  });
});

describe("the loop", () => {
  it("spins as a ring, settles upright, grows into the mark, holds, and opens again", () => {
    expect(morphProgress(0)).toBe(0);
    expect(turnDegrees(0)).toBeCloseTo(-180, 3);
    expect(turnDegrees(0.6)).toBe(0);
    expect(morphProgress(0.7)).toBeGreaterThan(0);
    expect(morphProgress(0.7)).toBeLessThan(1);
    expect(morphProgress(1)).toBe(1);
    expect(morphProgress(1.19)).toBe(1);
    expect(turnDegrees(1.19)).toBe(0);
    expect(morphProgress(1.5)).toBeLessThan(1);
    expect(morphProgress(1.7)).toBe(0);
  });

  it("joins up at the loop's end: half a turn either way is the same ring", () => {
    expect(LOOP_SECONDS).toBe(2);
    expect(turnDegrees(LOOP_SECONDS - 1e-6)).toBeCloseTo(180, 2);
    expect(morphProgress(LOOP_SECONDS)).toBe(morphProgress(0));
  });

  it("starts a single pass on the full mark, upright, as the hold ends", () => {
    expect(morphProgress(PASS_START_SECONDS)).toBe(1);
    expect(turnDegrees(PASS_START_SECONDS)).toBe(0);
    expect(morphProgress(PASS_START_SECONDS + LOOP_SECONDS)).toBe(1);
  });
});
