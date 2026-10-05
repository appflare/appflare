import type { CatalogSecret } from "@appflare/schema";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { secretsOf } from "../test/artifact-fixture";
import { SecretFields, secretsComplete, withSecretValue } from "./secret-fields";

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

const secrets: CatalogSecret[] = secretsOf([
  { name: "API_KEY", label: "API key" },
  {
    name: "OPENROUTER_API_KEY",
    label: "OpenRouter API key",
    help: "Turns on SAM.",
    optional: true,
  },
  { name: "WEBHOOK_KEY", label: "Webhook key", generate: "password", optional: true },
]);

/** Types into an input the way React notices. */
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function show(values: Record<string, string | undefined>, onChange = vi.fn()) {
  act(() =>
    root.render(
      <SecretFields secrets={secrets} values={values} onChange={onChange} after="the install" />,
    ),
  );
  return onChange;
}

function inputOf(label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")].find((l) =>
    l.textContent?.startsWith(label),
  );
  const input = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field for ${label}`);
  return input;
}

describe("an optional secret", () => {
  it("is one field marked optional, with its help under it and no switch", () => {
    show({ API_KEY: "" });
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.textContent).not.toContain("Set it now");
    const label = [...container.querySelectorAll("label")].find((l) =>
      l.textContent?.startsWith("OpenRouter API key"),
    );
    expect(label?.textContent).toContain("(optional)");
    expect(container.textContent).toContain("Turns on SAM.");
    expect(inputOf("OpenRouter API key").value).toBe("");
  });

  it("is set by typing a value, and left unset again once its field is empty", () => {
    const onChange = show({ API_KEY: "" });
    type(inputOf("OpenRouter API key"), "sk-1");
    expect(onChange).toHaveBeenLastCalledWith("OPENROUTER_API_KEY", "sk-1");
    show({ API_KEY: "", OPENROUTER_API_KEY: "sk-1" }, onChange);
    type(inputOf("OpenRouter API key"), "");
    expect(onChange).toHaveBeenLastCalledWith("OPENROUTER_API_KEY", undefined);
    // Unset, it has no key, so nothing is sent and the form is complete without it.
    expect(
      withSecretValue({ OPENROUTER_API_KEY: "sk-1" }, "OPENROUTER_API_KEY", undefined),
    ).toEqual({});
    expect(secretsComplete(secrets, { API_KEY: "k" })).toBe(true);
  });

  it("that the catalog generates starts empty, with Generate at the end of its help", () => {
    const onChange = show({ API_KEY: "" });
    const generate = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Generate",
    );
    expect(generate).toBeDefined();
    act(() => generate?.click());
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("WEBHOOK_KEY");
    expect(onChange.mock.calls.at(-1)?.[1]).toHaveLength(32);
  });
});

describe("a generated secret", () => {
  it("is regenerated from a small button inside its Generated badge, not from its help", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        <SecretFields
          secrets={secretsOf([{ name: "SESSION", label: "Session key", generate: "password" }])}
          values={{ SESSION: "x".repeat(32) }}
          onChange={onChange}
          after="the install"
        />,
      ),
    );
    const badge = container.querySelector('[data-secret-badge="Generated"]');
    const button = badge?.querySelector<HTMLButtonElement>("button");
    expect(button?.getAttribute("aria-label")).toBe("Regenerate Session key");
    // The badge sits beside the label, not inside it: a label would take the button's clicks.
    expect(button?.closest("label")).toBeNull();
    expect(container.textContent).not.toMatch(/Regenerate/);
    act(() => button?.click());
    expect(onChange.mock.calls.at(-1)?.[0]).toBe("SESSION");
    expect(onChange.mock.calls.at(-1)?.[1]).toHaveLength(32);
  });
});
