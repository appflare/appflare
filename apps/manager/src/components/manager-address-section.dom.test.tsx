import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AddressOptions,
  ManagerAddress,
  MoveAddressResult,
  RevertResult,
} from "../domains/manager-address.functions";

/**
 * Settings, Domains, "Appflare's address", with the server functions
 * standing in: nothing here touches an account.
 */
const calls = vi.hoisted(() => ({
  getManagerAddress: vi.fn(),
  getManagerAddressOptions: vi.fn(),
  moveManagerAddress: vi.fn(),
  changeManagerAddress: vi.fn(),
  revertManagerAddress: vi.fn(),
  invalidate: vi.fn(async () => {}),
}));
vi.mock("../domains/manager-address.functions", () => ({
  getManagerAddress: calls.getManagerAddress,
  getManagerAddressOptions: calls.getManagerAddressOptions,
  moveManagerAddress: calls.moveManagerAddress,
  changeManagerAddress: calls.changeManagerAddress,
  revertManagerAddress: calls.revertManagerAddress,
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: calls.invalidate, navigate: async () => {} }),
}));

const { ManagerAddressSection } = await import("./manager-address-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const WORKERS_DEV = "appflare.ada.workers.dev";

const AT_WORKERS_DEV: ManagerAddress = {
  hostname: null,
  zoneId: null,
  previousHostname: null,
  movedAt: null,
  workersDevHostname: WORKERS_DEV,
  serving: null,
  attachedByHand: [],
};

const AT_DOMAIN: ManagerAddress = {
  hostname: "appflare.example.com",
  zoneId: "z1",
  previousHostname: WORKERS_DEV,
  movedAt: "2026-09-20T10:00:00.000Z",
  workersDevHostname: WORKERS_DEV,
  serving: true,
  attachedByHand: [],
};

const ONE_ZONE: AddressOptions = {
  zones: [{ id: "z1", name: "example.com", suggestedHostname: "appflare.example.com" }],
  inactiveZones: [],
  missing: [],
  noZones: false,
};

const NO_ZONES: AddressOptions = {
  zones: [],
  inactiveZones: [],
  missing: ["Zone: Read", "DNS: Edit", "Workers Routes: Edit"],
  noZones: true,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const call of Object.values(calls)) call.mockReset();
  calls.getManagerAddressOptions.mockResolvedValue(ONE_ZONE);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function show(address: ManagerAddress, options: AddressOptions = ONE_ZONE) {
  act(() => root.render(<ManagerAddressSection view={{ address, options, accountId: ACCOUNT }} />));
}

function page(): string {
  return document.body.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

function hasButton(label: string): boolean {
  return [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === label);
}

function subdomainField(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Subdomain"]');
  if (input === null) throw new Error("no subdomain field");
  return input;
}

/** Whether leaving the page now would make the browser ask first. */
function leaveIsQuestioned(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}

describe("Appflare's address at workers.dev", () => {
  it("shows the workers.dev address with Open and Use a domain", () => {
    show(AT_WORKERS_DEV);
    const section = document.querySelector("section#address");
    expect(section?.textContent).toContain("Appflare's address");
    expect(page()).toContain(WORKERS_DEV);
    expect(page()).toContain("Appflare lives at its workers.dev address.");
    const open = [...document.querySelectorAll("a")].find((a) => a.textContent === "Open");
    expect(open?.getAttribute("href")).toBe(`https://${WORKERS_DEV}`);
    expect(hasButton("Use a domain")).toBe(true);
    expect(hasButton("Go back to workers.dev")).toBe(false);
  });

  it("moves to the suggested host of the only zone, asking before it replaces DNS records", async () => {
    calls.moveManagerAddress
      .mockResolvedValueOnce({
        ok: false,
        reason: "dns-conflict",
        hostname: "appflare.example.com",
        records: [{ type: "A", content: "192.0.2.1" }],
      } satisfies MoveAddressResult)
      .mockResolvedValueOnce({
        ok: true,
        hostname: "appflare.example.com",
        url: "https://appflare.example.com/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1",
      } satisfies MoveAddressResult);
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    // The only zone is chosen, and the host starts as appflare.<zone>.
    expect(subdomainField().value).toBe("appflare");
    expect(page()).toContain("Appflare answers at https://appflare.example.com.");

    await click(button("Move Appflare"));
    expect(calls.moveManagerAddress).toHaveBeenLastCalledWith({
      data: { zoneId: "z1", hostname: "appflare.example.com" },
    });
    expect(page()).toContain("appflare.example.com already has DNS records");
    expect(page()).toContain("A 192.0.2.1");
    expect(page()).toContain("Cloudflare deletes them, and Appflare cannot put them back");
    expect(button("Replace records and move").disabled).toBe(true);
    // The box is described by the warning above it.
    const box = document.querySelector('[role="checkbox"]');
    const warning = document.getElementById(box?.getAttribute("aria-describedby") ?? "");
    expect(warning?.textContent).toContain("Appflare cannot put them back");

    // Base UI's checkbox follows its (hidden) native input.
    const replace = document.querySelector<HTMLInputElement>('label input[type="checkbox"]');
    if (replace === null) throw new Error("no replace checkbox");
    await click(replace);
    expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    await click(button("Replace records and move"));
    expect(calls.moveManagerAddress).toHaveBeenLastCalledWith({
      data: { zoneId: "z1", hostname: "appflare.example.com", overrideExistingDnsRecord: true },
    });
    // A dialog that cannot be dismissed says where Appflare lives now, and links to its sign-in page.
    const notice = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.textContent?.includes("Appflare now lives at appflare.example.com"),
    );
    expect(notice?.textContent).toContain("Sign in again there.");
    expect(notice?.textContent).toContain(
      "Passkeys added at the old address work only there; add new ones in Users and sign-in.",
    );
    expect(notice?.textContent).not.toContain("Move Appflare");
    const go = [...(notice?.querySelectorAll("a") ?? [])].find((a) =>
      a.textContent?.includes("Go to appflare.example.com"),
    );
    expect(go?.getAttribute("href")).toBe(
      "https://appflare.example.com/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1",
    );
    expect(document.activeElement).toBe(go);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(page()).toContain("Appflare now lives at appflare.example.com");
  });

  it("shows the steps while the move runs, and cannot be closed meanwhile", async () => {
    let finish: (result: MoveAddressResult) => void = () => {};
    calls.moveManagerAddress.mockReturnValue(
      new Promise<MoveAddressResult>((resolve) => {
        finish = resolve;
      }),
    );
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await click(button("Move Appflare"));
    expect(page()).toContain("Moving Appflare to appflare.example.com");
    const steps = [...document.querySelectorAll("li[data-step]")].map((li) => [
      li.textContent,
      li.getAttribute("data-step"),
    ]);
    expect(steps).toEqual([
      ["Attaching the domain", "current"],
      ["Waiting for the new address to answer", "next"],
      ["Switching", "next"],
    ]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settle();
    expect(page()).toContain("Moving Appflare to appflare.example.com");
    // Leaving the page asks first while the move runs...
    expect(leaveIsQuestioned()).toBe(true);
    await act(async () =>
      finish({
        ok: true,
        hostname: "appflare.example.com",
        url: "https://appflare.example.com/login",
      }),
    );
    await settle();
    expect(page()).toContain("Appflare now lives at appflare.example.com");
    // ...and no longer once it settled.
    expect(leaveIsQuestioned()).toBe(false);
  });

  it("uses the zone's root when the host is left empty", async () => {
    calls.moveManagerAddress.mockResolvedValue({
      ok: true,
      hostname: "example.com",
      url: "https://example.com/login",
    } satisfies MoveAddressResult);
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await act(async () => {
      const input = subdomainField();
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Move Appflare"));
    expect(calls.moveManagerAddress).toHaveBeenLastCalledWith({
      data: { zoneId: "z1", hostname: "example.com" },
    });
  });

  it("shows the server's words when the new address did not answer in time, with Try again", async () => {
    const message =
      "appflare.example.com did not answer as this Appflare within 90 seconds (last answer: HTTP 525). Appflare stays at appflare.ada.workers.dev. appflare.example.com stays attached to Appflare so you can try again: the DNS records it replaced are gone, and Appflare cannot put them back. A new domain's certificate can take a few minutes; try again shortly.";
    calls.moveManagerAddress.mockRejectedValueOnce(new Error(message));
    show(AT_WORKERS_DEV);
    await click(button("Use a domain"));
    await click(button("Move Appflare"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(hasButton("Try again")).toBe(true);
  });

  it("offers a domain attached by hand as the address", async () => {
    calls.moveManagerAddress.mockResolvedValue({
      ok: true,
      hostname: "manage.beta.dev",
      url: "https://manage.beta.dev/login",
    } satisfies MoveAddressResult);
    show({
      ...AT_WORKERS_DEV,
      attachedByHand: [{ hostname: "manage.beta.dev", zoneId: "z2", zoneName: "beta.dev" }],
    });
    expect(page()).toContain("A domain already points at Appflare: manage.beta.dev");
    await click(button("Use it as Appflare's address"));
    // The hand-attached domain's zone is offered even though the options lack it.
    expect(subdomainField().value).toBe("manage");
    await click(button("Move Appflare"));
    expect(calls.moveManagerAddress).toHaveBeenLastCalledWith({
      data: { zoneId: "z2", hostname: "manage.beta.dev" },
    });
  });

  it("says quietly how to get a domain when the account has none", () => {
    show(AT_WORKERS_DEV, NO_ZONES);
    expect(page()).toContain(
      "Add a domain to your Cloudflare account to give Appflare its own address.",
    );
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "Add a domain in Cloudflare",
    );
    expect(link?.getAttribute("href")).toBe(
      `https://dash.cloudflare.com/?to=/${ACCOUNT}/domains/overview`,
    );
    expect(hasButton("Use a domain")).toBe(false);
  });
});

describe("Appflare's address on a domain", () => {
  it("shows the domain with Open, Change and Go back to workers.dev", () => {
    show(AT_DOMAIN);
    expect(page()).toContain("appflare.example.com");
    expect(page()).toContain(`${WORKERS_DEV} sends page visits here.`);
    expect(hasButton("Change")).toBe(true);
    expect(hasButton("Go back to workers.dev")).toBe(true);
    expect(hasButton("Use a domain")).toBe(false);
  });

  it("changes to another host with the change call", async () => {
    calls.changeManagerAddress.mockResolvedValue({
      ok: true,
      hostname: "app.example.com",
      url: "https://app.example.com/login",
    } satisfies MoveAddressResult);
    show(AT_DOMAIN);
    await click(button("Change"));
    await act(async () => {
      const input = subdomainField();
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "app");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Change address"));
    expect(calls.changeManagerAddress).toHaveBeenCalledWith({
      data: { zoneId: "z1", hostname: "app.example.com" },
    });
    expect(calls.moveManagerAddress).not.toHaveBeenCalled();
  });

  it("goes back to workers.dev after explaining what stops, then offers the sign-in there", async () => {
    calls.revertManagerAddress.mockResolvedValue({
      wasMoved: true,
      url: `https://${WORKERS_DEV}/login?returnTo=%2Fsettings%2Fdomains%23address&moved=1`,
      previousDomain: "detached",
    } as RevertResult);
    show(AT_DOMAIN);
    await click(button("Go back to workers.dev"));
    expect(page()).toContain("stops sending visits to appflare.example.com");
    expect(page()).toContain("Passkeys added at appflare.example.com work only there");
    const confirm = [...document.querySelectorAll('[role="alertdialog"] button')].find(
      (b) => b.textContent?.trim() === "Go back to workers.dev",
    );
    if (!(confirm instanceof HTMLButtonElement)) throw new Error("no confirm button");
    await click(confirm);
    expect(calls.revertManagerAddress).toHaveBeenCalledWith({ data: {} });
    expect(page()).toContain(`Appflare now lives at ${WORKERS_DEV}`);
  });

  it("warns when Cloudflare no longer lists the domain", () => {
    show({ ...AT_DOMAIN, serving: false });
    expect(page()).toContain("appflare.example.com no longer points at Appflare");
  });
});
