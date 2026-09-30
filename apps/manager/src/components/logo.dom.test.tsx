import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logo } from "./logo";
import { MARK_SHAPES } from "./logo-morph";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let reducedMotion = false;
const motionListeners = new Set<() => void>();

/** Turns reduced motion on or off, telling any listening media query. */
function setReducedMotion(reduce: boolean) {
  reducedMotion = reduce;
  act(() => {
    for (const listener of motionListeners) listener();
  });
}

beforeEach(() => {
  reducedMotion = false;
  motionListeners.clear();
  vi.useFakeTimers({ now: 0, toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return query === "(prefers-reduced-motion: reduce)" && reducedMotion;
        },
        media: query,
        addEventListener: (_type: string, listener: () => void) => motionListeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) =>
          motionListeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function logo(): SVGSVGElement {
  const svg = container.querySelector<SVGSVGElement>('svg[aria-label="Appflare"]');
  if (!svg) throw new Error("no logo");
  return svg;
}

/** Whether the mark is anywhere but at rest: reshaped or turned. */
const morphing = () => {
  const shapes = [...logo().querySelectorAll("path[data-shape]")].map((path) =>
    path.getAttribute("d"),
  );
  const turned = logo().querySelector(".appflare-morph-turn")?.hasAttribute("transform");
  return shapes.length > 0 && (turned || shapes.some((d, index) => d !== MARK_SHAPES[index]));
};

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** React derives `onPointerEnter` from `pointerover` coming from outside the element. */
function enter(pointerType: string) {
  act(() => {
    logo().dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType, relatedTarget: document.body }),
    );
  });
}

function leave() {
  act(() => {
    logo().dispatchEvent(
      new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
  });
}

describe("Logo", () => {
  it("draws the mark statically unless asked to move", () => {
    act(() => root.render(<Logo height={24} />));
    expect(logo().querySelector("mask")).toBeNull();
    enter("mouse");
    expect(morphing()).toBe(false);
  });

  it("plays the loading motion once when a mouse enters, and not again until it ends", () => {
    act(() => root.render(<Logo height={24} morphOnHover />));
    expect(logo().querySelectorAll("path[data-shape]")).toHaveLength(5);
    expect(morphing()).toBe(false);

    // The pass starts on the full mark, so the ring opens as the pointer arrives.
    enter("mouse");
    advance(300);
    expect(morphing()).toBe(true);

    // Leaving and coming back mid-pass neither stops nor restarts it: the
    // pass ends 2 s after the first entry, when a restarted one would still
    // be a spinning ring.
    leave();
    advance(700);
    enter("mouse");
    advance(1100);
    expect(morphing()).toBe(false);

    leave();
    enter("pen");
    advance(300);
    expect(morphing()).toBe(true);
  });

  it("leaves touch and reduced motion alone", () => {
    act(() => root.render(<Logo height={24} morphOnHover />));
    enter("touch");
    advance(300);
    expect(morphing()).toBe(false);
    leave();

    reducedMotion = true;
    enter("mouse");
    advance(300);
    expect(morphing()).toBe(false);
  });

  it("cuts a pass short when reduced motion is asked for, and plays again once it is not", () => {
    act(() => root.render(<Logo height={24} morphOnHover />));
    enter("mouse");
    advance(300);
    expect(morphing()).toBe(true);

    setReducedMotion(true);
    expect(morphing()).toBe(false);
    advance(300);
    expect(morphing()).toBe(false);

    // The pass has ended, so the next entry plays a new one.
    setReducedMotion(false);
    leave();
    enter("mouse");
    advance(300);
    expect(morphing()).toBe(true);
  });
});
