import { TooltipProvider } from "@cloudflare/kumo";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TakenWorkerNames } from "../installs/worker-name-check";

const server = vi.hoisted(() => ({
  listTakenWorkerNames: vi.fn<() => Promise<TakenWorkerNames>>(),
}));
vi.mock("../installs/worker-names.functions", () => server);

const { UNCHECKED_NOTE, useWorkerNameCheck, WorkerNameField } = await import("./worker-name-field");
const { WORKER_NAME_CHECK_DELAY_MS, ACCOUNT_NAME_MESSAGE, INSTALLED_NAME_MESSAGE } = await import(
  "../installs/worker-name-check"
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  server.listTakenWorkerNames.mockReset();
  server.listTakenWorkerNames.mockResolvedValue({
    installed: ["cut"],
    account: ["cut", "blog"],
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** The form's use of the field: the name in state, checked while `enabled`. */
function NameForm({ start, enabled = true }: { start: string; enabled?: boolean }) {
  const [name, setName] = useState(start);
  const check = useWorkerNameCheck(name, enabled);
  return (
    <TooltipProvider>
      <WorkerNameField
        value={name}
        onChange={setName}
        check={check}
        subdomain="acme"
        description="The app is served at this address."
        readOnly={!enabled}
      />
    </TooltipProvider>
  );
}

function render(start: string, enabled = true) {
  act(() => root.render(<NameForm start={start} enabled={enabled} />));
}

/** The state the end of the field shows, if any. */
function shown(): string | null {
  return container.querySelector("[data-name-check]")?.getAttribute("data-name-check") ?? null;
}

function status(): string {
  return container.querySelector("[data-name-status]")?.textContent ?? "";
}

function type(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Worker name"]');
  if (input === null) throw new Error("no Worker name field");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Typing pauses: the debounce runs out and the list of names arrives. */
async function pause() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(WORKER_NAME_CHECK_DELAY_MS);
  });
}

describe("the Worker name's live check", () => {
  it("shows a spinner while checking, then a check mark for a free name", async () => {
    render("cut-2");
    expect(shown()).toBe("checking");
    expect(status()).toBe("Checking the name.");
    await pause();
    expect(shown()).toBe("free");
    expect(status()).toBe("The name is free.");
  });

  it("says a name is taken by another Worker in the account", async () => {
    render("cut-2");
    await pause();
    type("blog");
    expect(shown()).toBe("checking");
    await pause();
    expect(shown()).toBe("taken");
    expect(container.textContent).toContain(ACCOUNT_NAME_MESSAGE);
  });

  it("says a name is taken by an app installed here", async () => {
    render("cut");
    await pause();
    expect(shown()).toBe("taken");
    expect(container.textContent).toContain(INSTALLED_NAME_MESSAGE);
  });

  it("refuses a name that breaks the rules at once, without asking the server", async () => {
    render("cut-2");
    type("Cut Links");
    expect(shown()).toBe("invalid");
    expect(container.textContent).toContain("Use 1 to 54 lowercase letters");
    await pause();
    expect(server.listTakenWorkerNames).not.toHaveBeenCalled();
  });

  it("asks the server once for the form's lifetime, and only after typing pauses", async () => {
    render("cut-2");
    type("cut-3");
    type("cut-4");
    expect(server.listTakenWorkerNames).not.toHaveBeenCalled();
    await pause();
    type("blog");
    await pause();
    type("cut-5");
    await pause();
    expect(server.listTakenWorkerNames).toHaveBeenCalledTimes(1);
    expect(shown()).toBe("free");
  });

  it("says the account could not be checked when its names cannot be read, and asks again on the next pause", async () => {
    server.listTakenWorkerNames.mockRejectedValueOnce(new Error("offline"));
    render("cut-2");
    await pause();
    expect(shown()).toBeNull();
    expect(container.textContent).not.toContain("Use 1 to 54");
    expect(container.querySelector("[data-name-unchecked]")?.textContent).toBe(UNCHECKED_NOTE);
    expect(status()).toBe(UNCHECKED_NOTE);
    type("cut-3");
    await pause();
    expect(shown()).toBe("free");
    expect(container.querySelector("[data-name-unchecked]")).toBeNull();
    expect(server.listTakenWorkerNames).toHaveBeenCalledTimes(2);
  });

  it("checks nothing for a name that cannot be changed", async () => {
    render("cut", false);
    await pause();
    expect(shown()).toBeNull();
    expect(server.listTakenWorkerNames).not.toHaveBeenCalled();
  });
});
