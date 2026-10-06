import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CapabilitiesView, capabilitiesView } from "../capabilities/capabilities";
import type { SandboxCardState } from "../server/sandbox.functions";

/**
 * Settings, Building apps, the sandbox builds section, with the server
 * functions standing in: nothing here touches an account.
 */
const calls = vi.hoisted(() => ({
  connectSandbox: vi.fn(async () => ({ alreadyConnected: false, versionId: "v2" })),
  startSandboxJob: vi.fn(async () => ({ jobId: "01SANDBOXJOB00000000000001" })),
  jobStarted: vi.fn(async () => {}),
}));
vi.mock("../server/sandbox.functions", () => ({
  connectSandbox: calls.connectSandbox,
  startSandboxJob: calls.startSandboxJob,
}));
vi.mock("../telemetry/telemetry.functions", () => ({
  previewJobReport: vi.fn(),
  sendJobReport: vi.fn(),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => calls.jobStarted }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

const { SandboxCard } = await import("./sandbox-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "0123456789abcdef0123456789abcdef";

/** An account on Workers Paid, as the probes detected it, with R2 and Containers usable. */
const PAID: CapabilitiesView = {
  ...capabilitiesView(null, null, ACCOUNT),
  plan: { plan: "paid", source: "detected" },
};
const NOT_DETECTED: CapabilitiesView = capabilitiesView(null, null, ACCOUNT);

const OFF: SandboxCardState = {
  connected: false,
  info: null,
  problem: null,
  workerExists: false,
  danglingBinding: false,
  pinnedVersion: "0.1.3",
  updateAvailable: false,
  activeJob: null,
  lastFailure: null,
  inUseBy: [],
  readiness: { state: "ready-auto", missing: null, confirmed: true },
};

/** What a disable that deleted everything but stopped short of disconnecting leaves. */
const LEFT_BOUND: SandboxCardState = { ...OFF, danglingBinding: true };

const NOTE = "Appflare still has a binding to a deleted sandbox Worker";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  for (const call of Object.values(calls)) call.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function show(status: SandboxCardState, capabilities = PAID, isAdmin = true) {
  act(() =>
    root.render(<SandboxCard status={status} capabilities={capabilities} isAdmin={isAdmin} />),
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

function hasButton(label: string): boolean {
  return [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === label);
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}

function type(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("SandboxCard", () => {
  it("reads a binding to a deleted sandbox Worker as off, and offers Disable and Enable", () => {
    show(LEFT_BOUND);
    expect(page()).toContain("Off");
    expect(page()).not.toContain("Not answering");
    expect(page()).toContain(NOTE);
    expect(page()).toContain(
      "Sandbox builds are off. Disabling them removes the binding, and enabling them replaces it.",
    );
    expect(hasButton("Disable sandbox builds")).toBe(true);
    expect(hasButton("Enable sandbox builds")).toBe(true);
    // There is no sandbox Worker to connect to.
    expect(hasButton("Connect only")).toBe(false);
  });

  it("offers Connect only too when a sandbox Worker is there again", () => {
    show({ ...LEFT_BOUND, workerExists: true });
    expect(page()).toContain(NOTE);
    expect(hasButton("Disable sandbox builds")).toBe(true);
    expect(hasButton("Connect only")).toBe(true);
  });

  it("offers Disable for the binding without Workers Paid detected", () => {
    show(LEFT_BOUND, NOT_DETECTED);
    expect(page()).toContain(NOTE);
    expect(hasButton("Disable sandbox builds")).toBe(true);
    expect(hasButton("Enable sandbox builds")).toBe(false);
  });

  it("shows members sandbox builds as off, with nothing to do about the binding", () => {
    show({ ...LEFT_BOUND, workerExists: null }, PAID, false);
    expect(page()).toContain("Off");
    expect(page()).not.toContain("Not answering");
    expect(page()).not.toContain(NOTE);
    expect(hasButton("Disable sandbox builds")).toBe(false);
    expect(hasButton("Enable sandbox builds")).toBe(false);
  });

  it("offers no Disable when nothing of sandbox builds is left", () => {
    show(OFF);
    expect(page()).not.toContain(NOTE);
    expect(hasButton("Disable sandbox builds")).toBe(false);
    expect(hasButton("Enable sandbox builds")).toBe(true);
  });

  it("still says a connected sandbox Worker that does not answer is not answering", () => {
    show({ ...OFF, connected: true, workerExists: null, problem: "Network connection lost." });
    expect(page()).toContain("Not answering");
    expect(page()).toContain("The sandbox Worker does not answer as expected");
    expect(page()).not.toContain(NOTE);
    expect(hasButton("Disable sandbox builds")).toBe(true);
    expect(hasButton("Update sandbox")).toBe(true);
  });

  it("shows a running job with the moving loader, hidden from screen readers", () => {
    show({ ...OFF, activeJob: { id: "01SANDBOXJOB00000000000001", kind: "sandbox_enable" } });
    // The innermost element that starts with the title: the banner itself.
    const banner = [...document.querySelectorAll("div")].findLast((d) =>
      d.textContent?.startsWith("Enable sandbox builds is running"),
    );
    if (banner === undefined) throw new Error("no running banner");
    const loader = banner.querySelector("svg");
    expect(loader?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(banner.querySelector('[role="status"]')).toBeNull();
  });

  it("announces Connect only's success through a status that was there before", async () => {
    show({ ...OFF, workerExists: true });
    const status = [...document.querySelectorAll('[role="status"]')];
    expect(status.map((s) => s.textContent)).toEqual([""]);
    // The empty region shares a grid item with the card's view, so it adds no gap.
    expect(status[0]?.parentElement?.children).toHaveLength(2);
    await click(button("Connect only"));
    expect(calls.connectSandbox).toHaveBeenCalled();
    expect(status[0]?.isConnected).toBe(true);
    // The status holds the visible banner itself: one announcement, not two.
    expect(status[0]?.textContent).toContain("Sandbox builds are connected");
    expect(status[0]?.textContent).toContain("It can take a few seconds to show here.");
    expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(page().split("Sandbox builds are connected")).toHaveLength(2);
    // The refreshed status shows the card connected: the region and its message stay.
    show({ ...OFF, connected: true });
    expect(status[0]?.isConnected).toBe(true);
    expect(status[0]?.textContent).toContain("Sandbox builds are connected");
  });

  it("says, without a full stop, when it could not check for the sandbox Worker", () => {
    show({ ...OFF, workerExists: null });
    expect(page()).toContain("Appflare could not check whether the sandbox Worker exists");
    expect(page()).not.toContain("sandbox Worker exists.");
  });

  it("says Disable deletes first and disconnects last, and starts it with the typed name", async () => {
    show(LEFT_BOUND);
    await click(button("Disable sandbox builds"));
    expect(page()).toContain(
      "Appflare deletes the sandbox Worker with the containers it builds in and the storage that holds every build and its log, then disconnects from it.",
    );
    expect(page()).not.toContain("disconnects from the sandbox Worker, then deletes it");
    const confirm = document.querySelector<HTMLInputElement>(
      'input[placeholder="appflare-sandbox"]',
    );
    if (confirm === null) throw new Error("no confirmation field");
    type(confirm, "appflare-sandbox");
    await click(button("Disable and delete"));
    expect(calls.startSandboxJob).toHaveBeenCalledWith({
      data: { action: "disable", confirm: "appflare-sandbox" },
    });
    expect(calls.jobStarted).toHaveBeenCalledWith(
      "01SANDBOXJOB00000000000001",
      "Disabling sandbox builds",
    );
  });
});
