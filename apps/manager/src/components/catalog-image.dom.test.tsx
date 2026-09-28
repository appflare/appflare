import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { CatalogImage } from "./catalog-image";
import { AppIcon } from "./catalog-media";
import { ScreenshotGallery } from "./screenshot-gallery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let complete: MockInstance<() => boolean>;

beforeEach(() => {
  // happy-dom never fetches images and calls every one complete; a browser
  // says an image it is still fetching is not.
  complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const SHOTS = [
  { src: "/api/catalog/media/aaa", alt: "Home page" },
  { src: "/api/catalog/media/bbb", alt: "Editor" },
];

function boxes(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-image-status]")];
}

function skeletons(): number {
  return container.querySelectorAll(".skeleton-line").length;
}

/**
 * Makes every `<img>` report what a browser reports for one it is done with:
 * its size (none for a broken image, or an SVG with only a `viewBox`) and
 * whether `decode()` resolves.
 */
function browserHas({
  width,
  height = width,
  decodes = true,
}: {
  width: number;
  height?: number;
  decodes?: boolean;
}) {
  complete.mockReturnValue(true);
  imageSize(width, height);
  vi.spyOn(HTMLImageElement.prototype, "decode").mockImplementation(() =>
    decodes ? Promise.resolve() : Promise.reject(new DOMException("broken", "EncodingError")),
  );
}

function imageSize(width: number, height: number) {
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLImageElement.prototype, "naturalHeight", "get").mockReturnValue(height);
}

describe("ScreenshotGallery", () => {
  it("reserves a 16:10 box with a skeleton for each screenshot before it loads", () => {
    act(() => root.render(<ScreenshotGallery images={SHOTS} appName="EmDash" />));
    expect(boxes()).toHaveLength(2);
    for (const box of boxes()) {
      expect(box.style.aspectRatio).toBe("16 / 10");
      expect(box.dataset.imageStatus).toBe("loading");
    }
    expect(skeletons()).toBe(2);
    expect(container.textContent).toContain("1 of 2");
  });

  it("drops a screenshot's skeleton once it loads, and keeps the box", () => {
    act(() => root.render(<ScreenshotGallery images={SHOTS} appName="EmDash" />));
    const [first] = container.querySelectorAll("img");
    act(() => {
      first?.dispatchEvent(new Event("load"));
    });
    const [box] = boxes();
    expect(box?.dataset.imageStatus).toBe("loaded");
    expect(box?.style.aspectRatio).toBe("16 / 10");
    expect(box?.querySelector(".skeleton-line")).toBeNull();
    expect(skeletons()).toBe(1);
  });

  it("loads the first screenshot at once and the rest lazily", () => {
    act(() => root.render(<ScreenshotGallery images={SHOTS} appName="EmDash" />));
    const [first, second] = container.querySelectorAll("img");
    expect(first?.getAttribute("loading")).toBe("eager");
    expect(second?.getAttribute("loading")).toBe("lazy");
    expect(second?.getAttribute("decoding")).toBe("async");
  });
});

describe("CatalogImage", () => {
  it("shows an image the browser already has without a skeleton", () => {
    browserHas({ width: 1600, height: 1000 });
    act(() =>
      root.render(
        <CatalogImage
          src="/api/catalog/media/aaa"
          alt="Home page"
          style={{ aspectRatio: "16 / 10" }}
        />,
      ),
    );
    expect(boxes()[0]?.dataset.imageStatus).toBe("loaded");
    expect(skeletons()).toBe(0);
  });

  it("leaves a quiet, named box when the image fails", () => {
    act(() => root.render(<CatalogImage src="/api/catalog/media/aaa" alt="Home page" />));
    act(() => {
      container.querySelector("img")?.dispatchEvent(new Event("error"));
    });
    const [box] = boxes();
    expect(box?.dataset.imageStatus).toBe("failed");
    expect(container.querySelector("img")).toBeNull();
    expect(skeletons()).toBe(0);
    expect(box?.getAttribute("role")).toBe("img");
    expect(box?.getAttribute("aria-label")).toBe("Home page");
  });

  it("fills the box from the top with a portrait image where asked, and letterboxes it otherwise", () => {
    imageSize(390, 844);
    act(() =>
      root.render(
        <>
          <CatalogImage src="/api/catalog/media/aaa" alt="" fit="contain-landscape" />
          <CatalogImage src="/api/catalog/media/bbb" alt="" />
        </>,
      ),
    );
    const [strip, large] = container.querySelectorAll("img");
    expect(strip?.className).toContain("object-contain");
    act(() => {
      strip?.dispatchEvent(new Event("load"));
      large?.dispatchEvent(new Event("load"));
    });
    expect(strip?.className).toContain("object-cover");
    expect(strip?.className).toContain("object-top");
    expect(large?.className).toContain("object-contain");
  });

  it("starts over when the image changes", () => {
    act(() => root.render(<CatalogImage src="/api/catalog/media/aaa" alt="" />));
    act(() => {
      container.querySelector("img")?.dispatchEvent(new Event("load"));
    });
    act(() => root.render(<CatalogImage src="/api/catalog/media/bbb" alt="" />));
    expect(boxes()[0]?.dataset.imageStatus).toBe("loading");
    expect(skeletons()).toBe(1);
  });
});

describe("AppIcon", () => {
  it("reserves the icon's square before it loads", () => {
    act(() => root.render(<AppIcon src="/api/catalog/media/icon" name="EmDash" size={64} />));
    const [box] = boxes();
    expect(box?.style.width).toBe("64px");
    expect(box?.style.height).toBe("64px");
    expect(skeletons()).toBe(1);
  });

  it("shows the monogram when the icon a cached page names is gone", async () => {
    browserHas({ width: 0, decodes: false });
    await act(async () =>
      root.render(<AppIcon src="/api/catalog/media/icon" name="EmDash" size={64} />),
    );
    expect(boxes()).toHaveLength(0);
    expect(container.textContent).toBe("ED");
  });

  it("shows a cached SVG icon that has no width of its own", async () => {
    browserHas({ width: 0, decodes: true });
    await act(async () =>
      root.render(<AppIcon src="/api/catalog/media/icon" name="EmDash" size={64} />),
    );
    expect(boxes()[0]?.dataset.imageStatus).toBe("loaded");
    expect(container.querySelector("img")).not.toBeNull();
  });
});

describe("server rendering", () => {
  it("hydrates a cached image without a mismatch and shows it", () => {
    const element = (
      <CatalogImage
        src="/api/catalog/media/aaa"
        alt="Home page"
        style={{ aspectRatio: "16 / 10" }}
      />
    );
    const page = document.createElement("div");
    page.innerHTML = renderToString(element);
    document.body.appendChild(page);
    expect(page.querySelector<HTMLElement>("[data-image-status]")?.dataset.imageStatus).toBe(
      "loading",
    );
    browserHas({ width: 1600, height: 1000 });
    const errors = vi.spyOn(console, "error");
    const recovered: unknown[] = [];
    let hydrated: Root | undefined;
    act(() => {
      hydrated = hydrateRoot(page, element, { onRecoverableError: (e) => recovered.push(e) });
    });
    expect(errors).not.toHaveBeenCalled();
    expect(recovered).toEqual([]);
    expect(page.querySelector<HTMLElement>("[data-image-status]")?.dataset.imageStatus).toBe(
      "loaded",
    );
    expect(page.querySelector(".skeleton-line")).toBeNull();
    act(() => hydrated?.unmount());
  });
});
