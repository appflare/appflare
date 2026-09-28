import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logo } from "./logo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let reducedMotion = false;

beforeEach(() => {
  reducedMotion = false;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
        media: query,
      }) as MediaQueryList,
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function logo(): SVGSVGElement {
  const svg = container.querySelector<SVGSVGElement>('svg[aria-label="Appflare"]');
  if (!svg) throw new Error("no logo");
  return svg;
}

const morphing = () => logo().classList.contains("appflare-logo-morph");

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

function finish(animationName: string, type: "animationend" | "animationcancel" = "animationend") {
  const turn = logo().querySelector(".appflare-morph-turn");
  act(() => {
    turn?.dispatchEvent(new AnimationEvent(type, { bubbles: true, animationName }));
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
    expect(logo().querySelector("mask circle.appflare-morph-ring")).not.toBeNull();
    expect(morphing()).toBe(false);

    enter("mouse");
    expect(morphing()).toBe(true);

    // Leaving and coming back mid-pass neither stops nor restarts it.
    leave();
    enter("mouse");
    expect(morphing()).toBe(true);

    finish("some-other-animation");
    expect(morphing()).toBe(true);
    finish("appflare-loader-turn");
    expect(morphing()).toBe(false);

    leave();
    enter("pen");
    expect(morphing()).toBe(true);
  });

  it("comes to rest when a pass is cancelled, and plays again on the next entry", () => {
    act(() => root.render(<Logo height={24} morphOnHover />));
    enter("mouse");
    expect(morphing()).toBe(true);
    finish("appflare-loader-ring", "animationcancel");
    expect(morphing()).toBe(false);
    leave();
    enter("mouse");
    expect(morphing()).toBe(true);
  });

  it("leaves touch and reduced motion alone", () => {
    act(() => root.render(<Logo height={24} morphOnHover />));
    enter("touch");
    expect(morphing()).toBe(false);
    leave();

    reducedMotion = true;
    enter("mouse");
    expect(morphing()).toBe(false);
  });
});
