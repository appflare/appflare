import { describe, expect, it } from "vitest";
import {
  fittedSize,
  MAX_ZOOM,
  MIN_ZOOM,
  PAN_STEP_PX,
  panStep,
  pressAction,
  TAP_SLOP_PX,
  zoomedSize,
  zoomScroll,
} from "./lightbox-zoom.ts";

const phoneBox = { width: 360, height: 640 };
const desktopBox = { width: 1200, height: 750 };

/** `actual` is `expected`, to a hundredth of a pixel. */
function expectSize(
  actual: { width: number; height: number },
  expected: { width: number; height: number },
) {
  expect(actual.width).toBeCloseTo(expected.width, 2);
  expect(actual.height).toBeCloseTo(expected.height, 2);
}

describe("fittedSize", () => {
  it("fits the screenshot's longer side to the box, as object-fit: contain does", () => {
    expectSize(fittedSize({ width: 2880, height: 1800 }, phoneBox), { width: 360, height: 225 });
    expectSize(fittedSize({ width: 1170, height: 2532 }, phoneBox), {
      width: (1170 * 640) / 2532,
      height: 640,
    });
  });
});

describe("zoomedSize", () => {
  it("shows a large screenshot at most four times its fitted size", () => {
    // 2880 pixels would be eight phone screens wide.
    expectSize(zoomedSize({ width: 2880, height: 1800 }, phoneBox), {
      width: 360 * MAX_ZOOM,
      height: 225 * MAX_ZOOM,
    });
  });

  it("shows a screenshot at its own pixels between two and four times", () => {
    expectSize(zoomedSize({ width: 1280, height: 800 }, phoneBox), { width: 1280, height: 800 });
    expectSize(zoomedSize({ width: 2880, height: 1800 }, desktopBox), {
      width: 2880,
      height: 1800,
    });
  });

  it("enlarges a small screenshot twice all the same", () => {
    expectSize(zoomedSize({ width: 1280, height: 800 }, desktopBox), {
      width: 1200 * MIN_ZOOM,
      height: 750 * MIN_ZOOM,
    });
  });
});

describe("zoomScroll", () => {
  const shot = { width: 2880, height: 1800 };

  it("keeps the point tapped under the finger", () => {
    // Fitted: 360x225 from y=207.5. A tap three quarters across, in the middle.
    const at = { x: 270, y: 320 };
    const { left, top } = zoomScroll(shot, phoneBox, at);
    // Zoomed 1440x900: the same point is at (1080, 450) in the screenshot.
    expect(left).toBeCloseTo(1080 - at.x, 2);
    expect(top).toBeCloseTo(450 - at.y, 2);
  });

  it("stays within what the box can scroll", () => {
    expect(zoomScroll(shot, phoneBox, { x: 0, y: 0 })).toEqual({ left: 0, top: 0 });
    const end = zoomScroll(shot, phoneBox, { x: 360, y: 640 });
    expect(end.left).toBeCloseTo(1080, 2);
    expect(end.top).toBeCloseTo(260, 2);
  });

  it("does not scroll a side that fits in the box", () => {
    // A phone's screenshot zoomed on a desktop is still narrower than the box.
    const tall = { width: 1170, height: 2532 };
    expect(zoomScroll(tall, desktopBox, { x: 900, y: 375 }).left).toBe(0);
  });
});

describe("pressAction", () => {
  it("zooms on a tap, a finger's or a mouse's, fitted or zoomed", () => {
    for (const touch of [true, false]) {
      for (const zoomed of [true, false]) {
        expect(pressAction(0, 0, { touch, zoomed })).toBe("zoom");
        expect(pressAction(TAP_SLOP_PX * 0.6, TAP_SLOP_PX * 0.6, { touch, zoomed })).toBe("zoom");
      }
    }
  });

  it("pages on a sideways swipe of the fitted screenshot, on a touch screen only", () => {
    expect(pressAction(-40, 3, { touch: true, zoomed: false })).toBe("next");
    expect(pressAction(40, 3, { touch: true, zoomed: false })).toBe("previous");
    expect(pressAction(-40, 3, { touch: false, zoomed: false })).toBeNull();
  });

  it("leaves a drag of the zoomed screenshot to the scrolling", () => {
    expect(pressAction(-200, 0, { touch: true, zoomed: true })).toBeNull();
    expect(pressAction(-200, 0, { touch: false, zoomed: true })).toBeNull();
  });

  it("does nothing for a press that is neither a tap nor a swipe", () => {
    expect(pressAction(15, 0, { touch: true, zoomed: false })).toBeNull();
  });
});

describe("panStep", () => {
  it("moves a zoomed screenshot with the arrow keys", () => {
    expect(panStep("ArrowLeft")).toEqual({ x: -PAN_STEP_PX, y: 0 });
    expect(panStep("ArrowRight")).toEqual({ x: PAN_STEP_PX, y: 0 });
    expect(panStep("ArrowUp")).toEqual({ x: 0, y: -PAN_STEP_PX });
    expect(panStep("ArrowDown")).toEqual({ x: 0, y: PAN_STEP_PX });
    expect(panStep("Home")).toBeNull();
  });
});
