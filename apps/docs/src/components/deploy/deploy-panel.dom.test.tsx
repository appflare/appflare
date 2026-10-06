// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployView } from "../../deploy/flow.ts";
import { type DeployActions, DeployPanel, NO_ACTIONS, resetStepFocus } from "./deploy-panel.tsx";
import { STEP_TITLE_ID } from "./deploy-shell.tsx";
import { SAMPLE_VIEWS } from "./sample-views.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetStepFocus();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: false,
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
  vi.restoreAllMocks();
});

function sample(name: string): DeployView {
  const view = SAMPLE_VIEWS[name];
  if (view === undefined) throw new Error(`no sample ${name}`);
  return view;
}

function draw(view: DeployView, actions: DeployActions = NO_ACTIONS) {
  act(() => root.render(<DeployPanel view={view} actions={actions} canGoBack={false} />));
}

function button(label: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    label.test(b.textContent ?? ""),
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

describe("focus on the deploy page", () => {
  it("leaves the focus alone while the page starts by itself", () => {
    draw(sample("loading"));
    draw(sample("welcome"));
    expect(document.activeElement?.id).not.toBe(STEP_TITLE_ID);
  });

  it("moves the focus to the new step's title once the person has acted", () => {
    draw(sample("name"));
    act(() => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    draw(sample("address-domain"));
    expect(document.activeElement?.id).toBe(STEP_TITLE_ID);
    expect(document.activeElement?.textContent).toBe("Choose Appflare's address");
  });

  it("keeps the focus on Check now while it checks, and ignores presses meanwhile", () => {
    const checkNow = vi.fn();
    const actions = { ...NO_ACTIONS, checkNow };
    draw(sample("deploying-address"), actions);
    const idle = button(/Check now/);
    act(() => idle.focus());
    act(() => idle.click());
    expect(checkNow).toHaveBeenCalledTimes(1);

    draw(sample("deploying-address-checking"), actions);
    const busy = button(/Checking/);
    expect(busy).toBe(idle);
    expect(busy.disabled).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(busy);
    act(() => busy.click());
    expect(checkNow).toHaveBeenCalledTimes(1);

    draw(sample("deploying-address-checked"), actions);
    expect(document.activeElement).toBe(button(/Check now/));
  });
});
