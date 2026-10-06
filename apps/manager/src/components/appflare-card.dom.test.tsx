import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerStatus } from "../installs/pending-updates";
import type { JobView } from "../jobs/jobs.functions";

/**
 * The sidebar's Appflare card, with the self-update and the job it follows
 * standing in: nothing here updates anything.
 */
const calls = vi.hoisted(() => ({
  startSelfUpdate: vi.fn(async (_: { data: { version: string } }) => ({ jobId: "01SELFUPDATE" })),
  /** What the followed job looks like; null when there is none. */
  job: null as Partial<JobView> | null,
  stalled: false,
}));
vi.mock("../catalog/manager-releases.functions", () => ({
  startSelfUpdate: calls.startSelfUpdate,
  checkManagerUpdates: vi.fn(),
}));
vi.mock("../jobs/live-job", () => ({
  POLL_MS: 2000,
  useLiveJob: (jobId: string | null) =>
    jobId === null
      ? null
      : (calls.job ?? {
          status: "running",
          targetVersion: "0.4.0",
          error: null,
          logs: [{ message: "Uploading the new version" }],
          reportedAt: null,
        }),
  useVersionSwitch: () => ({ switching: false, stalled: calls.stalled }),
}));
vi.mock("../auto-update/auto-update.functions", () => ({ setAutoUpdateDefaults: vi.fn() }));
vi.mock("../telemetry/telemetry.functions", () => ({
  previewJobReport: vi.fn(),
  sendJobReport: vi.fn(),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

const { AppflareCard } = await import("./appflare-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AVAILABLE: ManagerStatus = {
  current: "0.3.1",
  latest: "0.4.0",
  updateAvailable: true,
  activeJobId: null,
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.startSelfUpdate.mockClear();
  calls.job = null;
  calls.stalled = false;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function show(manager: ManagerStatus) {
  act(() =>
    root.render(
      <TooltipProvider>
        <AppflareCard manager={manager} isAdmin />
      </TooltipProvider>,
    ),
  );
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function button(within: HTMLElement, label: string): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

async function pressEscape() {
  await act(async () => {
    (document.activeElement ?? document).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  await settle();
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="alertdialog"]');
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}

describe("AppflareCard", () => {
  it("asks before updating, in the same confirmation as Settings, Updates", async () => {
    show(AVAILABLE);
    await click(button(container, "Update"));
    const confirm = dialog();
    expect(confirm?.textContent).toContain("Update Appflare to 0.4.0");
    expect(confirm?.textContent).toContain("From 0.3.1.");
    expect(calls.startSelfUpdate).not.toHaveBeenCalled();

    if (confirm === null) throw new Error("no confirmation");
    await click(button(confirm, "Update"));
    expect(calls.startSelfUpdate).toHaveBeenCalledWith({ data: { version: "0.4.0" } });
    // The card follows the update it started.
    expect(container.textContent).toContain("Updating to 0.4.0");
    expect(container.textContent).toContain("Uploading the new version");
    // The button that opened the confirmation is gone: the focus is on the card.
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(container.firstElementChild);
  });

  it("returns the focus to Update when the confirmation is cancelled", async () => {
    show(AVAILABLE);
    await click(button(container, "Update"));
    const confirm = dialog();
    if (confirm === null) throw new Error("no confirmation");
    await click(button(confirm, "Cancel"));
    await settle();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button(container, "Update"));
  });

  it("returns the focus to Update when the confirmation is closed with Escape", async () => {
    show(AVAILABLE);
    await click(button(container, "Update"));
    expect(dialog()).not.toBeNull();
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button(container, "Update"));
    expect(calls.startSelfUpdate).not.toHaveBeenCalled();
  });

  it("keeps the confirmation open with the reason when the update cannot start", async () => {
    calls.startSelfUpdate.mockRejectedValueOnce(new Error("Another job is running."));
    show(AVAILABLE);
    await click(button(container, "Update"));
    const confirm = dialog();
    if (confirm === null) throw new Error("no confirmation");
    await click(button(confirm, "Update"));
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "Another job is running.",
    );
    expect(container.textContent).toContain("Appflare 0.4.0 is available");
  });

  it("asks again before Try again after a failed update", async () => {
    calls.job = {
      status: "failed",
      targetVersion: "0.4.0",
      error: "The preview did not answer.",
      logs: [],
      reportedAt: null,
    };
    show({ ...AVAILABLE, activeJobId: "01FAILED" });
    expect(container.textContent).toContain("Update to 0.4.0 failed");
    await click(button(container, "Try again"));
    expect(dialog()?.textContent).toContain("Update Appflare to 0.4.0");
    expect(calls.startSelfUpdate).not.toHaveBeenCalled();

    // Escape, then Cancel: the focus goes back to Try again each time.
    await pressEscape();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button(container, "Try again"));
    await click(button(container, "Try again"));
    const confirm = dialog();
    if (confirm === null) throw new Error("no confirmation");
    await click(button(confirm, "Cancel"));
    await settle();
    expect(document.activeElement).toBe(button(container, "Try again"));
  });

  it("offers Reload as a button when the new version does not answer", () => {
    calls.job = {
      status: "succeeded",
      targetVersion: "0.4.0",
      error: null,
      logs: [],
      reportedAt: null,
    };
    calls.stalled = true;
    show({ ...AVAILABLE, activeJobId: "01DONE" });
    expect(container.textContent).toContain("Updated to 0.4.0");
    expect(button(container, "Reload")).toBeDefined();
    expect(container.querySelector('a[href="#"]')).toBeNull();
  });
});
