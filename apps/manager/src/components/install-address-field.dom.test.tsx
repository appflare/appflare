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
    // The visible "Address" heads and names the whole control, as the form's other
    // groups are headed; the field keeps its own name.
    const group = container.querySelector("fieldset");
    const heading = container.querySelector("h3");
    expect(heading?.textContent).toBe("Address");
    expect(group?.getAttribute("aria-labelledby")).toBe(heading?.id);
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

describe("the tray under the address", () => {
  const reason =
    "This name is taken by another Worker in the account, so the install would replace it.";

  /** Renders a taken name's reason, then hovers it (or focuses it, as a keyboard does). */
  async function showReason(openBy: "pointer" | "focus" = "pointer") {
    await act(async () =>
      root.render(
        <TooltipProvider delay={0}>
          <InstallAddressField
            appName="Cut"
            workerName="links"
            onWorkerNameChange={() => {}}
            check={{ state: "taken", message: reason }}
            fixedWorkerName={false}
            subdomain="acme"
            withDomains={false}
            wildcard={null}
            otherWorkers={[]}
            disabled={false}
            onDomainChange={() => {}}
          />
        </TooltipProvider>,
      ),
    );
    const text = container.querySelector<HTMLElement>("[data-address-status-text]");
    // The whole reason is in the page, for a screen reader, however many lines show.
    expect(text?.textContent).toBe(reason);
    expect(container.querySelector("[title]")).toBeNull();
    await act(async () => {
      if (openBy === "focus") {
        text?.focus();
      } else {
        text?.dispatchEvent(
          new PointerEvent("pointerenter", { bubbles: true, pointerType: "mouse" }),
        );
        text?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        text?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      }
      await new Promise((done) => setTimeout(done, 50));
    });
    return [...document.body.querySelectorAll("[data-side]")].find((el) =>
      el.textContent?.includes(reason),
    );
  }

  it("shows a reason its lines cut in Kumo's tooltip, below it, not the browser's own", async () => {
    // Taller than its two lines: the clamp cuts it.
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(60);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
    try {
      const popup = await showReason();
      expect(popup?.getAttribute("data-side")).toBe("bottom");
      // A keyboard reaches it too.
      const text = container.querySelector("[data-address-status-text]");
      expect(text?.getAttribute("tabindex")).toBe("0");
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("opens a cut reason's tooltip from the keyboard too", async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(60);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
    try {
      const popup = await showReason("focus");
      expect(document.activeElement).toBe(container.querySelector("[data-address-status-text]"));
      expect(popup?.getAttribute("data-side")).toBe("bottom");
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  it("has no tooltip for a reason that fits", async () => {
    expect(await showReason()).toBeUndefined();
    // Nothing to open, so no tab stop either.
    expect(container.querySelector("[data-address-status-text]")?.hasAttribute("tabindex")).toBe(
      false,
    );
  });

  it("has no tooltip for a reason that fits but measures a rounded pixel over", async () => {
    // Chromium's numbers for a one-line reason at a line height of 15.29px.
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(16);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(15);
    try {
      expect(await showReason()).toBeUndefined();
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });
});

describe("a name on one of the account's domains that the install would leave out", () => {
  async function showChecked(
    hostnameCheck: Parameters<typeof InstallAddressField>[0]["hostnameCheck"],
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
            onDomainChange={() => {}}
            hostnameCheck={hostnameCheck}
            initial={{ kind: "custom", zoneId: "z1", hostname: "links.example.com" }}
          />
        </TooltipProvider>,
      ),
    );
  }
  const note = () =>
    [...container.querySelectorAll('[role="alert"], [id]')].some((el) =>
      el.textContent?.includes("The install will leave this name out"),
    );

  it("keeps its note while the name is checked again, so nothing below moves", async () => {
    await showChecked({ state: "records", records: [{ type: "A", content: "192.0.2.1" }] });
    expect(note()).toBe(true);
    expect(
      container.querySelector("[data-address-status]")?.getAttribute("data-address-status"),
    ).toBe("warning");
    await showChecked({ state: "checking" });
    expect(note()).toBe(true);
    await showChecked({ state: "free" });
    expect(note()).toBe(false);
    // Checked again from free: nothing to keep.
    await showChecked({ state: "checking" });
    expect(note()).toBe(false);
  });

  it("is read with the address field", async () => {
    await showChecked({ state: "other-worker", worker: "blog" });
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Subdomain"]');
    const described = (field?.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(described).toContain("remove the domain from blog in Cloudflare, then install");
  });
});
