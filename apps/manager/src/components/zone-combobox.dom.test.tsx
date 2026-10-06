import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ZoneChoice, ZoneCombobox } from "./zone-combobox";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ZONES: ZoneChoice[] = [
  { id: "z1", name: "example.com" },
  { id: "z2", name: "example.org" },
  { id: "z3", name: "acme.dev" },
];

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

/** The picker as a form holds it: the chosen zone id in state. */
function Picker({ onChange, initial }: { onChange(id: string): void; initial: string | null }) {
  const [value, setValue] = useState(initial);
  return (
    <ZoneCombobox
      zones={ZONES}
      value={value}
      onChange={(id) => {
        setValue(id);
        onChange(id);
      }}
      description="One of your domains on Cloudflare."
    />
  );
}

async function show(initial: string | null = null) {
  const onChange = vi.fn();
  await act(async () => root.render(<Picker onChange={onChange} initial={initial} />));
  return onChange;
}

function trigger(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-kumo-part="trigger"]');
  if (found === null) throw new Error("no domain picker");
  return found;
}

/** A mouse press and release on `el`, the events a pointer click sends. */
async function press(el: Element) {
  await act(async () => {
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"] as const) {
      const Event = type.startsWith("pointer") ? PointerEvent : MouseEvent;
      el.dispatchEvent(
        new Event(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
      );
    }
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((done) => setTimeout(done, 50));
  });
}

async function search(text: string) {
  const input = document.querySelector<HTMLInputElement>(
    'input[placeholder="Search your domains…"]',
  );
  if (input === null) throw new Error("no search field");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((done) => setTimeout(done, 50));
  });
}

/** A key press on whatever has focus, as the keyboard sends it. */
async function key(name: string) {
  await act(async () => {
    const target = document.activeElement ?? document.body;
    for (const type of ["keydown", "keyup"] as const) {
      target.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true }));
    }
    await new Promise((done) => setTimeout(done, 50));
  });
}

function options(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? "");
}

describe("ZoneCombobox", () => {
  it("is labelled Domain and shows its placeholder until a domain is chosen", async () => {
    await show();
    expect(trigger().getAttribute("role")).toBe("combobox");
    const labelId = trigger().getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId ?? "")?.textContent).toBe("Domain");
    expect(trigger().textContent).toContain("Choose a domain");
    expect(container.textContent).toContain("One of your domains on Cloudflare.");
  });

  it("selects a domain with the mouse and answers with its zone id", async () => {
    const onChange = await show();
    await press(trigger());
    expect(options()).toEqual(["example.com", "example.org", "acme.dev"]);
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (o) => o.textContent?.trim() === "example.org",
    );
    await press(option as Element);
    expect(onChange).toHaveBeenLastCalledWith("z2");
    expect(trigger().textContent).toContain("example.org");
  });

  it("works from the keyboard alone and gives focus back to its button", async () => {
    const onChange = await show();
    await act(async () => trigger().focus());
    await key("ArrowDown");
    expect(options()).toEqual(["example.com", "example.org", "acme.dev"]);
    // Opening highlights nothing; the next ArrowDown reaches the first domain.
    await key("ArrowDown");
    await key("ArrowDown");
    await key("Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("z2");
    expect(trigger().textContent).toContain("example.org");
    expect(options()).toEqual([]);
    expect(document.activeElement).toBe(trigger());

    await key("ArrowDown");
    expect(options()).not.toEqual([]);
    await key("Escape");
    expect(options()).toEqual([]);
    expect(document.activeElement).toBe(trigger());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("filters the domains by what is typed in its search", async () => {
    await show();
    await press(trigger());
    await search("org");
    expect(options()).toEqual(["example.org"]);
  });

  it("says so when no domain matches the search", async () => {
    await show();
    await press(trigger());
    await search("nothing-like-it");
    expect(options()).toEqual([]);
    expect(document.body.textContent).toContain("No domain matches.");
  });

  it("starts on the zone it is given", async () => {
    await show("z3");
    expect(trigger().textContent).toContain("acme.dev");
  });
});
