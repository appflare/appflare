import { describe, expect, it } from "vitest";
import {
  LIGHTBOX_CLOSED,
  type LightboxAction,
  type LightboxState,
  lightbox,
  pageOffset,
  positionLabel,
  STRIP_START,
  type StripAction,
  strip,
  stripEdges,
  stripKeyTarget,
  visibleIndex,
} from "./gallery-navigation";

function run(actions: LightboxAction[], count: number, from: LightboxState = LIGHTBOX_CLOSED) {
  return actions.reduce((state, action) => lightbox(state, action, count), from);
}

function scroll(scrollLeft: number): StripAction {
  return { type: "scroll", scrollLeft, offsets: [0, 300, 600, 900], maxScrollLeft: 700 };
}

function onStrip(actions: StripAction[], count = 4) {
  return actions.reduce((state, action) => strip(state, action, count), STRIP_START);
}

describe("the strip's tab stop and caption", () => {
  it("moves the one tab stop with the keys and leaves the caption to scrolling", () => {
    const state = onStrip([
      { type: "key", key: "ArrowRight" },
      { type: "key", key: "End" },
    ]);
    expect(state).toEqual({ focus: 3, visible: 0 });
  });

  it("keeps the tab stop where it is while the strip scrolls", () => {
    const state = onStrip([{ type: "key", key: "ArrowRight" }, scroll(700)]);
    expect(state).toEqual({ focus: 1, visible: 3 });
    expect(onStrip([scroll(320)])).toEqual({ focus: 0, visible: 1 });
  });

  it("follows focus from a click or Tab, within range", () => {
    expect(onStrip([{ type: "focus", index: 2 }])).toEqual({ focus: 2, visible: 0 });
    expect(onStrip([{ type: "focus", index: 9 }])).toEqual({ focus: 3, visible: 0 });
  });

  it("ignores keys that do not move, and a strip that does not scroll", () => {
    const start = onStrip([]);
    expect(strip(start, { type: "key", key: "Tab" }, 4)).toBe(start);
    expect(
      onStrip([{ type: "scroll", scrollLeft: 0, offsets: [0, 300], maxScrollLeft: 0 }], 2),
    ).toEqual({ focus: 0, visible: 0 });
  });
});

describe("the strip's arrows", () => {
  it("appear only once the strip is wider than its box, as after its images load", () => {
    // Before the images load the strip is as wide as its box.
    expect(stripEdges({ scrollLeft: 0, scrollWidth: 800, clientWidth: 800 })).toEqual({
      overflows: false,
      atStart: true,
      atEnd: true,
    });
    expect(stripEdges({ scrollLeft: 0, scrollWidth: 2400, clientWidth: 800 })).toEqual({
      overflows: true,
      atStart: true,
      atEnd: false,
    });
  });

  it("know when the strip is at either end, with a pixel of slack", () => {
    expect(stripEdges({ scrollLeft: 1599.5, scrollWidth: 2400, clientWidth: 800 })).toMatchObject({
      atStart: false,
      atEnd: true,
    });
    expect(stripEdges({ scrollLeft: 400, scrollWidth: 2400, clientWidth: 800 })).toMatchObject({
      atStart: false,
      atEnd: false,
    });
  });

  it("scroll by one box width", () => {
    expect(pageOffset("next", 800)).toBe(800);
    expect(pageOffset("previous", 800)).toBe(-800);
  });
});

describe("keys on the screenshot strip", () => {
  it("moves with the arrows and stops at the ends", () => {
    expect(stripKeyTarget(0, "ArrowRight", 3)).toBe(1);
    expect(stripKeyTarget(2, "ArrowRight", 3)).toBe(2);
    expect(stripKeyTarget(1, "ArrowLeft", 3)).toBe(0);
    expect(stripKeyTarget(0, "ArrowLeft", 3)).toBe(0);
  });

  it("jumps to the first and last with Home and End", () => {
    expect(stripKeyTarget(1, "Home", 4)).toBe(0);
    expect(stripKeyTarget(1, "End", 4)).toBe(3);
  });

  it("leaves other keys (Tab, Enter, Space) to the browser", () => {
    for (const key of ["Tab", "Enter", " ", "ArrowDown"]) {
      expect(stripKeyTarget(1, key, 3)).toBeNull();
    }
    expect(stripKeyTarget(0, "ArrowRight", 0)).toBeNull();
  });
});

describe("the lightbox", () => {
  it("opens on the chosen screenshot and closes on the one last shown", () => {
    const open = run([{ type: "open", index: 2 }], 4);
    expect(open).toEqual({ open: true, index: 2 });
    expect(run([{ type: "next" }, { type: "close" }], 4, open)).toEqual({ open: false, index: 3 });
  });

  it("closes with Escape", () => {
    expect(
      run(
        [
          { type: "open", index: 1 },
          { type: "key", key: "Escape" },
        ],
        3,
      ),
    ).toEqual({
      open: false,
      index: 1,
    });
  });

  it("wraps around with the arrows, previous and next", () => {
    const last = run([{ type: "open", index: 2 }], 3);
    expect(run([{ type: "key", key: "ArrowRight" }], 3, last).index).toBe(0);
    expect(run([{ type: "key", key: "ArrowLeft" }], 3, { open: true, index: 0 }).index).toBe(2);
    expect(run([{ type: "previous" }, { type: "previous" }], 3, last).index).toBe(0);
    expect(run([{ type: "key", key: "Home" }], 3, last).index).toBe(0);
    expect(run([{ type: "key", key: "End" }], 3, { open: true, index: 0 }).index).toBe(2);
  });

  it("ignores keys and paging while closed, and keeps an index in range", () => {
    expect(run([{ type: "key", key: "ArrowRight" }, { type: "next" }], 3)).toEqual(LIGHTBOX_CLOSED);
    expect(run([{ type: "open", index: 9 }], 3)).toEqual({ open: true, index: 2 });
  });

  it("never opens without screenshots", () => {
    expect(run([{ type: "open", index: 0 }], 0)).toEqual(LIGHTBOX_CLOSED);
  });
});

describe("the caption", () => {
  it("reads N of M", () => {
    expect(positionLabel(0, 4)).toBe("1 of 4");
  });

  it("follows the screenshot nearest the scroll position, and the last at the end", () => {
    const offsets = [0, 300, 600, 900];
    expect(visibleIndex(0, offsets, 700)).toBe(0);
    expect(visibleIndex(320, offsets, 700)).toBe(1);
    expect(visibleIndex(700, offsets, 700)).toBe(3);
    expect(visibleIndex(0, [], 0)).toBe(0);
  });
});
