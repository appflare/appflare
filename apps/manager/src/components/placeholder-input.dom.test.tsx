import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placeholderOptions } from "./placeholder-chips";
import { PlaceholderInput } from "./placeholder-input";

// React only flushes updates inside act() when it knows it runs under a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The field with its own state; the stored value is shown in `output`. */
function Harness({ initial, workers = [] }: { initial: string; workers?: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <PlaceholderInput
        label="Sign-in callback"
        accessibleName="Sign-in callback"
        required
        value={value}
        onChange={setValue}
        options={placeholderOptions({ workers })}
        workers={workers}
        describeChip={() => "Filled in with the app's address when it installs"}
      />
      <output>{value}</output>
    </>
  );
}

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

function mount(initial: string, workers?: string[]) {
  act(() => root.render(<Harness initial={initial} workers={workers ?? []} />));
}

const stored = () => container.querySelector("output")?.textContent ?? "";
const parts = () => [...container.querySelectorAll<HTMLInputElement>("input[aria-label]")];
const chips = () =>
  [...container.querySelectorAll("[data-placeholder]")].map((c) =>
    c.getAttribute("data-placeholder"),
  );

function press(input: HTMLInputElement, key: string, caret: number) {
  input.focus();
  input.setSelectionRange(caret, caret);
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

/** What a paste or typing does: the input's new value, then its input event. */
function typeInto(input: HTMLInputElement, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, next);
    input.setSelectionRange(next.length, next.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("PlaceholderInput", () => {
  it("shows a placeholder as a chip and keeps the stored value as written", () => {
    mount("{{ workerUrl }}/auth/callback");
    expect(chips()).toEqual(["{{ workerUrl }}"]);
    expect(container.textContent).toContain("App address");
    expect(parts().map((p) => p.value)).toEqual(["", "/auth/callback"]);
    expect(stored()).toBe("{{ workerUrl }}/auth/callback");
  });

  it("removes a chip whole with Backspace right after it", () => {
    mount("https://{{workerName}}.example.com");
    const after = parts()[1];
    if (after === undefined) throw new Error("no text after the chip");
    press(after, "Backspace", 0);
    expect(stored()).toBe("https://.example.com");
    expect(chips()).toEqual([]);
  });

  it("removes a chip whole with Delete right before it", () => {
    mount("https://{{workerName}}.example.com");
    const before = parts()[0];
    if (before === undefined) throw new Error("no text before the chip");
    press(before, "Delete", "https://".length);
    expect(stored()).toBe("https://.example.com");
  });

  it("leaves Backspace inside the text to the text", () => {
    mount("https://{{workerName}}.example.com");
    const after = parts()[1];
    if (after === undefined) throw new Error("no text after the chip");
    press(after, "Backspace", 3);
    // Not prevented: the browser edits the text, and the chip stays.
    expect(chips()).toEqual(["{{workerName}}"]);
  });

  it("turns a pasted known placeholder into a chip", () => {
    mount("https://");
    const only = parts()[0];
    if (only === undefined) throw new Error("no text part");
    typeInto(only, "https://{{accountId}}/stats");
    expect(stored()).toBe("https://{{accountId}}/stats");
    expect(chips()).toEqual(["{{accountId}}"]);
    expect(container.textContent).toContain("Account ID");
  });

  it("keeps unknown braces, and a Worker the app does not have, as text", () => {
    mount("{{foo}} and {{workerUrl:web}}", ["api"]);
    expect(chips()).toEqual([]);
    expect(parts().map((p) => p.value)).toEqual(["{{foo}} and {{workerUrl:web}}"]);
    const only = parts()[0];
    if (only === undefined) throw new Error("no text part");
    typeInto(only, "{{foo}} {{bar}}");
    expect(chips()).toEqual([]);
    expect(stored()).toBe("{{foo}} {{bar}}");
  });

  it("removes a chip with its × button, the way that works on any keyboard", () => {
    mount("{{workerUrl}}/a/{{accountId}}");
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Account ID"]',
    );
    expect(remove).not.toBeNull();
    act(() => remove?.click());
    expect(stored()).toBe("{{workerUrl}}/a/");
    expect(chips()).toEqual(["{{workerUrl}}"]);
  });

  it("gives the × a touch target of at least 24px and a named chip to open", () => {
    mount("{{workerUrl}}");
    const remove = container.querySelector('button[aria-label="Remove App address"]');
    expect(remove?.className).toContain("size-6");
    const name = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "App address",
    );
    expect(name).toBeDefined();
  });

  it("says what a chip becomes on a click or tap, not only on hover", async () => {
    mount("{{workerUrl}}");
    const name = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "App address",
    );
    await act(async () => name?.click());
    expect(document.body.textContent).toContain(
      "Filled in with the app's address when it installs",
    );
  });
});
