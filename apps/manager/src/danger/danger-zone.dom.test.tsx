import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The danger zone on Your account, with the account review standing in:
 * nothing here rotates or removes anything.
 */
const calls = vi.hoisted(() => ({ getRemovalReview: vi.fn() }));
vi.mock("./danger.functions", () => ({ getRemovalReview: calls.getRemovalReview }));

const { DangerZone } = await import("./danger-zone");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  calls.getRemovalReview.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

async function openRemove() {
  act(() =>
    root.render(
      <TooltipProvider>
        <DangerZone state={{ authSecretRotatedAt: null }} />
      </TooltipProvider>,
    ),
  );
  await act(async () => button("Remove Appflare").click());
  await settle();
  const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  if (dialog === null) throw new Error("no dialog");
  return dialog;
}

describe("DangerZone", () => {
  it("announces why the account could not be read", async () => {
    calls.getRemovalReview.mockRejectedValue(new Error("The token lacks Workers Scripts: Edit."));
    const dialog = await openRemove();
    const alert = dialog.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Appflare could not read what it would remove");
    expect(alert?.textContent).toContain("The token lacks Workers Scripts: Edit.");
  });

  it("announces the running jobs that keep Appflare from being removed", async () => {
    calls.getRemovalReview.mockResolvedValue({
      targets: {
        accountName: "Acme",
        gateway: null,
        sandbox: { worker: "none", bucket: false, appTokens: 0, containerApps: [] },
        manager: { workerName: "appflare", kvId: null, d1Id: null },
        accessAppIds: [],
        appAccessInstalls: [],
      },
      stays: { apps: [], customDomains: 0, protectedApps: [], usersPolicy: false },
      activeJobs: [{ id: "j1", kind: "update" }],
      externalDomains: [{ installId: "i1", label: "Cut", hostname: "go.example.com" }],
    });
    const dialog = await openRemove();
    const alerts = [...dialog.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
    expect(alerts.some((t) => t?.includes("A job is running"))).toBe(true);
    expect(alerts.some((t) => t?.includes("Remove these external domains first"))).toBe(true);
  });
});
