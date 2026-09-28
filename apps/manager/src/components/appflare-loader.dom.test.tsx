import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppflareLoader, loaderPixels } from "./appflare-loader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

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
    // Four quadrants and the cloud, behind the ring mask.
    expect(svg?.querySelectorAll("path")).toHaveLength(5);
    expect(svg?.querySelector("mask circle.appflare-morph-ring")).not.toBeNull();
  });

  it("takes another label", () => {
    act(() => root.render(<AppflareLoader aria-label="Checking the domain" />));
    expect(loaders()[0]?.getAttribute("aria-label")).toBe("Checking the domain");
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
      expect(svg.querySelector(`g[mask="url(#${id})"]`)).not.toBeNull();
      return id;
    });
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
