// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "../../analytics/analytics.ts";
import { ScreenshotGallery } from "./screenshot-gallery.tsx";

vi.mock("../../analytics/analytics.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../analytics/analytics.ts")>()),
  track: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGES = [
  { url: "https://catalog.example/inbox.png", alt: "The inbox" },
  { url: "https://catalog.example/compose.png", alt: "Writing a message" },
  { url: "https://catalog.example/settings.png", alt: "The settings" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.mocked(track).mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(<ScreenshotGallery images={IMAGES} appName="Mailflare" slug="mailflare" />),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

const thumbs = () => [...container.querySelectorAll<HTMLAnchorElement>("a")];
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

function thumb(i: number): HTMLAnchorElement {
  const link = thumbs()[i];
  if (link === undefined) throw new Error(`no screenshot ${i}`);
  return link;
}

/** The open lightbox's counter and image, or null when it is closed. */
function shown(): { counter: string; alt: string | null; src: string | null } | null {
  const box = dialog();
  if (box === null) return null;
  const image = box.querySelector("img");
  return {
    counter: box.querySelector("[aria-live]")?.textContent ?? "",
    alt: image?.getAttribute("alt") ?? null,
    src: image?.getAttribute("src") ?? null,
  };
}

function button(name: string): HTMLButtonElement {
  const found = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  );
  if (found === undefined) throw new Error(`no ${name} button`);
  return found;
}

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** The open lightbox's screenshot, and the box it fits in or scrolls in. */
function lightboxImage(): { image: HTMLImageElement; view: HTMLElement } {
  const image = dialog()?.querySelector("img");
  const view = image?.parentElement;
  if (image == null || view == null) throw new Error("no image");
  return { image, view };
}

/** A press on the open screenshot, from `from` to `to` (in the box), by a finger or a mouse. */
function press(from: [number, number], to: [number, number], pointerType = "touch") {
  const { image } = lightboxImage();
  const at = (type: string, [x, y]: [number, number]) =>
    new PointerEvent(type, {
      bubbles: true,
      pointerId: 7,
      pointerType,
      button: 0,
      clientX: x,
      clientY: y,
    });
  act(() => {
    image.dispatchEvent(at("pointerdown", from));
    image.dispatchEvent(at("pointerup", to));
  });
}

/**
 * Gives the open screenshot and its box the sizes a browser would lay them
 * out at (happy-dom lays nothing out): a 2880x1800 screenshot in a 360x640
 * box, as on a phone. Records where the box is asked to scroll.
 */
function laidOut() {
  const { image, view } = lightboxImage();
  Object.defineProperties(image, {
    naturalWidth: { value: 2880, configurable: true },
    naturalHeight: { value: 1800, configurable: true },
  });
  Object.defineProperties(view, {
    clientWidth: { value: 360, configurable: true },
    clientHeight: { value: 640, configurable: true },
  });
  view.getBoundingClientRect = () => new DOMRect(0, 0, 360, 640);
  const scrolls: unknown[] = [];
  view.scrollTo = ((options: unknown) => scrolls.push(["to", options])) as typeof view.scrollTo;
  view.scrollBy = ((options: unknown) => scrolls.push(["by", options])) as typeof view.scrollBy;
  return { image, view, scrolls };
}

/** A click on the backdrop, outside the open lightbox. */
async function clickOutside() {
  const backdrop = [...document.body.children].find(
    (el) => el !== container && el.querySelector('[role="dialog"]') !== null,
  )?.firstElementChild;
  if (!(backdrop instanceof HTMLElement) || backdrop.getAttribute("role") === "dialog") {
    throw new Error("no backdrop");
  }
  act(() => {
    backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

async function openWithClick(i: number) {
  const link = thumb(i);
  act(() => link.focus());
  act(() => link.click());
  await flush();
}

describe("the screenshot row", () => {
  it("links each screenshot to its image, so it opens without JavaScript", () => {
    expect(thumbs().map((a) => a.getAttribute("href"))).toEqual(IMAGES.map((i) => i.url));
    expect(thumb(1).getAttribute("aria-label")).toBe(
      "Screenshot 2 of 3: Writing a message. Opens it larger.",
    );
    expect(thumb(1).getAttribute("aria-haspopup")).toBe("dialog");
    expect(dialog()).toBeNull();
  });

  it("leaves a click with a modifier key to the browser", async () => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    act(() => {
      thumb(0).dispatchEvent(event);
    });
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("renders nothing without screenshots", () => {
    act(() => root.render(<ScreenshotGallery images={[]} appName="Mailflare" slug="mailflare" />));
    expect(container.innerHTML).toBe("");
  });
});

describe("the lightbox", () => {
  it("opens on the screenshot clicked, in the page, as a labelled modal dialog", async () => {
    await openWithClick(1);
    const box = dialog();
    expect(box).not.toBeNull();
    expect(box?.getAttribute("aria-modal")).toBe("true");
    const title = document.getElementById(box?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Mailflare screenshots");
    expect(shown()).toEqual({
      counter: "2 of 3",
      alt: "Writing a message",
      src: "https://catalog.example/compose.png",
    });
  });

  it("pages with Next and Previous, wrapping around", async () => {
    await openWithClick(2);
    act(() => button("Next").click());
    expect(shown()?.counter).toBe("1 of 3");
    act(() => button("Previous").click());
    act(() => button("Previous").click());
    expect(shown()).toMatchObject({ counter: "2 of 3", alt: "Writing a message" });
  });

  it("pages with the arrow keys, and Home and End", async () => {
    await openWithClick(0);
    const box = dialog();
    if (box === null) throw new Error("not open");
    expect(key(box, "ArrowRight").defaultPrevented).toBe(true);
    expect(shown()?.counter).toBe("2 of 3");
    key(box, "ArrowLeft");
    key(box, "ArrowLeft");
    expect(shown()?.counter).toBe("3 of 3");
    key(box, "Home");
    expect(shown()?.counter).toBe("1 of 3");
    key(box, "End");
    expect(shown()?.counter).toBe("3 of 3");
  });

  it("closes with Escape and gives focus back to the screenshot last shown", async () => {
    await openWithClick(0);
    act(() => button("Next").click());
    key(document.activeElement ?? document.body, "Escape");
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(thumb(1));
  });

  it("closes with its close button", async () => {
    await openWithClick(2);
    act(() => button("Close").click());
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(thumb(2));
  });

  it("pages with a sideways swipe on a touch screen", async () => {
    await openWithClick(0);
    const swipe = (fromX: number, toX: number) => {
      const image = dialog()?.querySelector("img");
      if (image == null) throw new Error("no image");
      const at = (type: string, x: number) =>
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 7,
          pointerType: "touch",
          clientX: x,
          clientY: 200,
        });
      act(() => {
        image.dispatchEvent(at("pointerdown", fromX));
        image.dispatchEvent(at("pointerup", toX));
      });
    };
    swipe(300, 100);
    expect(shown()?.counter).toBe("2 of 3");
    swipe(100, 300);
    swipe(100, 300);
    expect(shown()?.counter).toBe("3 of 3");
    // A tap is not a swipe.
    swipe(200, 205);
    expect(shown()?.counter).toBe("3 of 3");
  });

  it("keeps a one-finger drag from the browser, and leaves two fingers to zoom", async () => {
    await openWithClick(0);
    const figure = dialog()?.querySelector("figure");
    if (figure == null) throw new Error("no figure");
    const move = (fingers: number) => {
      const event = new Event("touchmove", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "touches", { value: { length: fingers } });
      figure.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(move(1)).toBe(true);
    expect(move(2)).toBe(false);
  });

  it("closes on a click outside it", async () => {
    await openWithClick(1);
    await clickOutside();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(thumb(1));
  });

  it("opens from the keyboard with Space on a screenshot", async () => {
    act(() => thumb(2).focus());
    const event = key(thumb(2), " ");
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(shown()?.counter).toBe("3 of 3");
  });
});

describe("counting", () => {
  it("counts each screenshot opened, by app and position", async () => {
    await openWithClick(1);
    expect(track).toHaveBeenCalledWith("screenshot_opened", { slug: "mailflare", index: 1 });
    act(() => button("Close").click());
    await flush();
    act(() => thumb(2).focus());
    key(thumb(2), " ");
    await flush();
    expect(vi.mocked(track).mock.calls).toEqual([
      ["screenshot_opened", { slug: "mailflare", index: 1 }],
      ["screenshot_opened", { slug: "mailflare", index: 2 }],
    ]);
  });

  it("counts nothing for a click the browser keeps", async () => {
    act(() => {
      thumb(0).dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
      );
    });
    await flush();
    expect(track).not.toHaveBeenCalled();
  });
});

describe("paging on a phone", () => {
  it("takes a short flick for a swipe", async () => {
    await openWithClick(0);
    // Flicks seen on phones were 38 to 61 pixels long.
    press([200, 300], [162, 304]);
    expect(shown()?.counter).toBe("2 of 3");
    press([162, 300], [200, 296]);
    expect(shown()?.counter).toBe("1 of 3");
  });

  it("does not take a scroll up or down for a swipe", async () => {
    await openWithClick(0);
    press([200, 300], [160, 200]);
    expect(shown()?.counter).toBe("1 of 3");
  });
});

describe("zooming", () => {
  const zoomedIn = () => lightboxImage().image.style.width !== "";

  it("zooms in where the screenshot is tapped, and out on the next tap", async () => {
    await openWithClick(0);
    const { image, view, scrolls } = laidOut();
    expect(button("Zoom in")).toBeDefined();
    // Fitted, the screenshot is 360x225 in the middle of the box (from y=207.5):
    // this taps a quarter of the way across it.
    press([90, 263], [90, 263]);
    // Four times the fitted size, with the point tapped kept where it was.
    expect([image.style.width, image.style.height]).toEqual(["1440px", "900px"]);
    expect(view.className).toContain("overflow-auto");
    expect(scrolls).toEqual([["to", { left: 270, top: 0 }]]);
    expect(button("Zoom out")).toBeDefined();
    expect(shown()?.counter).toBe("1 of 3");

    press([100, 100], [100, 100]);
    expect(zoomedIn()).toBe(false);
    expect(view.className).toContain("overflow-hidden");
    expect(button("Zoom in")).toBeDefined();
  });

  it("zooms with a mouse click too, and drags the zoomed screenshot", async () => {
    await openWithClick(0);
    const { image, scrolls } = laidOut();
    press([180, 320], [180, 320], "mouse");
    expect(zoomedIn()).toBe(true);
    const at = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        pointerId: 3,
        pointerType: "mouse",
        button: 0,
        clientX: x,
        clientY: y,
      });
    image.setPointerCapture = () => {};
    act(() => {
      image.dispatchEvent(at("pointerdown", 200, 300));
      image.dispatchEvent(at("pointermove", 150, 280));
      image.dispatchEvent(at("pointerup", 150, 280));
    });
    expect(scrolls.at(-1)).toEqual(["by", 50]);
    // A drag is not a click: still zoomed.
    expect(zoomedIn()).toBe(true);
  });

  it("zooms from the keyboard on the middle, and moves with the arrow keys instead of paging", async () => {
    await openWithClick(0);
    const { scrolls } = laidOut();
    act(() => button("Zoom in").click());
    expect(zoomedIn()).toBe(true);
    // The middle of the 1440x900 screenshot, in the middle of the 360x640 box.
    expect(scrolls).toEqual([["to", { left: 540, top: 130 }]]);
    const box = dialog();
    if (box === null) throw new Error("not open");
    expect(key(box, "ArrowRight").defaultPrevented).toBe(true);
    expect(key(box, "ArrowDown").defaultPrevented).toBe(true);
    expect(scrolls.slice(1)).toEqual([
      ["by", { left: 80, top: 0 }],
      ["by", { left: 0, top: 80 }],
    ]);
    expect(shown()?.counter).toBe("1 of 3");
    act(() => button("Zoom out").click());
    expect(zoomedIn()).toBe(false);
    key(box, "ArrowRight");
    expect(shown()?.counter).toBe("2 of 3");
  });

  it("fits the screenshot on Escape first, and closes on the next", async () => {
    await openWithClick(0);
    laidOut();
    act(() => button("Zoom in").click());
    key(document.activeElement ?? document.body, "Escape");
    await flush();
    expect(dialog()).not.toBeNull();
    expect(zoomedIn()).toBe(false);
    key(document.activeElement ?? document.body, "Escape");
    await flush();
    expect(dialog()).toBeNull();
  });

  it("leaves a zoomed screenshot to the finger: a drag moves it, not to the next", async () => {
    await openWithClick(0);
    laidOut();
    press([180, 320], [180, 320]);
    press([300, 320], [100, 320]);
    expect(shown()?.counter).toBe("1 of 3");
    expect(zoomedIn()).toBe(true);
    const figure = dialog()?.querySelector("figure");
    const event = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: { length: 1 } });
    figure?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("fits the screenshot again on paging", async () => {
    await openWithClick(0);
    laidOut();
    act(() => button("Zoom in").click());
    act(() => button("Next").click());
    expect(shown()?.counter).toBe("2 of 3");
    expect(zoomedIn()).toBe(false);
  });

  it("shows the screenshot paged back to fitted, not as it was left", async () => {
    await openWithClick(0);
    laidOut();
    act(() => button("Zoom in").click());
    act(() => button("Next").click());
    act(() => button("Previous").click());
    expect(shown()?.counter).toBe("1 of 3");
    expect(zoomedIn()).toBe(false);
    expect(button("Zoom in")).toBeDefined();
  });

  it("opens fitted again after closing zoomed, with its close button", async () => {
    await openWithClick(1);
    laidOut();
    act(() => button("Zoom in").click());
    act(() => button("Close").click());
    await flush();
    expect(dialog()).toBeNull();
    await openWithClick(1);
    expect(zoomedIn()).toBe(false);
    expect(button("Zoom in")).toBeDefined();
  });

  it("opens fitted again after closing zoomed, with a click outside it", async () => {
    await openWithClick(1);
    laidOut();
    act(() => button("Zoom in").click());
    await clickOutside();
    expect(dialog()).toBeNull();
    await openWithClick(1);
    expect(zoomedIn()).toBe(false);
  });
});

describe("one screenshot", () => {
  beforeEach(() => {
    act(() =>
      root.render(
        <ScreenshotGallery images={IMAGES.slice(0, 1)} appName="Mailflare" slug="mailflare" />,
      ),
    );
  });

  it("offers no paging: no counter, no Previous and Next", async () => {
    expect(thumb(0).getAttribute("aria-label")).toBe("Screenshot: The inbox. Opens it larger.");
    await openWithClick(0);
    const box = dialog();
    const title = document.getElementById(box?.getAttribute("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Mailflare screenshot");
    expect(box?.querySelector("[aria-live]")).toBeNull();
    expect(() => button("Next")).toThrow();
    expect(() => button("Previous")).toThrow();
    expect(button("Zoom in")).toBeDefined();
  });
});
