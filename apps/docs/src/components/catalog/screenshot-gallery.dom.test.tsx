// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenshotGallery } from "./screenshot-gallery.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGES = [
  { url: "https://catalog.example/inbox.png", alt: "The inbox" },
  { url: "https://catalog.example/compose.png", alt: "Writing a message" },
  { url: "https://catalog.example/settings.png", alt: "The settings" },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ScreenshotGallery images={IMAGES} appName="Mailflare" />));
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
    act(() => root.render(<ScreenshotGallery images={[]} appName="Mailflare" />));
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
