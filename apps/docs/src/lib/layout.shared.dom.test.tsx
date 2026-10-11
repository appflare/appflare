// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogoLink } from "./layout.shared.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const scrollTo = vi.fn();
/** Whether the page let the last click go through; nothing navigates in the test. */
let followed: boolean | null = null;
const keepHere = (event: MouseEvent) => {
  followed = !event.defaultPrevented;
  event.preventDefault();
};

function at(path: string) {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    `https://appflare.dev${path}`,
  );
}

beforeEach(() => {
  scrollTo.mockClear();
  followed = null;
  window.scrollTo = scrollTo as typeof window.scrollTo;
  document.addEventListener("click", keepHere);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<LogoLink href="/" className="logo" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.removeEventListener("click", keepHere);
});

/** Clicks the logo; whether the link was followed. */
function click(): boolean | null {
  const link = container.querySelector("a");
  if (link === null) throw new Error("no link");
  act(() => {
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  return followed;
}

describe("the logo", () => {
  it("is a link to the front page, named Appflare", () => {
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/");
    expect(link?.className).toBe("logo");
    expect(link?.querySelector("img")?.getAttribute("alt")).toBe("Appflare");
  });

  it("takes the front page back to its top instead of going nowhere", () => {
    at("/");
    expect(click()).toBe(false);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });

  it("is a plain link everywhere else", () => {
    at("/apps/glance/");
    expect(click()).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
