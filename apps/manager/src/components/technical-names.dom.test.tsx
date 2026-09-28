import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseTechnicalNames,
  TECHNICAL_NAMES_KEY,
  TechnicalNamesSwitch,
  useShowTechnicalNames,
} from "./field-label";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

/** What a part of a page shows while technical names are on. */
function Names() {
  const [show] = useShowTechnicalNames();
  return <span data-names>{show ? "ADMIN_PASSWORD" : "Admin password"}</span>;
}

function switches(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="switch"]')];
}

function checked(): boolean[] {
  return switches().map((s) => s.getAttribute("aria-checked") === "true");
}

describe("Show technical names", () => {
  it("is one choice: two switches on one page agree, and so does what they show", () => {
    act(() =>
      root.render(
        <>
          <TechnicalNamesSwitch />
          <TechnicalNamesSwitch />
          <Names />
        </>,
      ),
    );
    expect(checked()).toEqual([false, false]);
    act(() => switches()[1]?.click());
    expect(checked()).toEqual([true, true]);
    expect(container.querySelector("[data-names]")?.textContent).toBe("ADMIN_PASSWORD");
    act(() => switches()[0]?.click());
    expect(checked()).toEqual([false, false]);
  });

  it("survives the switch leaving the page, as on a change of tab, and is remembered", () => {
    act(() => root.render(<TechnicalNamesSwitch />));
    act(() => switches()[0]?.click());
    // Another tab of the page: the switch is gone, the names stay shown.
    act(() => root.render(<Names />));
    expect(container.querySelector("[data-names]")?.textContent).toBe("ADMIN_PASSWORD");
    act(() => root.render(<TechnicalNamesSwitch />));
    expect(checked()).toEqual([true]);
    expect(window.localStorage.getItem(TECHNICAL_NAMES_KEY)).toBe("shown");
  });

  it("reads anything stored but 'shown' as hidden", () => {
    expect(parseTechnicalNames("shown")).toBe("shown");
    expect(parseTechnicalNames(null)).toBe("hidden");
    expect(parseTechnicalNames("yes")).toBe("hidden");
  });
});
