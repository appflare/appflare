import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerVersionRow } from "../jobs/self-update/rollback";
import type { ManagerVersionsState } from "../jobs/self-update/rollback.functions";

/**
 * Settings, Updates, "Recent versions", with the rollback and the wait for
 * the older version standing in: nothing here rolls anything back.
 */
const calls = vi.hoisted(() => ({
  rollBackManager: vi.fn(async () => ({
    jobId: "01ROLLBACK",
    version: "0.3.0",
    versionId: "v-old",
    fromVersion: "0.3.1",
    finishedAt: "2026-10-06T10:00:00.000Z",
  })),
  stalled: false,
}));
vi.mock("../jobs/self-update/rollback.functions", () => ({
  rollBackManager: calls.rollBackManager,
}));
vi.mock("../jobs/live-job", () => ({
  useVersionSwitch: () => ({ switching: false, stalled: calls.stalled }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

const { ManagerVersionsSection } = await import("./manager-versions-section");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(id: string, version: string, serving: boolean): ManagerVersionRow {
  return {
    id,
    number: null,
    createdOn: "2026-10-01T10:00:00.000Z",
    appflareVersion: version,
    trigger: "upload",
    message: null,
    serving,
    older: !serving,
  };
}

const STATE: ManagerVersionsState = {
  ok: true,
  versions: [row("v-new", "0.3.1", true), row("v-old", "0.3.0", false)],
  servingVersionId: "v-new",
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.rollBackManager.mockClear();
  calls.stalled = false;
  window.sessionStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

function show(current = "0.3.1") {
  act(() =>
    root.render(
      <TooltipProvider>
        <ManagerVersionsSection state={STATE} isAdmin current={current} />
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

function status(): HTMLElement {
  const found = container.querySelectorAll<HTMLElement>('[role="status"]');
  expect(found).toHaveLength(1);
  return found[0] as HTMLElement;
}

async function rollBackTo(label: string) {
  await act(async () => button(container, "Roll back").click());
  await settle();
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  if (dialog === null) throw new Error("no confirmation");
  const input = dialog.querySelector<HTMLInputElement>(`input[placeholder="${label}"]`);
  if (input === null) throw new Error("no confirmation field");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setValue?.call(input, label);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button(dialog, "Roll back").click());
  await settle();
}

describe("ManagerVersionsSection", () => {
  it("keeps one status region with the list, empty until there is news", () => {
    show();
    expect(status().textContent).toBe("");
  });

  it("says the rollback that reloaded the page worked, as a success", () => {
    window.sessionStorage.setItem(
      "appflare:rolled-back-to",
      JSON.stringify({ version: "0.3.0", jobId: "01ROLLBACK" }),
    );
    show("0.3.0");
    expect(status().textContent).toContain("Appflare rolled back to 0.3.0");
    expect(status().querySelector('a[href="/jobs/01ROLLBACK"]')).not.toBeNull();
  });

  it("announces the switch in the region that was already there", async () => {
    show();
    const region = status();
    await rollBackTo("0.3.0");
    expect(calls.rollBackManager).toHaveBeenCalledWith({ data: { versionId: "v-old" } });
    expect(region.isConnected).toBe(true);
    expect(region.textContent).toContain("Switching to Appflare 0.3.0");
  });

  it("offers Reload as a banner button when the older version does not answer", async () => {
    show();
    calls.stalled = true;
    await rollBackTo("0.3.0");
    expect(status().textContent).toContain("Rolled back to 0.3.0");
    expect(button(status(), "Reload")).toBeDefined();
    expect(container.querySelector('a[href="#"]')).toBeNull();
  });
});
