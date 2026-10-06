import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PasswordInput } from "./password-input";

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
  vi.restoreAllMocks();
});

/**
 * An element's accessible name, by the first rules of the accessible name
 * computation that apply to a text field: `aria-labelledby`, then
 * `aria-label`, then its `<label>` elements.
 */
function accessibleName(el: HTMLElement): string {
  const byIds = el.getAttribute("aria-labelledby");
  if (byIds) {
    return byIds
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  }
  const label = el.getAttribute("aria-label");
  if (label) return label.trim();
  return [...((el as HTMLInputElement).labels ?? [])]
    .map((l) => l.textContent ?? "")
    .join(" ")
    .trim();
}

/** The text fields named `name`, the way a label or role query finds them. */
function fieldsNamed(name: string): HTMLInputElement[] {
  return [...container.querySelectorAll("input")].filter((i) => accessibleName(i) === name);
}

describe("the password field", () => {
  // Each place that asks for a password: sign-in, setup's first admin, and
  // both ways of choosing a new password after forgetting one.
  it.each([
    ["Password", "current-password"],
    ["Password", "new-password"],
    ["New password", "new-password"],
  ] as const)("is named %s (%s), without Kumo's missing-name warning", (label, autoComplete) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    act(() =>
      root.render(<PasswordInput label={label} name="password" autoComplete={autoComplete} />),
    );
    const [field, ...others] = fieldsNamed(label);
    expect(field?.getAttribute("type")).toBe("password");
    expect(others).toEqual([]);
    expect(warn.mock.calls.map(([message]) => String(message))).not.toContainEqual(
      expect.stringContaining("accessible name"),
    );
  });

  it("keeps its name when the password is shown", () => {
    act(() =>
      root.render(
        <PasswordInput label="Password" name="password" autoComplete="current-password" />,
      ),
    );
    const show = container.querySelector<HTMLButtonElement>('button[aria-label="Show password"]');
    act(() => show?.click());
    expect(fieldsNamed("Password")[0]?.getAttribute("type")).toBe("text");
  });
});
