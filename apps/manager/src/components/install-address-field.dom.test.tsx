import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  getDomainOptions: vi.fn(async () => ({
    zones: [{ id: "z1", name: "example.com" }],
    inactiveZones: [],
    missing: [],
    noZones: false,
  })),
  getExternalDomainOptions: vi.fn(async () => ({
    gateway: { zoneName: "gateway.example.net", hostname: "apps.gateway.example.net" },
    accountZones: ["example.com"],
  })),
}));
vi.mock("../installs/custom-domains.functions", () => ({
  getDomainOptions: server.getDomainOptions,
}));
vi.mock("../installs/external-domains.functions", () => ({
  getExternalDomainOptions: server.getExternalDomainOptions,
}));
vi.mock("../installs/worker-names.functions", () => ({ listTakenWorkerNames: vi.fn() }));

const { InstallAddressField } = await import("./install-address-field");

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

async function show(
  onDomainChange = vi.fn(),
  initial: Parameters<typeof InstallAddressField>[0]["initial"] = null,
) {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <InstallAddressField
          appName="Cut"
          workerName="links"
          onWorkerNameChange={() => {}}
          check={{ state: "free" }}
          fixedWorkerName={false}
          subdomain="acme"
          withDomains
          wildcard={null}
          otherWorkers={[]}
          disabled={false}
          onDomainChange={onDomainChange}
          initial={initial}
        />
      </TooltipProvider>,
    ),
  );
  return onDomainChange;
}

function trigger(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[aria-label^="Domain of the address"]');
  if (found === null) throw new Error("no domain dropdown");
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

describe("the address's domain dropdown", () => {
  it("is not inside the text field's label, which took its pointer clicks", async () => {
    await show();
    expect(trigger().closest("label")).toBeNull();
    // The visible "Address" names the whole control; the field keeps its own name.
    expect(container.querySelector("legend")?.textContent).toBe("Address");
    expect(container.querySelector('input[aria-label="Worker name"]')).not.toBeNull();
  });

  it("selects a domain with the mouse, and the address becomes a name under it", async () => {
    const onDomainChange = await show();
    expect(trigger().textContent).toContain(".acme.workers.dev");
    await press(trigger());
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (o) => o.textContent?.trim() === "example.com",
    );
    expect(option).toBeDefined();
    await press(option as Element);
    expect(trigger().textContent).toContain(".example.com");
    expect(onDomainChange).toHaveBeenLastCalledWith(
      { kind: "custom", zoneId: "z1", hostname: "links.example.com" },
      true,
    );
  });

  it("shows the status in the tray under the field, never inside it", async () => {
    await show();
    const control = container.querySelector("[data-address-control]");
    // No state icon inside the field: the only icon there is the dropdown's caret.
    expect(control?.querySelector(".text-kumo-success, .text-kumo-danger")).toBeNull();
    const tray = container.querySelector("[data-address-tray]");
    expect(tray?.querySelector("[data-address-status-text]")?.textContent).toBe("Available");
    expect(tray?.textContent).toContain("https://links.acme.workers.dev");
  });

  it("filters the domains by what is typed in its search", async () => {
    await show();
    await press(trigger());
    const search = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search your domains"]',
    );
    expect(search).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(search, "nothing-like-it");
      search?.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((done) => setTimeout(done, 50));
    });
    const options = [...document.querySelectorAll('[role="option"]')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).not.toContain("example.com");
    expect(options).toContain("Another domain, managed elsewhere…");
    expect(document.body.textContent).toContain("No domain of yours matches “nothing-like-it”.");
  });
});

describe("the address of an install made again", () => {
  it("starts on the domain it had, with the name before it", async () => {
    const onDomainChange = await show(vi.fn(), {
      kind: "custom",
      zoneId: "z1",
      hostname: "go.example.com",
    });
    expect(trigger().textContent).toContain(".example.com");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Subdomain"]')?.value).toBe(
      "go",
    );
    expect(onDomainChange).toHaveBeenLastCalledWith(
      { kind: "custom", zoneId: "z1", hostname: "go.example.com" },
      true,
    );
  });

  it("starts on the domain itself when it took the whole domain", async () => {
    const onDomainChange = await show(vi.fn(), {
      kind: "custom",
      zoneId: "z1",
      hostname: "example.com",
    });
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Subdomain"]')?.value).toBe(
      "",
    );
    expect(trigger().textContent?.trim()).toBe("example.com");
    expect(onDomainChange).toHaveBeenLastCalledWith(
      { kind: "custom", zoneId: "z1", hostname: "example.com" },
      true,
    );
  });

  it("starts on another domain with its hostname and how it is verified", async () => {
    const onDomainChange = await show(vi.fn(), {
      kind: "external",
      hostname: "links.example.org",
      validation: "txt",
    });
    expect(trigger().textContent).toContain("Another domain");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Hostname"]')?.value).toBe(
      "links.example.org",
    );
    expect(onDomainChange).toHaveBeenLastCalledWith(
      { kind: "external", hostname: "links.example.org", validation: "txt" },
      true,
    );
  });
});

describe("the address's tray and picker, for a screen reader", () => {
  it("announce the name's state, not the address, and name the chosen domain", async () => {
    await show();
    const tray = container.querySelector("[data-address-tray]");
    expect(tray?.getAttribute("role")).toBeNull();
    expect(tray?.querySelector('[role="status"]')?.textContent).toBe("Available");
    expect(trigger().getAttribute("aria-label")).toBe("Domain of the address: .acme.workers.dev");
  });
});

describe("the Worker name field on a domain", () => {
  it("stays open while a new name is typed after a taken one", async () => {
    const props = {
      appName: "Cut",
      workerName: "links",
      onWorkerNameChange: () => {},
      fixedWorkerName: false,
      subdomain: "acme",
      withDomains: true,
      wildcard: null,
      otherWorkers: [],
      disabled: false,
      onDomainChange: () => {},
      initial: { kind: "custom" as const, zoneId: "z1", hostname: "go.example.com" },
    };
    await act(async () =>
      root.render(
        <TooltipProvider>
          <InstallAddressField {...props} check={{ state: "taken", message: "Taken here." }} />
        </TooltipProvider>,
      ),
    );
    const field = () => container.querySelector('input[aria-label="Worker name"]');
    expect(field()).not.toBeNull();
    await act(async () =>
      root.render(
        <TooltipProvider>
          <InstallAddressField {...props} workerName="links-2" check={{ state: "checking" }} />
        </TooltipProvider>,
      ),
    );
    expect(field()).not.toBeNull();
  });
});
