import { LayerDialog } from "@cloudflare/kumo";
import { FingerprintIcon } from "@phosphor-icons/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BusyButton, BusyMark, busyActionProps } from "./busy-button";

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

function button(): HTMLButtonElement {
  const found = container.querySelector("button");
  if (!found) throw new Error("no button rendered");
  return found;
}

function mark(): SVGSVGElement | null {
  return button().querySelector("svg.appflare-loader");
}

/** Kumo's spinner draws two circles of radius 9.5; the mark has none. */
function kumoRing(): Element | null {
  return container.querySelector("circle[r='9.5']");
}

describe("BusyButton", () => {
  it("is Kumo's button with its icon while idle", () => {
    act(() =>
      root.render(
        <BusyButton pending={false} icon={<FingerprintIcon data-testid="icon" />}>
          Sign in with a passkey
        </BusyButton>,
      ),
    );
    expect(button().disabled).toBe(false);
    expect(button().hasAttribute("aria-busy")).toBe(false);
    expect(button().querySelector("[data-testid='icon']")).not.toBeNull();
    expect(mark()).toBeNull();
  });

  it("disables the button, marks it busy, and draws the mark in place of the icon", () => {
    act(() =>
      root.render(
        <BusyButton pending icon={<FingerprintIcon data-testid="icon" />}>
          Sign in with a passkey
        </BusyButton>,
      ),
    );
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().textContent).toContain("Sign in with a passkey");
    expect(button().querySelector("[data-testid='icon']")).toBeNull();
    expect(kumoRing()).toBeNull();
    // The size of an icon in a base button (Kumo's text-base, 14 px).
    expect(mark()?.getAttribute("width")).toBe("14");
    expect(mark()?.getAttribute("height")).toBe("14");
  });

  it("hides the mark from assistive technology, so aria-busy alone says the button is busy", () => {
    act(() =>
      root.render(
        <BusyButton pending type="submit">
          Sign in
        </BusyButton>,
      ),
    );
    expect(mark()?.getAttribute("aria-hidden")).toBe("true");
    expect(mark()?.hasAttribute("role")).toBe(false);
    expect(mark()?.hasAttribute("aria-label")).toBe(false);
    expect(button().querySelector("[aria-label], [role='status']")).toBeNull();
    expect(button().textContent?.trim()).toBe("Sign in");
  });

  it("sizes the mark to the button: 12 px small, 16 px large", () => {
    act(() =>
      root.render(
        <BusyButton pending size="sm">
          Check now
        </BusyButton>,
      ),
    );
    expect(mark()?.getAttribute("width")).toBe("12");
    act(() =>
      root.render(
        <BusyButton pending size="lg">
          Check now
        </BusyButton>,
      ),
    );
    expect(mark()?.getAttribute("width")).toBe("16");
  });

  it("keeps Kumo's loading look: no extra fade unless the button is also disabled", () => {
    act(() => root.render(<BusyButton pending>Save</BusyButton>));
    expect(button().classList.contains("opacity-50")).toBe(false);
    expect(button().classList.contains("opacity-100")).toBe(true);

    act(() =>
      root.render(
        <BusyButton pending disabled>
          Save
        </BusyButton>,
      ),
    );
    expect(button().classList.contains("opacity-50")).toBe(true);
    expect(button().classList.contains("opacity-100")).toBe(false);
  });
});

describe("busyActionProps and BusyMark", () => {
  function renderAction(pending: boolean, disabled?: boolean) {
    act(() =>
      root.render(
        <LayerDialog.Actions.Primary {...busyActionProps(pending, disabled)}>
          <BusyMark pending={pending} />
          Add domain
        </LayerDialog.Actions.Primary>,
      ),
    );
  }

  it("leaves an idle dialog action alone", () => {
    renderAction(false);
    expect(button().disabled).toBe(false);
    expect(button().hasAttribute("aria-busy")).toBe(false);
    expect(mark()).toBeNull();
  });

  it("keeps the action's own disabled state while idle", () => {
    renderAction(false, true);
    expect(button().disabled).toBe(true);
    expect(button().hasAttribute("aria-busy")).toBe(false);
  });

  it("disables a pending dialog action and leads its label with the mark", () => {
    renderAction(true);
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(button().textContent?.trim()).toBe("Add domain");
    expect(mark()?.getAttribute("width")).toBe("14");
    expect(mark()?.getAttribute("aria-hidden")).toBe("true");
    expect(button().querySelector("[aria-label], [role='status']")).toBeNull();
    expect(kumoRing()).toBeNull();
  });
});
