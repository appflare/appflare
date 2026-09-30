import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppflareLoader, loaderPixels } from "./appflare-loader";
import { MARK_SHAPES } from "./logo-morph";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

let reducedMotion = false;

beforeEach(() => {
  reducedMotion = false;
  vi.useFakeTimers({ now: 0, toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
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

/** The five shapes' path data, quadrants then cloud. */
const shapes = (svg: SVGSVGElement | undefined) =>
  [...(svg?.querySelectorAll("path[data-shape]") ?? [])].map((path) => path.getAttribute("d"));

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function loaders(): SVGSVGElement[] {
  return [...container.querySelectorAll<SVGSVGElement>("svg.appflare-loader")];
}

describe("AppflareLoader", () => {
  it("renders the mark as a status, labelled Loading by default", () => {
    act(() => root.render(<AppflareLoader className="text-kumo-subtle" />));
    const [svg] = loaders();
    expect(svg?.getAttribute("role")).toBe("status");
    expect(svg?.getAttribute("aria-label")).toBe("Loading");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 44 44");
    expect(svg?.getAttribute("class")).toContain("text-kumo-subtle");
    // Four quadrants and the cloud, drawn as the plain mark until the first frame.
    expect(shapes(svg)).toEqual(MARK_SHAPES);
    expect(svg?.querySelector("mask path[data-gap]")).not.toBeNull();
  });

  it("takes another label", () => {
    act(() => root.render(<AppflareLoader aria-label="Checking the domain" />));
    expect(loaders()[0]?.getAttribute("aria-label")).toBe("Checking the domain");
  });

  it("drops its status role and label when hidden from assistive technology", () => {
    act(() => root.render(<AppflareLoader aria-hidden />));
    const [svg] = loaders();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.hasAttribute("role")).toBe(false);
    expect(svg?.hasAttribute("aria-label")).toBe(false);
  });

  it("sizes like Kumo's Loader: sm 16, base 24, lg 32, or pixels", () => {
    expect(loaderPixels("sm")).toBe(16);
    expect(loaderPixels("base")).toBe(24);
    expect(loaderPixels("lg")).toBe(32);
    expect(loaderPixels(20)).toBe(20);
    act(() =>
      root.render(
        <>
          <AppflareLoader />
          <AppflareLoader size="sm" />
          <AppflareLoader size="lg" />
          <AppflareLoader size={48} />
        </>,
      ),
    );
    expect(loaders().map((svg) => [svg.getAttribute("width"), svg.getAttribute("height")])).toEqual(
      [
        ["24", "24"],
        ["16", "16"],
        ["32", "32"],
        ["48", "48"],
      ],
    );
  });

  it("gives each loader its own mask, so two can share a page", () => {
    act(() =>
      root.render(
        <>
          <AppflareLoader size="sm" />
          <AppflareLoader size="sm" />
        </>,
      ),
    );
    const ids = loaders().map((svg) => {
      const id = svg.querySelector("mask")?.getAttribute("id") ?? "";
      expect(id).toMatch(/^[\w-]+$/);
      expect(svg.querySelector(`path[mask="url(#${id})"]`)).not.toBeNull();
      return id;
    });
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("moves on every frame, every loader in step with the others", () => {
    act(() =>
      root.render(
        <>
          <AppflareLoader size="sm" />
          <AppflareLoader size="lg" />
        </>,
      ),
    );
    // 0.8 s into the loop the arcs are growing into the quadrants.
    advance(800);
    const [small, large] = loaders();
    expect(shapes(small)).not.toEqual(MARK_SHAPES);
    expect(shapes(large)).toEqual(shapes(small));
    expect(small?.querySelector("path[data-gap]")?.getAttribute("d")).not.toBe("");
    // 0.2 s later the mark is whole and upright, in the hold.
    advance(250);
    expect(shapes(small)).toEqual(MARK_SHAPES);
    expect(small?.querySelector(".appflare-morph-turn")?.hasAttribute("transform")).toBe(false);
    expect(small?.querySelector("path[data-gap]")?.getAttribute("d")).toBe("");
    // Then it opens into the ring again, turning.
    advance(700);
    expect(shapes(small)).not.toEqual(MARK_SHAPES);
    expect(small?.querySelector(".appflare-morph-turn")?.getAttribute("transform")).toMatch(
      /^rotate\(/,
    );
  });

  it("stays the still mark when the system asks for reduced motion", () => {
    reducedMotion = true;
    act(() => root.render(<AppflareLoader />));
    advance(800);
    expect(shapes(loaders()[0])).toEqual(MARK_SHAPES);
  });
});
