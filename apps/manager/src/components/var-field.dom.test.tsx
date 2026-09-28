import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallVarField } from "../installs/install-vars";
import { CHOICE_GRID, VarField } from "./var-field";

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

const redirectStatus: InstallVarField = {
  name: "REDIRECT_STATUS_CODE",
  label: "Redirect status",
  help: "The HTTP status short links answer with.",
  required: false,
  kind: "text",
  shownDefault: "301",
  options: [
    { value: "301", label: "301 Moved Permanently" },
    { value: "302", label: "302 Found" },
    { value: "307", label: "307 Temporary Redirect" },
    { value: "308", label: "308 Permanent Redirect" },
  ],
};

function render(field: InstallVarField) {
  act(() =>
    root.render(
      <TooltipProvider>
        <VarField field={field} value={field.shownDefault} onChange={() => {}} />
      </TooltipProvider>,
    ),
  );
}

describe("a setting with a few choices", () => {
  it("puts the label and help in a full row above the choices", () => {
    render(redirectStatus);
    const radios = [...container.querySelectorAll('[role="radio"]')];
    expect(radios).toHaveLength(4);
    const heading = container.querySelector("[data-choice-heading]");
    expect(heading?.classList.contains("col-span-full")).toBe(true);
    expect(heading?.textContent).toContain("Redirect status");
    expect(heading?.textContent).toContain("The HTTP status short links answer with.");
    // The heading is the grid's first cell; every choice comes after it, in the same grid.
    const grid = heading?.parentElement;
    expect(grid?.firstElementChild).toBe(heading);
    // That grid is the fieldset's own child, which `CHOICE_GRID`'s `[&>div]` reaches.
    expect(grid?.tagName).toBe("DIV");
    expect(grid?.parentElement?.tagName).toBe("FIELDSET");
    for (const radio of radios) expect(grid?.contains(radio)).toBe(true);
    // The help is not repeated under the choices.
    expect(container.textContent?.split("short links answer with").length).toBe(2);
  });

  it("names the group by its label", () => {
    render(redirectStatus);
    const fieldset = container.querySelector("fieldset");
    const legendId = fieldset?.getAttribute("aria-labelledby");
    expect(legendId).toBeTruthy();
    expect(document.getElementById(legendId ?? "")?.textContent).toContain("Redirect status");
  });

  it("lays the choices out in one column on a narrow screen and two from sm", () => {
    render(redirectStatus);
    const fieldset = container.querySelector("fieldset");
    for (const name of CHOICE_GRID.split(" "))
      expect(fieldset?.classList.contains(name)).toBe(true);
  });

  it("keeps a field without help to the label alone", () => {
    render({ ...redirectStatus, help: undefined });
    const heading = container.querySelector("[data-choice-heading]");
    expect(heading?.querySelector("p")).toBeNull();
  });
});
