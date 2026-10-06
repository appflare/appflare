import { TooltipProvider } from "@cloudflare/kumo";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedToken } from "./cloudflare-token-form";

/**
 * Your account's Cloudflare connection, with the token form standing in: a
 * button that reports a saved token, so nothing here talks to Cloudflare.
 */
vi.mock("./cloudflare-token-form", () => ({
  CloudflareTokenForm: ({ onSaved }: { onSaved: (saved: SavedToken) => Promise<void> }) => (
    <button
      type="button"
      onClick={() =>
        void onSaved({ accountId: "a1", workerName: "appflare", replacedAuthorization: false })
      }
    >
      Save the new token
    </button>
  ),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: async () => {}, navigate: async () => {} }),
}));

const { CloudflareTokenCard } = await import("./cloudflare-token-card");

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
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 50)));

function button(within: HTMLElement, label: string): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (found === undefined) throw new Error(`no button "${label}"`);
  return found;
}

describe("CloudflareTokenCard", () => {
  it("announces the rotated token in a status that was there with the form", async () => {
    act(() =>
      root.render(
        <TooltipProvider>
          <CloudflareTokenCard
            status={{
              configured: true,
              accountId: "a1",
              accountName: "Acme",
              workerName: "appflare",
              verifiedAt: null,
              hasSecret: true,
              connection: {
                kind: "api_token",
                state: "connected",
                problem: null,
                problemAt: null,
                connectedSince: null,
                ready: true,
                oauth: null,
              },
            }}
            canRotate
          />
        </TooltipProvider>,
      ),
    );
    await act(async () => button(container, "Rotate token").click());
    await settle();
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog === null) throw new Error("no dialog");
    const region = dialog.querySelector('[role="status"]');
    expect(region?.textContent).toBe("");

    await act(async () => button(dialog, "Save the new token").click());
    await settle();
    expect(region?.isConnected).toBe(true);
    expect(region?.textContent).toContain("Token rotated");
    expect(region?.textContent).toContain('The new token is stored on "appflare".');
    expect(dialog.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});
