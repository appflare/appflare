import { TooltipProvider } from "@cloudflare/kumo";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TakenWorkerNames } from "../installs/worker-name-check";

const server = vi.hoisted(() => ({
  listTakenWorkerNames: vi.fn<() => Promise<TakenWorkerNames>>(),
}));
vi.mock("../installs/worker-names.functions", () => server);
// The domains are only read for an admin who can install; this form never does.
vi.mock("../installs/custom-domains.functions", () => ({ getDomainOptions: vi.fn() }));
vi.mock("../installs/external-domains.functions", () => ({ getExternalDomainOptions: vi.fn() }));

const { UNCHECKED_NOTE, useWorkerNameCheck } = await import("./worker-name-field");
const { InstallAddressField } = await import("./install-address-field");
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

/** The install form's use of the address: the name in state, checked while `enabled`. */
function NameForm({ start, enabled = true }: { start: string; enabled?: boolean }) {
  const [name, setName] = useState(start);
  const check = useWorkerNameCheck(name, enabled);
  return (
    <TooltipProvider>
      <InstallAddressField
        appName="Cut"
        workerName={name}
        onWorkerNameChange={setName}
        check={check}
        fixedWorkerName={!enabled}
        subdomain="acme"
        withDomains={false}
        wildcard={null}
        otherWorkers={[]}
        disabled={false}
        onDomainChange={noop}
      />
    </TooltipProvider>
  );
}

function noop() {}

function render(start: string, enabled = true) {
  act(() => root.render(<NameForm start={start} enabled={enabled} />));
}

/** The state the line under the address shows: success, danger, neutral, or nothing. */
function tone(): string | null {
  return (
    container.querySelector("[data-address-status]")?.getAttribute("data-address-status") ?? null
  );
}

/** What the tray under the address says about the name (announced as it changes). */
function status(): string {
  return container.querySelector("[data-address-status-text]")?.textContent ?? "";
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
  it("says it is checking, then Available in green for a free name, in the same tray", async () => {
    render("cut-2");
    expect(tone()).toBe("pending");
    expect(status()).toBe("Checking the name…");
    await pause();
    expect(tone()).toBe("success");
    expect(status()).toBe("Available");
    // The address reads whole: the name, then the account's workers.dev subdomain.
    expect(container.textContent).toContain("acme.workers.dev");
  });

  it("says a name is taken by another Worker in the account", async () => {
    render("cut-2");
    await pause();
    type("blog");
    expect(tone()).toBe("pending");
    await pause();
    expect(tone()).toBe("danger");
    expect(status()).toBe(ACCOUNT_NAME_MESSAGE);
  });

  it("says a name is taken by an app installed here", async () => {
    render("cut");
    await pause();
    expect(tone()).toBe("danger");
    expect(status()).toBe(INSTALLED_NAME_MESSAGE);
  });

  it("refuses a name that breaks the rules at once, without asking the server", async () => {
    render("cut-2");
    type("Cut Links");
    expect(tone()).toBe("danger");
    expect(status()).toContain("Use 1 to 54 lowercase letters");
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
    expect(tone()).toBe("success");
  });

  it("says the account could not be checked when its names cannot be read, and asks again on the next pause", async () => {
    server.listTakenWorkerNames.mockRejectedValueOnce(new Error("offline"));
    render("cut-2");
    await pause();
    expect(tone()).toBe("neutral");
    expect(status()).toBe(UNCHECKED_NOTE);
    type("cut-3");
    await pause();
    expect(tone()).toBe("success");
    expect(server.listTakenWorkerNames).toHaveBeenCalledTimes(2);
  });

  it("checks nothing for a name that cannot be changed, and says why", async () => {
    render("cut", false);
    await pause();
    expect(tone()).toBe("neutral");
    expect(status()).toContain("Cut only works under this name");
    expect(server.listTakenWorkerNames).not.toHaveBeenCalled();
  });
});
