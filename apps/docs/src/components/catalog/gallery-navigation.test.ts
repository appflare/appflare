import { describe, expect, it } from "vitest";
import {
  isLightboxKey,
  LIGHTBOX_CLOSED,
  type LightboxAction,
  type LightboxState,
  lightbox,
  opensLightbox,
  positionLabel,
  SWIPE_MIN_PX,
  swipeAction,
} from "./gallery-navigation.ts";

function run(actions: LightboxAction[], count: number, from = LIGHTBOX_CLOSED): LightboxState {
  return actions.reduce((state, action) => lightbox(state, action, count), from);
}

describe("the lightbox", () => {
  it("opens on the chosen screenshot and closes on the one last shown", () => {
    const open = run([{ type: "open", index: 2 }], 4);
    expect(open).toEqual({ open: true, index: 2 });
    expect(run([{ type: "next" }, { type: "close" }], 4, open)).toEqual({ open: false, index: 3 });
  });

  it("closes with Escape", () => {
    const open = run([{ type: "open", index: 1 }], 3);
    expect(run([{ type: "key", key: "Escape" }], 3, open)).toEqual({ open: false, index: 1 });
  });

  it("wraps around with the arrows, previous and next", () => {
    const last = run([{ type: "open", index: 2 }], 3);
    const first = run([{ type: "open", index: 0 }], 3);
    expect(run([{ type: "key", key: "ArrowRight" }], 3, last).index).toBe(0);
    expect(run([{ type: "key", key: "ArrowLeft" }], 3, first).index).toBe(2);
    expect(run([{ type: "next" }], 3, last).index).toBe(0);
    expect(run([{ type: "previous" }, { type: "previous" }], 3, last).index).toBe(0);
  });

  it("jumps to the ends with Home and End", () => {
    expect(run([{ type: "key", key: "Home" }], 3, { open: true, index: 2 }).index).toBe(0);
    expect(run([{ type: "key", key: "End" }], 3, { open: true, index: 0 }).index).toBe(2);
  });

  it("stays put on one screenshot", () => {
    const only = run([{ type: "open", index: 0 }], 1);
    expect(run([{ type: "next" }, { type: "key", key: "ArrowLeft" }], 1, only)).toEqual(only);
  });

  it("ignores other keys, and keys and paging while closed, and keeps an index in range", () => {
    expect(run([{ type: "key", key: "ArrowRight" }, { type: "next" }], 3)).toEqual(LIGHTBOX_CLOSED);
    expect(run([{ type: "key", key: "a" }], 3, { open: true, index: 1 })).toEqual({
      open: true,
      index: 1,
    });
    expect(run([{ type: "open", index: 9 }], 3)).toEqual({ open: true, index: 2 });
    expect(run([{ type: "open", index: -1 }], 3)).toEqual({ open: true, index: 0 });
  });

  it("never opens without screenshots", () => {
    expect(run([{ type: "open", index: 0 }], 0)).toEqual(LIGHTBOX_CLOSED);
  });

  it("claims only the keys it answers; Escape is the dialog's own", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(isLightboxKey(key)).toBe(true);
    }
    for (const key of ["Escape", "Tab", "Enter", " ", "ArrowUp"]) {
      expect(isLightboxKey(key)).toBe(false);
    }
  });
});

describe("the counter", () => {
  it("reads N of M", () => {
    expect(positionLabel(0, 4)).toBe("1 of 4");
    expect(positionLabel(3, 4)).toBe("4 of 4");
  });
});

describe("a swipe", () => {
  it("to the left shows the next screenshot, to the right the previous", () => {
    expect(swipeAction(-80, 10)).toBe("next");
    expect(swipeAction(80, -10)).toBe("previous");
    expect(swipeAction(-SWIPE_MIN_PX, 0)).toBe("next");
  });

  it("does nothing when short or mostly vertical", () => {
    expect(swipeAction(-(SWIPE_MIN_PX - 1), 0)).toBeNull();
    expect(swipeAction(0, 0)).toBeNull();
    expect(swipeAction(-80, 70)).toBeNull();
    expect(swipeAction(60, 200)).toBeNull();
  });
});

describe("a click on a screenshot", () => {
  const plain = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it("opens the lightbox when plain", () => {
    expect(opensLightbox(plain)).toBe(true);
  });

  it("keeps the link's own meaning with a modifier or another button", () => {
    expect(opensLightbox({ ...plain, metaKey: true })).toBe(false);
    expect(opensLightbox({ ...plain, ctrlKey: true })).toBe(false);
    expect(opensLightbox({ ...plain, shiftKey: true })).toBe(false);
    expect(opensLightbox({ ...plain, altKey: true })).toBe(false);
    expect(opensLightbox({ ...plain, button: 1 })).toBe(false);
  });
});
