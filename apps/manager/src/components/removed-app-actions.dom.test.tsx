import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A removed app's actions, with nothing behind them: nothing here deletes anything. */
vi.mock("../installs/removed-apps.functions", () => ({
  deleteRetainedData: vi.fn(),
  forgetRemovedApp: vi.fn(),
}));
vi.mock("./job-started", () => ({ useJobStarted: () => async () => {} }));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

const { DeleteRetainedDialog, ForgetDialog } = await import("./removed-app-actions");

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

const app = (label: string) => ({
  id: label.toLowerCase(),
  label,
  workerName: `${label.toLowerCase()}-1`,
  retained: [{ id: "r1", kind: "d1", name: `${label.toLowerCase()}-db` }],
});

describe("removed app actions", () => {
  it("name the app each row's buttons act on, starting with what they show", () => {
    act(() =>
      root.render(
        <TooltipProvider>
          {[app("Cut"), app("Notes")].map((a) => (
            <div key={a.id}>
              <DeleteRetainedDialog app={a} />
              <ForgetDialog app={a} />
            </div>
          ))}
        </TooltipProvider>,
      ),
    );
    const names = [...container.querySelectorAll("button")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toEqual([
      "Delete retained data of Cut",
      "Forget Cut",
      "Delete retained data of Notes",
      "Forget Notes",
    ]);
  });
});
