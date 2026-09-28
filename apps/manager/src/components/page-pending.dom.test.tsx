import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PagePending, ShellContent } from "./page-pending";

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

function wrapper(): HTMLElement | null {
  return container.firstElementChild as HTMLElement | null;
}

describe("the loading indicator while a page loads", () => {
  it("fills the window before the signed-in shell exists", () => {
    act(() => root.render(<PagePending />));
    expect(wrapper()?.className).toContain("min-h-dvh");
    expect(container.querySelector("svg.appflare-loader")).not.toBeNull();
  });

  it("takes only the page's place inside the signed-in shell", () => {
    act(() =>
      root.render(
        <ShellContent>
          <PagePending />
        </ShellContent>,
      ),
    );
    expect(wrapper()?.className).not.toContain("min-h-dvh");
    expect(container.querySelector("svg.appflare-loader")).not.toBeNull();
  });
});
