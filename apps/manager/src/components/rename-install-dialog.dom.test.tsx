import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  renameInstall: vi.fn(async () => ({})),
  invalidate: vi.fn(async () => {}),
}));
vi.mock("../installs/installs.functions", () => ({ renameInstall: calls.renameInstall }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ invalidate: calls.invalidate }) }));

const { RenameInstallDialog } = await import("./rename-install-dialog");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.renameInstall.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function openDialog(install: { displayName: string | null; name: string }) {
  act(() => root.render(<RenameInstallDialog install={{ id: "i1", ...install }} />));
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Rename"]');
  if (trigger === null) throw new Error("no Rename button");
  await act(async () => trigger.click());
  // The dialog finishes opening (no animations here) and selects the name.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

function nameField(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('input[autocomplete="off"]');
  if (input === null) throw new Error("no name field");
  return input;
}

function save(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save");
  if (button === undefined) throw new Error("no Save button");
  return button;
}

describe("the rename dialog", () => {
  it("opens with the display name, selected so that typing replaces it", async () => {
    await openDialog({ displayName: "Team links", name: "Sink" });
    const input = nameField();
    expect(input.value).toBe("Team links");
    expect(document.activeElement).toBe(input);
    // Clearing the name goes back to the app's name, never the Worker's.
    expect(document.body.textContent).toContain("Leave empty to use the app's name, Sink.");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Team links".length]);
  });

  it("opens with the app's name when the install has no display name", async () => {
    await openDialog({ displayName: null, name: "Sink" });
    expect(nameField().value).toBe("Sink");
    expect(document.body.textContent).toContain("Rename Sink");
  });

  it("saves nothing when the name is left as it opened", async () => {
    await openDialog({ displayName: null, name: "Sink" });
    await act(async () => save().click());
    expect(calls.renameInstall).not.toHaveBeenCalled();
  });
});
