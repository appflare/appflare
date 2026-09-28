import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressOptions, MoveAddressResult } from "../domains/manager-address.functions";

/**
 * Setup's "Where should Appflare live?" step, with the move call standing
 * in: nothing here touches an account.
 */
const calls = vi.hoisted(() => ({
  moveManagerAddress: vi.fn(),
  changeManagerAddress: vi.fn(),
}));
vi.mock("../domains/manager-address.functions", () => calls);
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

const { AddressSkippedNote, AddressStep } = await import("./address-step");
const { MoveProgress } = await import("../components/manager-address-move");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS: AddressOptions = {
  zones: [{ id: "z1", name: "example.com", suggestedHostname: "appflare.example.com" }],
  inactiveZones: [],
  missing: [],
  noZones: false,
};
const RESUME = "/setup?checklist=true&address=true";

let container: HTMLDivElement;
let root: Root;
const onDone = vi.fn();
const go = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.moveManagerAddress.mockReset();
  onDone.mockReset();
  go.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const ACCOUNT = "0123456789abcdef0123456789abcdef";

function show(options: AddressOptions = OPTIONS) {
  act(() =>
    root.render(
      <AddressStep
        options={options}
        accountId={ACCOUNT}
        returnTo={RESUME}
        onDone={onDone}
        go={go}
      />,
    ),
  );
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

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}

function choice(value: "keep" | "domain"): HTMLElement {
  const radio = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) =>
    r.closest("label")?.textContent?.includes(value === "keep" ? "Keep" : "Use a domain"),
  );
  if (radio === undefined) throw new Error(`no ${value} choice`);
  return radio;
}

describe("the address step", () => {
  it("keeps the workers.dev address by default, showing where Appflare is now", async () => {
    show();
    expect(page()).toContain("Keep the workers.dev address");
    expect(page()).toContain(`Appflare stays at ${window.location.host}.`);
    expect(choice("keep").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('input[aria-label="Subdomain"]')).toBeNull();
    await click(button("Continue"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(calls.moveManagerAddress).not.toHaveBeenCalled();
  });

  it("goes on with Later, whatever is chosen", async () => {
    show();
    await click(choice("domain"));
    await click(button("Later"));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(calls.moveManagerAddress).not.toHaveBeenCalled();
  });

  it("moves to a domain and opens the sign-in page there, which resumes setup", async () => {
    calls.moveManagerAddress.mockResolvedValue({
      ok: true,
      hostname: "appflare.example.com",
      url: "https://appflare.example.com/login?returnTo=%2Fsetup%3Fchecklist%3Dtrue&moved=1",
    } satisfies MoveAddressResult);
    show();
    await click(choice("domain"));
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Subdomain"]');
    expect(field?.value).toBe("appflare");
    await click(button("Continue"));
    expect(calls.moveManagerAddress).toHaveBeenCalledWith({
      data: { zoneId: "z1", hostname: "appflare.example.com", returnTo: RESUME },
    });
    expect(go).toHaveBeenCalledWith(
      "https://appflare.example.com/login?returnTo=%2Fsetup%3Fchecklist%3Dtrue&moved=1",
    );
    expect(onDone).not.toHaveBeenCalled();
    expect(page()).toContain("Appflare moved to appflare.example.com");
  });

  it("shows the server's words and Try again when the move did not complete", async () => {
    calls.moveManagerAddress.mockRejectedValue(
      new Error("appflare.example.com did not answer as this Appflare within 90 seconds."),
    );
    show();
    await click(choice("domain"));
    await click(button("Continue"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "appflare.example.com did not answer as this Appflare within 90 seconds.",
    );
    expect(button("Try again").disabled).toBe(false);
    expect(go).not.toHaveBeenCalled();
  });
});

describe("the address step's other lines", () => {
  it("links to a new token in the account Appflare runs in when permissions are missing", async () => {
    show({ ...OPTIONS, missing: ["DNS: Edit"] });
    await click(choice("domain"));
    const link = [...document.querySelectorAll("a")].find(
      (a) => a.textContent === "Create a new token",
    );
    expect(link?.getAttribute("href")).toContain(
      `https://dash.cloudflare.com/?to=/${ACCOUNT}/api-tokens`,
    );
  });

  it("says in one line why the step was skipped when the domains could not be read", () => {
    act(() => root.render(<AddressSkippedNote />));
    expect(container.textContent).toBe(
      "Could not read your domains; you can set Appflare's address later in Domains settings.",
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/settings/domains#address");
  });
});

describe("the move's steps", () => {
  it("are a still list when the system asks for reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    act(() => root.render(<MoveProgress hostname="appflare.example.com" />));
    expect([...document.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Attaching the domain",
      "Waiting for the new address to answer",
      "Switching",
    ]);
    // No step is marked as running: nothing moves from one to the next.
    expect(document.querySelectorAll("li[data-step]")).toHaveLength(0);
  });

  it("go on to the wait once attaching has most likely finished", async () => {
    vi.useFakeTimers();
    try {
      act(() => root.render(<MoveProgress hostname="appflare.example.com" />));
      expect(document.querySelector('li[data-step="current"]')?.textContent).toBe(
        "Attaching the domain",
      );
      await act(async () => vi.advanceTimersByTime(5000));
      expect(document.querySelector('li[data-step="current"]')?.textContent).toBe(
        "Waiting for the new address to answer",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
